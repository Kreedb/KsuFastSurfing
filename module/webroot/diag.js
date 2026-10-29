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

/* ---------- gateway / L3 ---------- */
async function collectNet() {
  const net = { gateway: '', loss: null, rtt: null, dns: 'unknown' };

  /* No awk here either: parsing 'default via X dev Y' is two tokens, and the
     page is where parsing belongs now. */
  const r = await sh('ip route 2>/dev/null');
  const def = ((r.out || '').split('\n').find(l => /^default/.test(l)) || '').trim();
  const via = def.match(/^default\s+via\s+(\S+)/);
  net.gateway = via ? via[1] : '';

  if (net.gateway) {
    const p = await sh('ping -c 5 -i 0.2 -W 1 ' + net.gateway + ' 2>/dev/null');
    const pl = (p.out || '').match(/(\d+)% packet loss/);
    if (pl) net.loss = +pl[1];
    const rt = (p.out || '').match(/rtt [^=]*= ([\d.]+)\/([\d.]+)/);
    if (rt) net.rtt = +rt[2];                       /* avg, not max */
  }

  /* One lookup tests DNS and reachability together. */
  const d = await sh('ping -c 1 -W 2 github.com >/dev/null 2>&1; echo $?');
  net.dns = ((d.out || '').trim().split('\n').pop() === '0') ? 'ok' : 'fail';
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

function quality(r) {
  if (r >= -50) return 'excellent';
  if (r >= -60) return 'good';
  if (r >= -70) return 'fair';
  return 'weak';
}

/* ---------- assemble the whole picture ---------- */
function analyse(rows, link, net) {
  const n = rows.length;
  const count = (f) => rows.filter(f).length;
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

  const best = aps[0] || {};

  /* Congestion counts raw BSSIDs, not SSIDs: one SSID on five radios still
     occupies the channel five times. */
  const cong = {};
  rows.forEach(a => { cong[a.ch] = (cong[a.ch] || 0) + 1; });
  const congestion = Object.keys(cong).map(c => ({ ch: +c, count: cong[c] }))
    .sort((a, b) => b.count - a.count || a.ch - b.ch);

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
  const netVerdict = net.loss === null ? 'nogw' : (net.loss === 0 ? 'ok' : 'lossy');

  return {
    /* The link/L3 numbers are carried at the top level because the renderer
       reads them as scalars. Dropping them here made the network card silently
       show "未获取" even when the gateway ping had succeeded. */
    gateway: net.gateway, loss: net.loss, rtt: net.rtt,
    summary: {
      total: n,
      n24: count(a => a.band === '2.4'), n5, n6: count(a => a.band === '6'),
      ndfs: count(a => a.dfs),
      nunii2a: count(a => a.unii === 'UNII-2A'),
      nunii2c: count(a => a.unii === 'UNII-2C'),
      nunii3: count(a => a.unii === 'UNII-3'),
      nwpa3: count(a => a.wpa3), nopen: count(a => a.open)
    },
    best: { rssi: best.rssi || 0, ssid: best.ssid || '', freq: best.freq || 0 },
    link: link || { ssid: '', freq: 0, ch: 0, rssi: 0, mbps: 0, std: '' },
    ageMax: rows.reduce((m, a) => Math.max(m, a.age || 0), 0),
    dfsCh, aps, groups, congestion, roam, scores,
    verdict: {
      dfs: dfsVerdict, net: netVerdict,
      dns: net.dns, best_ch: scores.length ? scores[0].ch : null
    }
  };
}

/* Collect everything. Each source independent so one failure is reported
   rather than blanking the page. */
async function measure() {
  const scan = await sh('cmd wifi list-scan-results 2>&1');
  const link = await sh('cmd wifi status 2>&1');
  const net = await collectNet();

  const rows = parseScan(scan.out);
  if (!rows.length) {
    return { error: 'empty-scan', raw: scan.out, err: scan.err };
  }
  return analyse(rows, parseLink(link.out), net);
}