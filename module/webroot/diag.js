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

/* Pure: takes the already-collected route/addr/echo blocks. There is no local
   ping any more: packet loss and gateway RTT only ever described the first hop,
   and a hop that answers ICMP says nothing about whether the internet is
   reachable. Latency is now measured by the same request that reports the
   egress address, so one number replaces two and costs no extra round trip. */
function parseNet(route, addrTxt, echo) {
  const net = {
    gateway: '', dns: 'unknown',
    addr: '', prefix: null, mask: '', iface: '', routes: [],
    clientIp: '', clientArea: '', dnsIp: '', dnsArea: '',
    latency: null, lookupMs: null
  };

  net.gateway = gatewayOf(route);
  net.iface = ifaceOf(route);
  net.routes = parseRoutes(route);

  const a = parseAddr(addrTxt, net.iface);
  net.addr = a.addr; net.prefix = a.prefix; net.mask = a.mask;
  if (!net.iface) net.iface = a.iface;

  /* The echo page replaces the old `ping github.com` probe: one HTTPS request
     answers reachability, reports the address the internet sees plus the
     resolver it observed, and its own timing is the outbound latency. A
     failure is 'fail', an unparsable page 'unknown'. */
  const e = echo || {};
  net.clientIp = e.client || '';
  net.clientArea = e.clientArea || '';
  net.dnsIp = e.dns || '';
  net.dnsArea = e.dnsArea || '';
  net.latency = (e.total != null && isFinite(e.total)) ? e.total : null;
  net.lookupMs = (e.lookup != null && isFinite(e.lookup)) ? e.lookup : null;
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
    gateway: net.gateway,
    addr: net.addr, prefix: net.prefix, mask: net.mask, iface: net.iface,
    routes: net.routes, clientIp: net.clientIp, clientArea: net.clientArea,
    dnsIp: net.dnsIp, dnsArea: net.dnsArea,
    latency: net.latency, lookupMs: net.lookupMs,
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
   parallel: a failed address lookup must not blank the gateway, and an
   unreachable echo page must not hold back the scan table. */
async function measure() {
  const scanTxt = await collectScanText();
  const rows = parseScan(scanTxt);
  if (!rows.length) return { error: 'empty-scan', raw: scanTxt };

  const linkTxt = await shRaw('cmd wifi status');
  let routeTxt = await shRaw('ip route');
  if (!gatewayOf(routeTxt)) {
    routeTxt = routeText(routeTxt, await shRaw('ip route get 1.1.1.1 2>/dev/null'));
  }
  const ifc = ifaceOf(routeTxt) || 'wlan0';

  /* The echo page is the only outbound measurement left, so it runs alongside
     the local reads rather than after them. */
  const [addrTxt, echo] = await Promise.all([
    shRaw('ip addr show dev ' + SHQ(ifc) + ' 2>/dev/null'),
    echoLookup(8)
  ]);

  const d = analyse(rows, parseLink(linkTxt),
                    parseNet(routeTxt, addrTxt, echo));
  d.iface = ifc;          /* the address card names the interface that holds the route */
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

/* The page has no API - it is HTML for humans. Each line is
     <label>: <ip> <area text>
   and the area text is the whole point of the page: "广东省深圳市电信" says more
   about a broken resolver than the bare address does. Lines are split first so
   the tail of the IP line cannot be read as part of the DNS line.

   The labels are Chinese and differ between deployments ("您的IP地址信息"/"IP"),
   so matching is by shape after splitting, not by exact wording. */
const AREA_MAX = 64;            /* long enough for "广东省深圳市电信", short enough to be sane */

function tidyArea(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim()
    .slice(0, AREA_MAX);
}

function parseEcho(html) {
  const text = String(html || '');
  const segs = text.split(/<br\s*\/?>|\n/i);

  /* "label: 1.2.3.4 area" -> { ip, area }. The address is matched first and
     everything after it on the same line is the area; anything that is not an
     address is not accepted, so a page full of unrelated numbers cannot
     produce a bogus client IP. */
  const pick = (labels) => {
    for (const seg of segs) {
      if (!labels.some(l => seg.indexOf(l) >= 0 || new RegExp(l, 'i').test(seg))) continue;
      const m = seg.match(/([0-9]{1,3}(?:\.[0-9]{1,3}){3})\s*([^<>]*)/);
      if (m && isIPv4(m[1])) return { ip: m[1], area: tidyArea(m[2]) };
    }
    return { ip: '', area: '' };
  };

  let client = pick(['IP地址', 'IP address']);
  let dns = pick(['DNS地址', 'DNS address', 'DNS server']);

  /* Older deployments drop the labels and print only the addresses. Fall back
     to document order - first address is ours, second is the resolver - and
     leave the area blank rather than attaching the wrong city to the IP. */
  if (!client.ip) {
    const all = (text.match(/[0-9]{1,3}(?:\.[0-9]{1,3}){3}/g) || [])
      .filter(isIPv4);
    if (all.length) {
      client = { ip: all[0], area: '' };
      if (!dns.ip && all.length > 1) dns = { ip: all[1], area: '' };
    }
  }
  if (!dns.ip) {
    const all = (text.match(/[0-9]{1,3}(?:\.[0-9]{1,3}){3}/g) || []).filter(isIPv4)
      .filter(x => x !== client.ip);
    if (all.length) dns = { ip: all[0], area: '' };
  }

  /* "DNS设置正确" / "DNS设置可能存在问题，请联系您的ISP服务商". The second one is the
     finding this whole card exists for, so it must not fall through to
     'unknown'. */
  const verdict = /DNS设置(?:正确|无误)|DNS\s*(?:is\s*)?correct/i.test(text) ? 'ok'
    : (/DNS设置(?:可能)?(?:存在)?(?:问题|错误|有误)|DNS\s*(?:is\s*)?(?:wrong|incorrect|mismatch)/i.test(text)
       ? 'bad' : 'unknown');

  return { client: client.ip, clientArea: client.area,
           dns: dns.ip, dnsArea: dns.area, verdict };
}

/* curl -sS with a short cap: the whole point is a bounded outbound test, and a
   hanging TLS handshake must not hold the page. `--compressed` because the
   server may gzip. `-o /dev/null` keeps the body off stdout so the only thing
   printed is the timing line - the body is fetched separately below.

   The request returns the body and the timings in one shot: `total` is the
   end-to-end cost of a real round trip (DNS + TCP + TLS + first byte), which
   is what a user feels, and `time_namelookup` separates a slow resolver from
   a slow path. This replaced the gateway ping, which measured the first hop
   only and could not tell "gateway is fine, ISP is broken" from anything. */
async function echoLookup(timeout) {
  const t = Math.max(2, Math.min(15, timeout || 6));
  const url = echoUrl();
  const mark = '\n@@T ';
  const txt = await shRawAs(
    'curl -sS --compressed -m ' + t +
    ' -w ' + SHQ(mark + '%{time_total} %{time_namelookup} %{http_code}' + '\n') +
    ' ' + SHQ(url), 'gbk');
  if (!txt) return { client: '', dns: '', verdict: 'fail', latency: null, lookupMs: null, raw: '' };

  /* Split the timing trailer off before parsing: its numbers would otherwise
     be candidates for "some address on the page". */
  let body = txt, total = null, lookup = null, code = 0;
  const at = txt.indexOf(mark);
  if (at >= 0) {
    body = txt.slice(0, at);
    const m = txt.slice(at + mark.length).trim().split(/\s+/);
    if (m[0] != null && isFinite(+m[0])) total = Math.round(+m[0] * 1000);
    if (m[1] != null && isFinite(+m[1])) lookup = Math.round(+m[1] * 1000);
    if (m[2] != null) code = +m[2] || 0;
  }

  const r = parseEcho(body);
  r.raw = body;
  r.total = total;
  r.lookup = lookup;
  r.code = code;
  /* curl exits 0 on a 404 that got a page; a page without addresses is still
     not an answer to "where does the internet see me". */
  if (!r.client && code && code >= 400) r.verdict = 'fail';
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
