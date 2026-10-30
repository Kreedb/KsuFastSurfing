/* ===================================================================
   Data layer, entirely in the page.

   There is no collector script any more. Every number on screen comes
   from an Android command this file runs through the WebUI bridge, and
   every one of those calls is printed in the console tab. That means:

     - one place decides what is measured (this file), not a shell script
       plus a parser that can drift apart
     - no temp files, no report.json, no `##section` protocol to keep in
       sync between a script's printf and a regex here
     - the version on screen is always the bytes just measured

   The only shell left in the module runs before the WebView exists:
   post-fs-data.sh mounts the hosts file this page generated, customize.sh
   sets install-time modes, uninstall.sh undoes the mounts.
   =================================================================== */

/* ---------- bridge ---------- */

/* One shell call per source. Deliberately separate: a failure in one must not
   blank the rest, and the console can show which one failed. */
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

/* Run a command and return its text. stderr is folded into stdout because a
   failing Android command puts the useful sentence there (`cmd: not found`,
   `Permission denied`), and the console shows the raw command anyway. */
async function shRaw(cmd) {
  const r = await sh('(' + cmd + ') 2>&1 | base64');
  let decoded = '';
  try { decoded = b64bytes(r.out); } catch (e) { decoded = ''; }
  if (decoded) return decoded;
  /* No base64 on this image: fall back to the raw stream rather than showing
     an empty page. Same data, just no byte guarantee. */
  return r.out;
}

const delay = ms => new Promise(r => setTimeout(r, ms));

const SHQ = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

function modDir() {
  return (typeof MODDIR === 'string' && MODDIR) ? MODDIR : '/data/adb/modules/KsuFastSurfing';
}

function toB64(text) {
  const bytes = new TextEncoder().encode(String(text));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/* Read/write a module file straight from the page. The editor is the only
   writer of user-hosts, and these two functions are the only transport. */
async function readFile(path) {
  const r = await sh('base64 -w0 ' + SHQ(path) + ' 2>/dev/null');
  const b = (r.out || '').trim();
  if (!b) return '';
  try { return b64bytes(b); } catch (e) { return ''; }
}

/* Same bridge, different decoding: some responses are not UTF-8 at all (the
   GBK page used for the outbound check), so the caller names the charset. */
async function shRawAs(cmd, enc) {
  const r = await sh('(' + cmd + ') 2>&1 | base64 -w0');
  const b = (r.out || '').trim();
  if (!b) return '';
  const bin = atob(b.replace(/[\s=]+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  try { return new TextDecoder(enc || 'utf-8', { fatal: false }).decode(bytes); }
  catch (e) { return b64bytes(b); }
}

async function writeFile(path, text) {
  const body = String(text == null ? '' : text);
  const r = await sh('printf %s ' + toB64(body) + ' | base64 -d > ' + SHQ(path) +
                     ' && echo "write=ok" || echo "write=FAIL"');
  return { ok: /write=ok/.test(r.out), bytes: body.length };
}

function nowStamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
         p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
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
  /* ch36-48 is UNII-1, not UNII-2A. Lumping them together made the
     "UNII-2A (52-64)" counter include every low 5GHz AP. */
  if (c <= 48) return 'UNII-1';
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
function gatewayOf(route) {
  const def = ((route || '').split('\n').find(l => /^default/.test(l)) || '').trim();
  const m = def.match(/^default\s+via\s+(\S+)/);
  return m ? m[1] : '';
}
function ifaceOf(route) {
  const def = ((route || '').split('\n').find(l => /^default/.test(l)) || '').trim();
  const m = def.match(/\bdev\s+(\S+)/);
  return m ? m[1] : '';
}

/* Android keeps the default route in a per-network table, so plain `ip route`
   often prints only the on-link prefix - no `default` line at all. The kernel
   still knows which gateway it would use, so `ip route get` is spliced in as a
   synthetic default line. Without this the gateway card stayed empty and the
   gateway ping was skipped on every device with a per-network table. */
function routeText(base, get) {
  if (/^default\b/m.test(base || '')) return base;
  const via = ((get || '').match(/\bvia\s+(\d+\.\d+\.\d+\.\d+)/) || [])[1];
  const dev = ((get || '').match(/\bdev\s+(\S+)/) || [])[1];
  if (!via && !dev) return base || '';
  return (base || '') + '\ndefault' + (via ? ' via ' + via : '') +
         (dev ? ' dev ' + dev : '') + '\n';
}

/* Pure: takes the already-collected route/ping/dns blocks, so a failed ping
   cannot blank the gateway and a missing gateway cannot look like 0% loss. */
function parseNet(route, pingTxt, addrTxt, echo) {
  const net = {
    gateway: '', loss: null, rtt: null, dns: 'unknown',
    addr: '', prefix: null, mask: '', iface: '', routes: [], clientIp: '', dnsIp: ''
  };

  net.gateway = gatewayOf(route);
  net.iface = ifaceOf(route);
  net.routes = parseRoutes(route);

  const a = parseAddr(addrTxt, net.iface);
  net.addr = a.addr; net.prefix = a.prefix; net.mask = a.mask;
  if (!net.iface) net.iface = a.iface;

  const pl = (pingTxt || '').match(/(\d+)% packet loss/);
  if (pl) net.loss = +pl[1];
  const rt = (pingTxt || '').match(/rtt [^=]*= ([\d.]+)\/([\d.]+)/);
  if (rt) net.rtt = +rt[2];                         /* avg, not max */

  /* The echo page replaces the old `ping github.com` probe: one HTTPS request
     answers reachability, and reports the address the internet sees plus the
     resolver it observed. A failure is 'fail', an unparsable page 'unknown'. */
  const e = echo || {};
  net.clientIp = e.client || '';
  net.dnsIp = e.dns || '';
  net.dns = e.verdict === 'ok' ? 'ok' : (e.verdict === 'bad' ? 'bad'
          : (e.verdict === 'fail' ? 'fail' : 'unknown'));
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
    addr: net.addr, prefix: net.prefix, mask: net.mask, iface: net.iface,
    routes: net.routes, clientIp: net.clientIp, dnsIp: net.dnsIp,
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

/* ---------- hosts merge (pure) ----------
   The page is the only writer of user-hosts and of the merged file, so the
   merge rules live here instead of in awk. `user-hosts` is the single input:
   comments and blank lines are dropped, the first column must be an address,
   and the first line for a hostname wins. */
const isIPv4 = s => /^([0-9]{1,3}\.){3}[0-9]{1,3}$/.test(s);
const isIPv6 = s => /^[0-9A-Fa-f:]+$/.test(s);

function mergeHosts(userText, when) {
  const lines = [
    '# Generated ' + (when || nowStamp()) + ' by KsuFastSurfing',
    '# source: user-hosts (every entry was chosen by the user)',
    '',
    '127.0.0.1\tlocalhost',
    '::1\tlocalhost ip6-localhost ip6-loopback'
  ];
  let header = false;
  const seen = new Set();

  (userText || '').split(/\r?\n/).forEach(line => {
    if (/^[ \t]*#/.test(line) || !line.trim()) return;
    const p = line.trim().split(/\s+/);
    const ip = p[0];
    if (!isIPv4(ip) && !isIPv6(ip)) return;
    for (let i = 1; i < p.length; i++) {
      const name = p[i];
      if (name.charAt(0) === '#') break;
      if (seen.has(name)) continue;
      seen.add(name);
      if (!header) { lines.push('', '# --- user entries ---'); header = true; }
      lines.push(ip + '\t' + name);
    }
  });
  return lines.join('\n') + '\n';
}

/* What is actually in effect: everything in the merged file except loopback
   and comments. A duplicate line in the editor is therefore visible as
   "3 lines in, 2 in effect" instead of silently disappearing. */
function countHosts(mergedText) {
  return (mergedText || '').split('\n').filter(l => {
    if (/^[ \t]*(#|$)/.test(l)) return false;
    const ip = l.trim().split(/\s+/)[0];
    return ip !== '127.0.0.1' && ip !== '::1';
  }).length;
}

/* Replace one key in config-style text, keeping every other line. */
function setKV(text, key, value) {
  const lines = String(text || '').split(/\r?\n/);
  let hit = false;
  const out = lines.map(l => {
    if (l.startsWith(key + '=')) { hit = true; return key + '=' + value; }
    return l;
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  if (!hit) out.push(key + '=' + value);
  return out.join('\n') + '\n';
}

/* ---------- country code ----------
   OEMs word this differently ("Country code is: US", "Wifi Country Code: US",
   "COUNTRY CODE IS: US"). Trust the first two-letter token that follows a
   "country code" phrase; fall back to the last standalone two-letter token. */
const CC_STOP = new Set(['IS', 'IN', 'OF', 'TO', 'AT', 'BY', 'ON', 'OR', 'NO', 'SO',
                         'UP', 'AS', 'BE', 'DO', 'GO', 'IF', 'IT', 'ME', 'MY', 'WE',
                         'HE', 'OK', 'ID', 'IP', 'UI', 'OS']);

function parseCC(txt) {
  const s = String(txt || '');
  /* `is` is part of the sentence in several OEM strings ("COUNTRY CODE IS: DE"),
     so it is consumed as grammar, not read as Iceland. */
  const m = s.match(/country\s*code(?:\s+is)?\s*[:=]?\s*([A-Za-z]{2})\b/i);
  if (m) return m[1].toUpperCase();
  const all = (s.toUpperCase().match(/\b[A-Z]{2}\b/g) || [])
    .filter(t => !CC_STOP.has(t));
  return all.length ? all[all.length - 1] : '';
}

/* `cmd wifi get-country-code` is the API; `cmd wifi status` never prints it.
   dumpsys is the fallback, and its wording differs between OEMs. */
async function countryCodeNow() {
  let cc = parseCC(await shRaw('cmd wifi get-country-code'));
  if (cc) return cc;
  const d = await shRaw("dumpsys wifi 2>/dev/null | sed -n 's/^Current Country Code: *//p' | head -1");
  return parseCC(d);
}

/* ---------- collection ----------
   Every call below is a plain Android command; the console prints each one. */

async function collectScanText() {
  return shRaw('cmd wifi list-scan-results');
}

/* One pass over the device. The three sources are independent and run in
   parallel: a failed ping must not blank the gateway, and an unreachable DNS
   must not hold back the scan table. */
async function measure() {
  const scanTxt = await collectScanText();
  const rows = parseScan(scanTxt);
  if (!rows.length) return { error: 'empty-scan', raw: scanTxt };

  const linkTxt = await shRaw('cmd wifi status');
  let routeTxt = await shRaw('ip route');
  if (!gatewayOf(routeTxt)) {
    routeTxt = routeText(routeTxt, await shRaw('ip route get 1.1.1.1 2>/dev/null'));
  }
  const gw = gatewayOf(routeTxt);
  const ifc = ifaceOf(routeTxt) || 'wlan0';

  const ifc2 = ifaceOf(routeTxt);
  const [pingTxt, addrTxt, echo] = await Promise.all([
    gw ? shRaw('ping -c 3 -i 0.2 -W 1 ' + SHQ(gw)) : Promise.resolve(''),
    ifc2 ? shRaw('ip addr show dev ' + SHQ(ifc2) + ' 2>/dev/null') : Promise.resolve(''),
    echoLookup(6)
  ]);

  const d = analyse(rows, parseLink(linkTxt), parseNet(routeTxt, pingTxt, addrTxt, echo));
  d.iface = ifc;          /* capacity probing needs the interface that has the route */
  return d;
}

/* ---------- outbound identity (nstool page) ----------
   A plain HTTPS GET tells three things at once that three separate commands
   cannot: whether the name resolves, whether TLS completes to a real cert, and
   which address the site sees us coming from. The page answers with client IP,
   the recursive DNS it observed, and a verdict; content-type says GBK, so the
   bytes are decoded as such instead of arriving as mojibake. */
/* The host is a wildcard: every label under it resolves and the page echoes
   back what it saw, so the subdomain is free-form. A fresh 32-character code is
   generated each time the page loads - the echo is a one-shot connectivity
   check, not a device identity, and nothing needs to be remembered between
   visits. */
const ECHO_HOST = 'nstool.laiqukankan.com';

const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/* 32 lowercase alphanumerics, from the platform CSPRNG when it exists and from
   Math.random otherwise - the value only has to be unique per page load. */
function deviceCode() {
  const n = 32;
  const out = new Array(n);
  let buf = null;
  try {
    buf = new Uint8Array(n);
    crypto.getRandomValues(buf);
  } catch (e) { buf = null; }
  for (let i = 0; i < n; i++) {
    const v = buf ? buf[i] : Math.floor(Math.random() * 256);
    out[i] = CODE_ALPHABET[v % CODE_ALPHABET.length];
  }
  return out.join('');
}

let sessionCode = '';

/* One code per page load: the URL is built once and reused, so the outbound row
   and the console line always name the same host. */
function echoUrl() {
  if (!sessionCode) sessionCode = 'only-' + deviceCode();
  return 'https://' + sessionCode + '.' + ECHO_HOST + '/';
}

/* The page has no API - it is HTML for humans. Pull the two addresses out by
   shape rather than by label, because the labels are Chinese and differ
   between deployments ("您的IP地址信息"/"IP"). */
function parseEcho(html) {
  const text = String(html || '');
  const ipOf = (re) => {
    const m = text.match(re);
    if (!m) return '';
    const ip = m[1];
    return isIPv4(ip) ? ip : '';
  };
  const client = ipOf(/(?:IP地址信息|IP\s*address)[:：]?\s*([0-9.]+)/i) ||
                 ipOf(/([0-9]{1,3}(?:\.[0-9]{1,3}){3})/);
  const dns = ipOf(/DNS地址信息[:：]?\s*([0-9.]+)/i) ||
              ipOf(/DNS\s*(?:server|address)[:：]?\s*([0-9.]+)/i);
  const verdict = /DNS设置正确|DNS\s*(?:is\s*)?correct/i.test(text) ? 'ok'
                : (/DNS设置错误|DNS\s*(?:is\s*)?(?:wrong|incorrect)/i.test(text) ? 'bad' : 'unknown');
  return { client, dns, verdict };
}

/* curl -sS with a short cap: the whole point is a bounded outbound test, and a
   hanging TLS handshake must not hold the page. `--compressed` because the
   server may gzip; `-o -` so nothing touches disk. */
async function echoLookup(timeout) {
  const t = Math.max(2, Math.min(15, timeout || 6));
  const url = echoUrl();
  const txt = await shRawAs('curl -sS --compressed -m ' + t + ' ' + SHQ(url), 'gbk');
  if (!txt) return { client: '', dns: '', verdict: 'fail', raw: '' };
  const r = parseEcho(txt);
  r.raw = txt;
  return r;
}

/* ---------- subnet mask ----------
   `ip route` does not print one, and `ip addr` does it as a prefix length. The
   dotted form is derived here so the card matches what someone would type into
   a static IP dialog. */
function prefixToMask(p) {
  const n = +p;
  if (!(n >= 0 && n <= 32)) return '';
  let v = n === 0 ? 0 : (0xFFFFFFFF << (32 - n)) >>> 0;
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
}

/* Local address + prefix for the interface that carries the default route.
   `ip addr show dev wlan0` prints `inet 192.168.1.13/24`; the prefix is the mask
   width, and the netmask is derived from it. */
function parseAddr(txt, ifc) {
  const out = { addr: '', prefix: null, mask: '', iface: ifc || '' };
  if (!txt) return out;
  const m = txt.match(/inet\s+([0-9.]+)\/(\d{1,2})/);
  if (!m) return out;
  out.addr = m[1];
  out.prefix = +m[2];
  out.mask = prefixToMask(+m[2]);
  if (!out.iface) {
    const d = txt.match(/^\d+:\s+(\S+?):/m);
    if (d) out.iface = d[1];
  }
  return out;
}

/* Route table rows, newest first is what the kernel prints. Only the fields the
   card shows are kept, and `default` stays at the top where people look. */
function parseRoutes(txt) {
  const rows = [];
  (txt || '').split('\n').forEach(line => {
    const t = line.trim();
    if (!t) return;
    const p = t.split(/\s+/);
    const dest = p[0];
    if (!dest) return;
    const row = { dest, gw: '', dev: '', src: '' };
    for (let i = 1; i < p.length; i++) {
      if (p[i] === 'via') row.gw = p[i + 1] || '';
      else if (p[i] === 'dev') row.dev = p[i + 1] || '';
      else if (p[i] === 'src') row.src = p[i + 1] || '';
    }
    rows.push(row);
  });
  return rows.sort((a, b) => (a.dest === 'default' ? -1 : 0) - (b.dest === 'default' ? -1 : 0));
}

/* ---------- DNS burst (port of dns.sh) ----------
   The shell version forks N nc processes and parses raw replies in awk. Here the
   query packet is built once in JS, written to /tmp, and fired N times with
   `nc -u -w`, each reply decoded by the same parser. Same idea, no fork storm on
   the bridge: replies come back as hex, not as binary the bridge would mangle. */

/* domain -> DNS wire-format question. Labels are length-prefixed; UTF-8 is
   fine because a label is a byte string as far as DNS is concerned. */
function dnsQuery(domain, id) {
  const bytes = [];
  const push16 = (v) => { bytes.push((v >> 8) & 255, v & 255); };
  const push32 = (v) => { push16((v >>> 16) & 0xFFFF); push16(v & 0xFFFF); };

  push16(id || 0x0001);       /* transaction id */
  push16(0x0100);             /* RD set, standard query */
  push16(1); push16(0);       /* QDCOUNT=1, ANCOUNT=0 */
  push16(0); push16(0);       /* NSCOUNT=0, ARCOUNT=0 */

  String(domain || '').split('.').forEach(label => {
    const b = new TextEncoder().encode(label);
    if (!b.length || b.length > 63) return;
    bytes.push(b.length);
    b.forEach(x => bytes.push(x));
  });
  bytes.push(0);
  push16(1);                  /* QTYPE = A */
  push16(1);                  /* QCLASS = IN */
  return new Uint8Array(bytes);
}

const hex2 = b => (b < 16 ? '0' : '') + b.toString(16);

/* Decode a hex dump of a DNS reply into its A records. Answers can be
   compressed (pointer 0xC0) and can contain CNAMEs before the A record, so
   names are skipped by walking the wire format rather than by searching. */
function dnsParseHex(hex) {
  const h = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
  const b = [];
  for (let i = 0; i + 1 < h.length; i += 2) b.push(parseInt(h.substr(i, 2), 16));
  if (b.length < 12) return [];

  const u16 = (o) => (b[o] << 8) | b[o + 1];
  const qd = u16(4), an = u16(6);
  let pos = 12;

  /* Walk a name, following pointers without looping forever. */
  const skipName = (start) => {
    let p = start, jumped = false, next = start, guard = 0;
    while (p < b.length && guard++ < 256) {
      const len = b[p];
      if (len === 0) { p++; if (!jumped) next = p; break; }
      if (len >= 192) {
        if (!jumped) next = p + 2;
        p = ((len - 192) << 8) | b[p + 1];
        jumped = true;
        continue;
      }
      p += 1 + len;
    }
    return next;
  };

  for (let i = 0; i < qd && pos < b.length; i++) { pos = skipName(pos); pos += 4; }

  const out = [];
  for (let i = 0; i < an && pos + 10 < b.length; i++) {
    pos = skipName(pos);
    if (pos + 10 > b.length) break;
    const type = u16(pos), rdlen = u16(pos + 8);
    pos += 10;
    if (type === 1 && rdlen === 4 && pos + 4 <= b.length) out.push(b[pos] + '.' + b[pos + 1] + '.' + b[pos + 2] + '.' + b[pos + 3]);
    pos += rdlen;
  }
  return out;
}

/* One query, one reply, nothing on disk: the packet is base64-decoded straight
   into nc's stdin. A temp file would be the obvious way to hand the same bytes
   to N processes, but this runs on /data whose free space is not ours to spend,
   and a leftover .bin is one more thing to clean up after a crash.

   Every call is wrapped in `timeout` as well as `nc -w`: toybox nc exits on -w,
   the busybox build sometimes waits for the socket instead, and a stuck child
   would hold a bridge slot for the whole burst. */
async function dnsOne(server, pktB64, ms) {
  const sec = Math.max(1, Math.ceil((ms || 2000) / 1000));
  const cmd = 'printf %s ' + pktB64 + ' | base64 -d | timeout ' + (sec + 1) +
              ' nc -u -w ' + sec + ' ' + SHQ(server) + ' 53 2>/dev/null' +
              ' | od -An -tx1 | tr -d " \\n"';
  return dnsParseHex(await shRaw(cmd));
}

/* N queries against one server, at most `threads` in flight. Deduplicated, and
   every round is counted so the page can show hit rate rather than only "some
   addresses". */
async function dnsBurst(domain, server, count, timeoutMs, onTick, onLog) {
  const n = Math.max(1, Math.min(256, count || 64));
  const th = Math.max(1, Math.min(32, 8));
  const tick = onTick || (() => {});
  const log = onLog || (() => {});
  const pkt = dnsQuery(domain, 0x0001);
  let bin = '';
  for (let i = 0; i < pkt.length; i++) bin += String.fromCharCode(pkt[i]);
  const pktB64 = btoa(bin);

  const ips = new Set();
  const counts = {};
  let done = 0;

  const queue = Array.from({ length: n }, (_, i) => i);
  let i = 0;
  const worker = async () => {
    while (i < queue.length) {
      i++;
      const got = await dnsOne(server, pktB64, timeoutMs);
      got.forEach(ip => { ips.add(ip); counts[ip] = (counts[ip] || 0) + 1; });
      done++;
      tick(done, n);
    }
  };
  await Promise.all(Array.from({ length: Math.min(th, n) }, worker));

  const list = [...ips].map(ip => ({ ip, hits: counts[ip] })).sort((a, b) => b.hits - a.hits);
  log('dns ' + domain + ' @' + server + ' -> ' + list.length + ' ip / ' + n + ' 次');
  return { ips: list, rounds: n, error: list.length ? '' : 'no-answer' };
}

/* ---------- four-layer country-code diagnosis ----------
   Built in the page from the same commands the old diagnose.sh ran. Returns
   both the report text and the fields the caller may want to assert on. */
async function diagnoseLayers() {
  const cfg = await readFile(modDir() + '/config');
  const want = parseCC((cfg.match(/^CC=.*$/m) || [''])[0]) || 'US';

  const lines = [];
  const say = s => lines.push(s);

  say('==============================================');
  say(' KsuFastSurfing diagnose  (want CC=' + want + ')');
  say('==============================================');

  /* 1. framework */
  say('');
  say('--- [1] framework (WifiService) ---');
  const dcc = (await shRaw("dumpsys wifi 2>/dev/null | grep -iE '^(Current|Persistent|Telephony|OEM) Country ?Code:' | head -6")).trim();
  const cur = parseCC((dcc.split('\n').find(l => /^Current Country/i.test(l)) || ''));
  const tree = dcc.split('\n').filter(l => /^(Persistent|Telephony|OEM)/i.test(l))
    .map(l => l.trim()).join(' ');
  if (dcc) { say(dcc.split('\n').map(l => '  ' + l).join('\n')); }
  else say('  (dumpsys produced no Country Code lines)');
  const settings = (await shRaw('settings get global wifi_country_code')).trim();
  say('framework_cc=' + (cur || 'unknown'));
  say('framework_sources=' + (tree || 'none'));
  say('settings_country=' + settings);

  /* 2. supplicant */
  say('');
  say('--- [2] wpa_supplicant (acts as the regdb hint) ---');
  const confs = ['/data/misc/apexdata/com.android.wifi/WifiSupplicantControl/wpa_supplicant.conf',
                 '/data/misc/wifi/wpa_supplicant.conf',
                 '/data/vendor/wifi/wpa/wpa_supplicant.conf'];
  let sup = '';
  for (const f of confs) {
    const t = (await shRaw('[ -r ' + SHQ(f) + ' ] && grep -iE "^[[:space:]]*country=" ' + SHQ(f) + ' | head -1')).trim();
    if (!t) continue;
    sup = t.replace(/^[^=]*=/, '');
    say('conf=' + f);
    break;
  }
  say('supplicant_country=' + (sup || 'unset'));
  const iw = (await shRaw("command -v iw >/dev/null 2>&1 && iw reg get 2>&1 | grep -o 'country [A-Z0-9][A-Z0-9]' | head -1")).trim();
  say('iw_reg=' + (iw ? iw.replace(/^country\s+/, '') : 'n/a (iw not shipped on this image)'));

  /* 3. what the radio actually scanned */
  say('');
  say('--- [3] scan results (ground truth, no iw needed) ---');
  const scanTxt = await collectScanText();
  const rows = parseScan(scanTxt);
  const n5 = rows.filter(a => a.band === '5');
  const u2a = n5.filter(a => a.unii === 'UNII-2A');
  const u2c = n5.filter(a => a.unii === 'UNII-2C');
  const u3 = n5.filter(a => a.unii === 'UNII-3');
  say('bss_total=' + rows.length);
  if (!rows.length) say('  (no cached results - run: cmd wifi start-scan, then re-run this)');
  say('bss_5ghz=' + n5.length);
  say('bss_unii2a=' + u2a.length);
  say('bss_unii2c=' + u2c.length);
  say('bss_unii3=' + u3.length);
  if (u2c.length) {
    say('  UNII-2C (ch100-144) APs seen:');
    u2c.slice(0, 10).forEach(a => say('    ' + a.freq + ' MHz  ch' + a.ch + '  ' + a.ssid));
  }
  say('freq_list=' + [...new Set(rows.map(a => a.freq))].sort((a, b) => a - b).join(' '));

  /* 4. vendor WLAN config */
  say('');
  say('--- [4] vendor WLAN config ---');
  const vendor = ['/vendor/etc/wifi/WCNSS_qcom_cfg.ini',
                  '/vendor/etc/wifi/wifi_con_mode.conf',
                  '/odm/etc/wifi/WCNSS_qcom_cfg.ini'];
  let found = 0;
  for (const f of vendor) {
    const t = (await shRaw('[ -r ' + SHQ(f) + ' ] && grep -iE "country|regdom|11d" ' + SHQ(f) + ' | head -8')).trim();
    if (!t) continue;
    found = 1;
    say('found: ' + f);
    say(t.split('\n').map(l => '    ' + l).join('\n'));
  }
  if (!found) say('  (no WCNSS_qcom_cfg.ini found - this ROM uses BDF/NV, not the ini)');
  const ov = (await shRaw("mount 2>/dev/null | grep -c 'WCNSS_qcom_cfg'")).trim();
  say('vendor_overlay=' + (ov || '0'));

  /* 5. connected link */
  say('');
  say('--- [5] current link ---');
  const linkTxt = await shRaw('cmd wifi status');
  const linkLine = (linkTxt.split('\n').find(l => /WifiInfo:/.test(l)) || '').trim();
  if (linkLine) say('  ' + linkLine.slice(0, 160));
  else say('  (no WifiInfo line)');

  /* verdict */
  say('');
  say('--- verdict ---');
  if (cur && cur !== want) {
    say('framework=' + cur + ' but config wants ' + want + ' -> the force-country-code call is not sticking');
  } else if (cur === want) {
    say('framework already ' + cur + ' -> the country code IS applied; the block is elsewhere');
  }
  if (u2c.length > 0) {
    say('UNII-2C APs ARE visible -> channels work; if Settings hides them, that is');
    say('  a UI/scan-cache issue, try: cmd wifi start-scan (twice, 10s apart)');
  } else if (n5.length > 0) {
    say('5GHz visible but no UNII-2C AP -> either none nearby, or DFS is filtered.');
    say('  Move next to the AP and re-run; if still 0, the radio is filtering DFS.');
  } else {
    say('No 5GHz at all -> check WLAN band setting / AP is on 2.4GHz.');
  }
  say("Deeper check (root): dmesg | grep -i -E 'regdom|country|dfs'");

  return {
    want, current: cur, settings, supplicant: sup, iw: iw || '',
    total: rows.length, n5: n5.length,
    unii2a: u2a.length, unii2c: u2c.length, unii3: u3.length,
    vendorOverlay: ov || '0',
    text: lines.join('\n') + '\n'
  };
}
