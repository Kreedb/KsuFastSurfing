/* ===================================================================
   Data acquisition and analysis, entirely in the page.

   The WebUI bridge (`ksu.exec`) runs commands as root, so the page can
   read the same interfaces the shell script used to: `cmd wifi
   list-scan-results`, `cmd wifi status`, `dumpsys wifi`, `ip route`,
   `ping`. Parsing them in JS means:

     - no awk on the device to go wrong (Android's awk has no strftime,
       no math functions, and differs from gawk in gsub escapes)
     - no temp files, no report.json to keep in sync
     - the version on screen is always the bytes just measured

   `wifidiag.sh` stays for command-line use, but nothing in this page
   depends on it.
   =================================================================== */

/* One shell call per data source. Deliberately separate: a failure in one
   must not blank the rest, and the UI can report which source failed. */
async function sh(cmd) {
  const r = await exec(cmd, { cwd: '/' });
  return { out: (r.stdout || ''), err: (r.stderr || ''), code: r.errno };
}

/* Text whose bytes must survive intact.

   SSIDs are arbitrary bytes, not a charset we get to assume: a Chinese or emoji
   name goes through the WebUI bridge, the shell and the page, and any hop that
   decodes as Latin-1 turns everything past the first multibyte character into
   mojibake. Base64 is ASCII-only, so the bytes arrive exactly as the kernel
   handed them to `cmd wifi` and are decoded once, here. */
function b64bytes(s) {
  const bin = atob(String(s || '').replace(/[\s=]+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  try { return new TextDecoder('utf-8', { fatal: false }).decode(out); }
  catch (e) { return bin; }
}

async function shText(cmd) {
  const r = await sh('(' + cmd + ') 2>&1 | base64');
  const decoded = b64bytes(r.out);
  if (decoded) return decoded;
  /* No base64 on this image: fall back to the raw stream rather than showing
     an empty page. Same data, just no byte guarantee. */
  return r.out;
}

/* ---------- MAC recovery ----------
   Android 12+ redacts the middle two octets of every BSSID returned through the
   framework (`68:19:**:**:37:c3`) unless the caller holds location access. The
   supplicant keeps the real addresses, and collect.sh reads them - but only
   when a redaction is actually present, and with a 1.4 s bounded backoff
   instead of the two fixed 2 s sleeps this page used to pay on every refresh.
   Its table is tab-separated: bssid / frequency / signal / flags / ssid. */
function parseWpa(txt) {
  const out = [];
  (txt || '').split('\n').forEach(line => {
    if (!line || /^bssid/i.test(line.trim())) return;
    const p = line.split('\t');
    if (p.length < 3) return;
    const bssid = p[0].trim(), freq = +p[1], rssi = +p[2];
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(bssid)) return;
    const ssid = (p[4] || '').replace(/\s+$/, '');
    out.push({ bssid, freq, rssi, ssid });
  });
  return out;
}

/* Fill a masked BSSID (and a truncated or garbled name) from the supplicant
   table.

   Pairing is by frequency and signal, choosing the nearest unmatched candidate.
   Frequency alone is not enough - two radios on one channel under different
   names are common - and the name is exactly what may be broken here, so it
   cannot be the matching key. */
function fillMacs(rows, real) {
  if (!real.length) return 0;
  const used = new Set();
  let fixed = 0;

  /* A redacted BSSID keeps its first two and last two octets: 68:19:**:**:37:c3
     can only be 68:19:xx:xx:37:c3. That pin is essentially unique, so matching
     on it alone is safe. RSSI proximity is only the tie-break when two radios
     on one band share a vendor prefix. */
  const fits = (masked, full) => {
    const m = masked.split(':'), f = full.split(':');
    if (m.length !== 6 || f.length !== 6) return false;
    return m.every((x, i) => /\*/.test(x) || x.toLowerCase() === f[i].toLowerCase());
  };

  rows.forEach(a => {
    if (!/\*/.test(a.bssid)) return;
    let best = null, bestd = 1e9;
    real.forEach((r, i) => {
      if (used.has(i)) return;
      if (r.freq !== a.freq) return;
      if (!fits(a.bssid, r.bssid)) return;
      const d = Math.abs(r.rssi - a.rssi);
      if (d < bestd) { bestd = d; best = i; }
    });
    /* No address survived the prefix/suffix pin: fall back to the nearest radio
       on the same channel. 6 dB of slack, because the framework reports link
       RSSI while the supplicant averages its own level. */
    if (best === null) {
      real.forEach((r, i) => {
        if (used.has(i) || r.freq !== a.freq) return;
        const d = Math.abs(r.rssi - a.rssi);
        if (d < bestd) { bestd = d; best = i; }
      });
      if (best !== null && bestd > 6) best = null;
    }
    if (best === null) return;
    used.add(best);
    const r = real[best];
    a.bssid = r.bssid;
    fixed++;
    /* The framework pads and truncates the name column, and a cut can land
       inside a multibyte character - which is exactly how a Chinese name ends
       up as its first character plus a replacement glyph. The supplicant prints
       the raw bytes, so prefer its copy whenever the two disagree. */
    if (r.ssid && r.ssid !== a.ssid) a.ssid = r.ssid;
  });
  return fixed;
}

/* ---------- scan cache ----------
   Stock format, space aligned:
     BSSID  Frequency  RSSI(link:rssi0/rssi1)  Age(sec)  SSID  Flags
   SSID is the free-text field, so it is taken as everything between the age
   column and the first '[' of the Flags column - never by splitting on a
   delimiter, because an SSID can contain anything. */
function parseScan(txt) {
  const rows = [];
  const lines = (txt || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    if (/^\s*BSSID\s+Frequency/i.test(raw)) continue;      // header

    const m = raw.match(/^\s*(\S+)\s+(\d+)\s+(-?\d+)(?:\([^)]*\))?\s+([\d.]+)\s+(.*)$/);
    if (!m) continue;
    const bssid = m[1], freq = +m[2], rssi = +m[3], age = parseFloat(m[4]);
    let rest = m[5];

    /* Flags begin at the first '['. Everything before it is the SSID. */
    const bracket = rest.indexOf('[');
    let ssid = bracket >= 0 ? rest.slice(0, bracket).trim() : rest.trim();
    const flags = bracket >= 0 ? rest.slice(bracket) : '';
    if (ssid === 'null') ssid = '';

    if (freq < 2400) continue;
    const band = freq <= 2500 ? '2.4' : (freq <= 5895 ? '5' : '6');
    const ch = chanOf(freq);

    /* Security as shown in the AP list. Two radios on one SSID can differ
       here, which is exactly when it matters. */
    const sec = /SAE/.test(flags) ? 'WPA3' :
                /RSN/.test(flags) ? 'WPA2' :
                /WPA/.test(flags) ? 'WPA' : '开放';

    rows.push({
      bssid, freq, rssi, age, ssid, flags, band, ch, sec,
      dfs: isDfs(ch) ? 1 : 0,
      unii: uniiOf(ch),
      wpa3: /SAE/.test(flags) ? 1 : 0,
      open: !/RSN|WPA/.test(flags) ? 1 : 0
    });
  }
  return rows;
}

/* Channel number from frequency. 2484 is ch14; the 5GHz grid is 5MHz from
   5000, the 6GHz grid 5MHz from 5950. */
function chanOf(f) {
  if (f <= 2500) return f === 2484 ? 14 : Math.floor((f - 2407) / 5);
  if (f <= 5895) return Math.floor((f - 5000) / 5);
  return Math.floor((f - 5950) / 5);
}

/* UNII-2A is 52-64, UNII-2C is 100-144 - by channel number, because 5725MHz
   is exactly ch149 (UNII-3) and a frequency test misclassifies it. */
function isDfs(c) { return (c >= 52 && c <= 64) || (c >= 100 && c <= 144); }
function uniiOf(c) {
  if (c < 36) return '-';
  if (c <= 64) return 'UNII-2A';
  if (c <= 144) return 'UNII-2C';
  return 'UNII-3';
}

/* ---------- connected link ----------
   `cmd wifi status` prints one WifiInfo line. Fields are comma separated but
   SSID is quoted, so a comma inside an SSID would break a naive split. */
function parseLink(txt) {
  const line = ((txt || '').split('\n').find(l => /WifiInfo:/.test(l)) || '');
  if (!line) return null;

  const grab = (re) => { const m = line.match(re); return m ? m[1] : ''; };
  /* [^"]* stops at the closing quote even when the SSID contains commas. */
  const ssid = grab(/SSID:\s*"([^"]*)"/);
  const freq = +grab(/Frequency:\s*(\d+)/) || 0;
  const rssiRaw = grab(/RSSI:\s*(-?\d+)/);
  const rssi = rssiRaw === '' ? 0 : +rssiRaw;
  const mbps = +grab(/Link speed:\s*(\d+)/) || 0;
  const std = grab(/Wi-Fi standard:\s*(\S+?)(?:,|$)/);

  return { ssid, freq, ch: freq ? chanOf(freq) : 0, rssi, mbps, std };
}

/* ---------- sectioned collection ----------
   collect.sh prints `##name` before each block. Splitting on that marker keeps
   the per-command boundaries without a delimiter protocol for the payload:
   SSIDs may contain '##', newlines are impossible, and each block is handed to
   the parser that understands it. */
function sections(txt) {
  const map = {};
  let cur = '';
  (txt || '').split('\n').forEach(line => {
    const m = line.match(/^##([a-z]+)\s*$/);
    if (m) { cur = m[1]; map[cur] = []; return; }
    if (cur) map[cur].push(line);
  });
  const out = {};
  for (const k in map) out[k] = map[k].join('\n').trim();
  return out;
}

/* ---------- gateway / L3 ---------- */
/* Pure: takes the already-collected route/ping/dns blocks, so a failed ping
   cannot blank the gateway and a missing gateway cannot look like 0% loss. */
function parseNet(route, pingTxt, dnsTxt) {
  const net = { gateway: '', loss: null, rtt: null, dns: 'unknown' };

  const def = ((route || '').split('\n').find(l => /^default/.test(l)) || '').trim();
  const via = def.match(/^default\s+via\s+(\S+)/);
  net.gateway = via ? via[1] : '';

  const pl = (pingTxt || '').match(/(\d+)% packet loss/);
  if (pl) net.loss = +pl[1];
  const rt = (pingTxt || '').match(/rtt [^=]*= ([\d.]+)\/([\d.]+)/);
  if (rt) net.rtt = +rt[2];                         /* avg, not max */

  const rc = ((dnsTxt || '').match(/^rc=(\d+)$/m) || [])[1];
  net.dns = rc === '0' ? 'ok' : (rc ? 'fail' : 'unknown');
  return net;
}

/* ---------- interference scoring ----------
   Counting APs per channel lies: five APs at -80 are harmless, one at -25 is
   not. Sum linear power instead, co-channel full weight and +/-4 channels
   (the 20MHz mask overlap) a quarter. */
function scoreChannels(rows) {
  const load = {}, co = {}, adj = {}, seen = {};
  const add = (c) => { if (!(c in load)) { load[c] = 0; co[c] = 0; adj[c] = 0; } };

  rows.forEach(a => {
    const p = Math.pow(10, a.rssi / 10);
    add(a.ch); co[a.ch]++; load[a.ch] += p; seen[a.ch] = 1;
    for (let d = -4; d <= 4; d++) {
      if (d === 0) continue;
      const k = a.ch + d;
      if (k < 1) continue;
      add(k); adj[k]++; load[k] += p / 4;
    }
  });

  /* Candidates must be channels a radio can actually be set to: the standard
     grids only, plus any that were really observed.

     Not Object.keys(load): that map also holds the +/-4 spill from the
     adjacency weighting, so seeding from it proposes ch45, ch46, ch50, ch146...
     Those are not channels - 5GHz channels are 4 apart - and on real data the
     tool recommended ch49. */
  const cand = new Set();
  Object.keys(seen).forEach(c => cand.add(+c));
  if (rows.some(a => a.band === '2.4')) for (let c = 1; c <= 13; c++) cand.add(c);
  if (rows.some(a => a.band === '5')) {
    for (let c = 36; c <= 64; c += 4) cand.add(c);
    for (let c = 100; c <= 144; c += 4) cand.add(c);
    for (let c = 149; c <= 165; c += 4) cand.add(c);
  }

  const out = [...cand].map(c => ({
    ch: c, load: load[c] || 0, co: co[c] || 0, adj: adj[c] || 0,
    dfs: isDfs(c) ? 1 : 0, seen: seen[c] ? 1 : 0
  }));

  /* Order: 5GHz before 2.4GHz, then non-DFS before DFS, then least
     interference, then observed channels, then channel number.

     Band first: 2.4GHz has three usable channels shared with every neighbour
     in range, so a "clean" ch1 is a worse pick than a busy 5GHz channel.
     DFS next: an empty DFS channel scores zero but is the worst advice we can
     give - passive scan only, and a radar hit vacates it. Ranking on load
     alone answered "ch 108" (an empty DFS channel) on real data. */
  out.sort((a, b) => {
    if ((a.ch > 34) !== (b.ch > 34)) return a.ch > 34 ? -1 : 1;
    if (a.dfs !== b.dfs) return a.dfs - b.dfs;
    if (a.load !== b.load) return a.load - b.load;
    if (a.seen !== b.seen) return b.seen - a.seen;
    return a.ch - b.ch;
  });
  return out;
}

/* One scale for both the label and the colour. There used to be two: a
   quality() returning English words at -50/-60/-70, and a qcls() mapping to CSS
   classes at -50/-65. The same reading could be "good" and "warn" at once, and
   the English word sat in the middle of a Chinese row. */
function rssiBand(r) {
  if (r >= -50) return { label: '很强', cls: 'ok' };
  if (r >= -60) return { label: '良好', cls: 'ok' };
  if (r >= -70) return { label: '一般', cls: 'warn' };
  return { label: '弱', cls: 'bad' };
}

/* ---------- assemble the whole picture ---------- */
function analyse(rows, link, net) {
  const n = rows.length;
  const count = (f) => rows.filter(f).length;
  const ages = rows.map(a => a.age || 0).sort((a, b) => a - b);
  const dfsCh = [...new Set(rows.filter(a => a.dfs).map(a => a.ch))].sort((x, y) => x - y);

  /* Strongest BSSID per SSID for the AP table (hidden ones keep a slot). */
  const bySsid = new Map();
  rows.forEach(a => {
    const key = a.ssid || '\u0000hidden';
    const prev = bySsid.get(key);
    if (!prev || a.rssi > prev.rssi) bySsid.set(key, a);
  });
  const aps = [...bySsid.values()].sort((a, b) => b.rssi - a.rssi);

  /* Every BSSID, grouped by SSID. One network name is often served by several
     radios (mesh, repeaters, a router running 2.4 and 5GHz under one name), and
     seeing them together is the whole point of the AP page. Groups are ordered
     by their strongest member; members by signal, then channel, so the list
     does not reshuffle between scans on equal RSSI. */
  const byName = new Map();
  rows.forEach(a => {
    const key = a.ssid || '\u0000hidden';
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(a);
  });
  const groups = [...byName.entries()].map(([key, list]) => {
    list.sort((a, b) => b.rssi - a.rssi || a.ch - b.ch);
    return {
      ssid: key === '\u0000hidden' ? '' : key,
      count: list.length,
      best: list[0].rssi,
      chans: [...new Set(list.map(a => a.ch))].sort((x, y) => x - y),
      bssids: list
    };
  }).sort((a, b) => b.best - a.best || (a.ssid < b.ssid ? -1 : 1));

  /* Multi-BSSID SSIDs mean mesh / roaming, which changes the advice. */
  const bssPerSsid = {};
  rows.forEach(a => {
    if (!a.ssid) return;
    bssPerSsid[a.ssid] = (bssPerSsid[a.ssid] || 0) + 1;
  });
  const roam = Object.keys(bssPerSsid).filter(s => bssPerSsid[s] > 1)
    .map(s => ({ ssid: s, bssids: bssPerSsid[s] }));

  const scores = scoreChannels(rows);
  const n5 = count(a => a.band === '5');

  const dfsVerdict = (n5 > 0 && dfsCh.length > 0) ? 'ok' : (n5 > 0 ? 'none' : 'nodata');

  return {
    /* The link/L3 numbers are carried at the top level because the renderer
       reads them as scalars. Dropping them here made the network card silently
       show "未获取" even when the gateway ping had succeeded. */
    gateway: net.gateway, loss: net.loss, rtt: net.rtt,
    summary: {
      total: n,
      n24: count(a => a.band === '2.4'), n5,
      ndfs: count(a => a.dfs),
      nunii2a: count(a => a.unii === 'UNII-2A'),
      nunii2c: count(a => a.unii === 'UNII-2C'),
      nunii3: count(a => a.unii === 'UNII-3')
    },
    link: link || { ssid: '', freq: 0, ch: 0, rssi: 0, mbps: 0, std: '' },
    /* Two ages: the median describes the cache as a whole, the minimum proves a
       scan actually landed. The maximum was removed - it is set by whichever
       neighbour the radio stopped hearing five minutes ago and never moves. */
    ageMin: ages[0] || 0,
    ageMed: ages.length ? ages[Math.floor(ages.length / 2)] : 0,
    dfsCh, aps, groups, roam, scores,
    verdict: {
      dfs: dfsVerdict, dns: net.dns, best_ch: scores.length ? scores[0].ch : null
    }
  };
}

/* Collect everything. Each source independent so one failure is reported
   rather than blanking the page. */
async function measure() {
  /* One exec for the whole picture. `shText` keeps the bytes intact: the bridge
     decodes as Latin-1, so a Chinese SSID would otherwise arrive as mojibake. */
  const raw = await shText('sh ' + MODDIR + '/collect.sh');
  const s = sections(raw);

  const rows = parseScan(s.scan || '');
  if (!rows.length) return { error: 'empty-scan', raw: s.scan || '' };

  /* collect.sh already decided whether a supplicant lookup was worth doing
     (only when a BSSID is redacted) and bounded the wait. An empty section is
     the normal case on a ROM without wpa_cli; the masked value is kept. */
  fillMacs(rows, parseWpa(s.mac || ''));

  return analyse(rows, parseLink(s.link || ''), parseNet(s.route, s.ping, s.dns));
}

/* Scan only: what the rescan loop polls while waiting for fresh results. */
async function measureScan() {
  const raw = await shText('sh ' + MODDIR + '/collect.sh scan');
  return parseScan(sections(raw).scan || '');
}
