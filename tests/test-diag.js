#!/usr/bin/env node
/* Regression tests for the in-page diagnostic parser (webroot/diag.js).
 *
 * The page now reads `cmd wifi list-scan-results` directly, so this parser is
 * the only thing standing between raw device output and every number on
 * screen. The cases below are the ones that broke during development, plus the
 * hostile inputs the old delimiter protocol could not survive.
 *
 * Run: node tests/test-diag.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'module/webroot/diag.js'), 'utf8');

/* The module targets the browser (async helpers calling exec). Wrap it in a
   Function with exec injected so it can run in node without a DOM. */
const api = new Function('exec', src + `
  return { parseScan, parseLink, analyse, scoreChannels, chanOf, isDfs, uniiOf,
           quality, fillMacs, parseWpa, b64bytes };
`)(async () => ({ stdout: '', stderr: '', errno: 0 }));

let failures = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`  FAIL ${label}\n    got  ${g}\n    want ${w}`); failures++; }
}
function ok(label, cond, detail) {
  if (!cond) { console.log(`  FAIL ${label}${detail ? '\n    ' + detail : ''}`); failures++; }
}

const HDR = 'BSSID              Frequency      RSSI           Age(sec)     SSID                                 Flags\n';

/* ---------- 1. hostile SSIDs ---------- */
console.log('== hostile SSIDs ==');
{
  const scan = HDR +
    '  68:19:aa:bb:cc:01       5500    -25(0:-25/1:-30)    3.1    Coffee | Bar = 7        [RSN-PSK][ESS]\n' +
    '  68:19:aa:bb:cc:02       5180    -60(0:-60/1:-65)    4.2    it\'s "quoted" \\ back    [RSN-PSK][ESS]\n' +
    '  68:19:aa:bb:cc:03       2437    -70(0:-70/1:-75)    5.0   咖啡馆 2.4G              [WPA2-PSK][ESS]\n' +
    '  68:19:aa:bb:cc:04       5745    -80(0:-80/1:-85)    6.7    ap fake=1|2             [RSN-PSK][ESS]\n';
  const rows = api.parseScan(scan);
  eq('row count', rows.length, 4);
  /* Each field must belong to its own row: a delimiter-joined protocol
     reshuffles exactly here. */
  eq('pipes/equals SSID', rows[0].ssid, 'Coffee | Bar = 7');
  eq('quotes+backslash SSID', rows[1].ssid, 'it\'s "quoted" \\ back');
  eq('utf8 SSID', rows[2].ssid, '咖啡馆 2.4G');
  eq('embedded pipe SSID', rows[3].ssid, 'ap fake=1|2');
  eq('rssi of row 1', rows[0].rssi, -25);
  eq('ch of row 1', rows[0].ch, 100);
  eq('rssi not shifted', rows[3].rssi, -80);
  eq('ch not shifted', rows[3].ch, 149);
}

/* ---------- 2. RSSI forms ---------- */
console.log('== RSSI forms ==');
{
  const rows = api.parseScan(HDR +
    '  aa:bb:cc:dd:ee:01       5180    -58(0:-59/1:-63)    11.1    A        [RSN-PSK][ESS]\n' +
    '  aa:bb:cc:dd:ee:02       5180    -72                 11.1    B        [RSN-PSK][ESS]\n');
  /* A naive digit strip turns "-58(0:-59/1:-63)" into -250. */
  eq('prefixed rssi', rows[0].rssi, -58);
  eq('plain rssi', rows[1].rssi, -72);
}

/* ---------- 3. hidden SSID and header ---------- */
console.log('== hidden / header ==');
{
  const rows = api.parseScan(HDR +
    '  aa:bb:cc:dd:ee:01       5180    -50(0:-50/1:-55)    2.0    null             [RSN-PSK][ESS]\n');
  eq('header skipped', rows.length, 1);
  eq('null SSID becomes empty', rows[0].ssid, '');
}

/* ---------- 4. UNII bucketing by channel, not frequency ---------- */
console.log('== UNII bands ==');
{
  /* 5725MHz is exactly ch149 = UNII-3; a "freq <= 5725" test calls it UNII-2C. */
  const rows = api.parseScan(HDR +
    '  aa:bb:cc:dd:ee:01       5725    -50(0:-50/1:-55)    2.0    U3       [RSN-PSK][ESS]\n' +
    '  aa:bb:cc:dd:ee:02       5500    -50(0:-50/1:-55)    2.0    U2C      [RSN-PSK][ESS]\n' +
    '  aa:bb:cc:dd:ee:03       5300    -50(0:-50/1:-55)    2.0    U2A      [RSN-PSK][ESS]\n');
  eq('ch149 is UNII-3', rows[0].unii, 'UNII-3');
  eq('ch149 not DFS', rows[0].dfs, 0);
  eq('ch100 is UNII-2C', rows[1].unii, 'UNII-2C');
  eq('ch60 is UNII-2A', rows[2].unii, 'UNII-2A');
  eq('ch60 is DFS', rows[2].dfs, 1);
}

/* ---------- 5. connected link parsing ---------- */
console.log('== link ==');
{
  const l = api.parseLink('WifiInfo: SSID: "Limx-Guests", BSSID: 68:19:aa:bb:cc:c3, ' +
    'Supplicant state: COMPLETED, Wi-Fi standard: 11ax, RSSI: -51, Link speed: 573Mbps, ' +
    'Frequency: 5180MHz, MLO: false');
  eq('link ssid', l.ssid, 'Limx-Guests');
  eq('link freq', l.freq, 5180);
  eq('link ch', l.ch, 36);
  eq('link rssi', l.rssi, -51);
  eq('link mbps', l.mbps, 573);
  eq('link std', l.std, '11ax');

  /* An SSID containing a comma must not be truncated at the split point. */
  const l2 = api.parseLink('WifiInfo: SSID: "Cafe, Bar", RSSI: -40, Frequency: 5500MHz');
  eq('comma in SSID', l2.ssid, 'Cafe, Bar');
  eq('comma SSID freq', l2.freq, 5500);

  eq('no link line', api.parseLink('Wifi is disabled'), null);
}

/* ---------- 6. channel recommendation rules ---------- */
console.log('== recommendation ==');
{
  /* Only 2.4GHz present: 5GHz cannot be recommended. */
  const only24 = api.parseScan(HDR +
    '  aa:bb:cc:dd:ee:01       2437    -40(0:-40/1:-45)    2.0    A        [RSN-PSK][ESS]\n');
  const s24 = api.scoreChannels(only24);
  ok('2.4GHz-only pick is 2.4GHz', s24[0].ch <= 14, `got ch${s24[0].ch}`);

  /* 5GHz present: prefer it even when 2.4 has a cleaner channel. */
  const mixed = api.parseScan(HDR +
    '  aa:bb:cc:dd:ee:01       2437    -40(0:-40/1:-45)    2.0    A        [RSN-PSK][ESS]\n' +
    '  aa:bb:cc:dd:ee:02       5180    -75(0:-75/1:-80)    2.0    B        [RSN-PSK][ESS]\n');
  const sm = api.scoreChannels(mixed);
  ok('5GHz preferred over clean 2.4', sm[0].ch > 34, `got ch${sm[0].ch}`);

  /* An empty DFS channel scores 0 and must still never be the top pick. */
  const dfs = api.parseScan(HDR +
    '  aa:bb:cc:dd:ee:01       5180    -70(0:-70/1:-75)    2.0    A        [RSN-PSK][ESS]\n');
  const sd = api.scoreChannels(dfs);
  ok('top pick is not DFS', sd[0].dfs === 0, `got ch${sd[0].ch} dfs=${sd[0].dfs}`);
  ok('top pick is 5GHz when 5GHz seen', sd[0].ch > 34);

  /* Candidates must be real channels: the +/-4 adjacency spill once leaked
     ch45/46/50/146 into the list and the tool recommended ch49. */
  const legal = (c) => (c >= 1 && c <= 14) || (c >= 36 && c <= 64) ||
                       (c >= 100 && c <= 144) || (c >= 149 && c <= 165);
  eq('no illegal candidate channels', sd.filter(x => !legal(x.ch)).map(x => x.ch), []);
  eq('5GHz candidates on the 4-channel grid',
     sd.filter(x => x.ch > 34 && x.ch < 100 && (x.ch - 36) % 4 !== 0).map(x => x.ch), []);
}

/* ---------- 7. full analysis on a realistic capture ---------- */
console.log('== full analysis ==');
{
  const scan = HDR +
    '  68:19:aa:bb:cc:01       5500    -25(0:-25/1:-30)    9.0    COFEEB32AE        [RSN-PSK][ESS]\n' +
    '  68:19:aa:bb:cc:02       5785    -58(0:-58/1:-63)    11.0    Li7E641E1C        [RSN-PSK][ESS]\n' +
    '  68:19:aa:bb:cc:03       5785    -58(0:-58/1:-63)    11.0    Li7E641E1C        [RSN-PSK][ESS]\n' +
    '  68:19:aa:bb:cc:04       2437    -53(0:-53/1:-58)    11.0    LVDE62DDE2        [RSN-PSK][ESS]\n' +
    '  68:19:aa:bb:cc:05       5180    -67(0:-67/1:-72)    11.0    TR096CAB33        [RSN-PSK][ESS]\n' +
    '  68:19:aa:bb:cc:06       5300    -83(0:-83/1:-88)    10.0    TR82457E94        [RSN-PSK][ESS]\n';
  const link = api.parseLink('WifiInfo: SSID: "Limx-Guests", RSSI: -51, Link speed: 573Mbps, Frequency: 5180MHz, Wi-Fi standard: 11ax');
  const net = { gateway: '192.168.1.1', loss: 0, rtt: 2.4, dns: 'ok' };
  const d = api.analyse(api.parseScan(scan), link, net);

  eq('total', d.summary.total, 6);
  eq('n24', d.summary.n24, 1);
  eq('n5', d.summary.n5, 5);
  eq('ndfs', d.summary.ndfs, 2);
  eq('nunii2c', d.summary.nunii2c, 1);
  eq('nunii2a', d.summary.nunii2a, 2);   /* ch36 and ch60 */
  eq('best ssid', d.best.ssid, 'COFEEB32AE');
  eq('best rssi', d.best.rssi, -25);
  eq('dfs channels', d.dfsCh, [60, 100]);

  /* Congestion counts raw BSSIDs per channel: two radios on ch157. */
  eq('ch157 congestion', d.congestion.find(x => x.ch === 157).count, 2);

  /* The link/L3 scalars must be carried through: they were dropped once and
     the network card showed "未获取" on a perfectly healthy link. */
  eq('gateway carried', d.gateway, '192.168.1.1');
  eq('loss carried', d.loss, 0);
  eq('rtt carried', d.rtt, 2.4);
  eq('verdict dfs', d.verdict.dfs, 'ok');
  eq('verdict net', d.verdict.net, 'ok');

  /* No gateway must be distinguishable from a measured 0% loss. */
  const d2 = api.analyse(api.parseScan(scan), link, { gateway: '', loss: null, rtt: null, dns: 'fail' });
  /* Same name on two radios must stay two rows in one group, and the group
     must be anchored by its strongest member. The AP page used to dedupe to
     the strongest BSSID, which made a mesh look like a single radio. */
  eq('group count', d.groups.length, 5);
  eq('Li7E641E1C radios', d.groups.find(g => g.ssid === 'Li7E641E1C').count, 2);
  eq('Li7E641E1C channels', d.groups.find(g => g.ssid === 'Li7E641E1C').chans, [157]);
  eq('group order by best', d.groups[0].ssid, 'COFEEB32AE');
  eq('group best rssi', d.groups[0].best, -25);
  eq('secondary radio kept', d.groups.find(g => g.ssid === 'Li7E641E1C').bssids[1].bssid,
     '68:19:aa:bb:cc:03');

  eq('no gateway verdict', d2.verdict.net, 'nogw');
  eq('no gateway is not 0% loss', d2.loss, null);
  eq('dns fail surfaces', d2.verdict.dns, 'fail');

  /* Every radio in the scan must survive grouping: losing one would hide a
     whole band of a network the user is trying to diagnose. */
  eq('all radios grouped', d.groups.reduce((n, g) => n + g.count, 0), 6);
  eq('groups agree with aps', d.groups.length, d.aps.length);
}

/* ---------- 8. security label per radio ---------- */
console.log('== per-radio security ==');
{
  const scan = HDR +
    '  68:19:aa:bb:cc:11       5180    -50(0:-50/1:-55)    4.0    Mixed            [RSN-PSK][ESS]\n' +
    '  68:19:aa:bb:cc:12       2437    -62(0:-62/1:-67)    4.0    Mixed            [WPA-PSK][ESS]\n' +
    '  68:19:aa:bb:cc:13       5745    -70(0:-70/1:-75)    4.0    Open             [ESS]\n' +
    '  68:19:aa:bb:cc:14       5955    -66(0:-66/1:-71)    4.0    Modern           [RSN-SAE][ESS]\n';
  const rows = api.parseScan(scan);
  eq('wpa2', rows.find(r => r.bssid.endsWith(':11')).sec, 'WPA2');
  eq('wpa', rows.find(r => r.bssid.endsWith(':12')).sec, 'WPA');
  eq('open', rows.find(r => r.bssid.endsWith(':13')).sec, '开放');
  eq('wpa3', rows.find(r => r.bssid.endsWith(':14')).sec, 'WPA3');

  /* One name, two different security modes: the group header must not claim a
     single mode, so it renders each radio's own label. */
  const d = api.analyse(rows, {}, { gateway: '', loss: null, rtt: null, dns: 'ok' });
  eq('mixed group radios', d.groups.find(g => g.ssid === 'Mixed').count, 2);
}


/* ---------- 9. redacted BSSIDs and mangled SSIDs ---------- */
console.log('== mac recovery ==');
{
  /* Android 12+ gives the page 68:19:**:**:37:c3 - the third and fourth octets
     are the ones blanked, so a matching full address must read
     68:19:xx:xx:37:c3. The complete address lives in wpa_supplicant, which the
     page can read because it runs as root. */
  const scan = HDR +
    '  68:19:**:**:37:c3       5785    -58(0:-59/1:-63)    11.1    Li5DAA9D1D        [RSN-PSK][ESS]\n' +
    '  68:19:**:**:37:c2       5785    -70(0:-71/1:-75)    11.1    Li7E641E1C        [RSN-PSK][ESS]\n' +
    '  54:69:**:**:da:c0       2437    -69(0:-69/1:-83)    11.2    华科              [RSN-PSK][ESS]\n';

  const rows = api.parseScan(scan);
  eq('masked kept as-is before merge', rows[0].bssid, '68:19:**:**:37:c3');

  /* Listed weakest-first, and the levels are inverted relative to the row
     order, so proximity alone would hand each row the wrong address. */
  const wpa = api.parseWpa('bssid / frequency / signal level / flags / ssid\n' +
    '68:19:cc:dd:37:c2\t5785\t-70\t[RSN-PSK]\tLi7E641E1C\n' +
    '68:19:aa:bb:37:c3\t5785\t-58\t[RSN-PSK]\tLi5DAA9D1D\n' +
    '54:69:aa:bb:da:c0\t2437\t-69\t[RSN-PSK]\t华科\n');
  eq('supplicant rows parsed', wpa.length, 3);

  const fixed = api.fillMacs(rows, wpa);
  eq('all masked resolved', fixed, 3);
  eq('prefix+suffix pin', rows[0].bssid, '68:19:aa:bb:37:c3');
  eq('sibling on same channel not crossed', rows[1].bssid, '68:19:cc:dd:37:c2');
  eq('chinese name intact', rows[2].ssid, '华科');

  /* Two radios on one channel under one vendor prefix, both at the same level,
     and the supplicant lists them in the reverse of the page's order. Only the
     octets that survived redaction can decide this. */
  const dup = api.parseScan(HDR +
    '  68:19:**:**:3b:21       5825    -60(0:-60/1:-87)  11.0  Li106B67FC  [RSN-PSK]\n' +
    '  68:19:**:**:3b:20       5825    -60(0:-60/1:-87)  11.0  liC41CD1D9  [RSN-PSK]\n');
  const dupWpa = api.parseWpa('h\n' +
    '68:19:bb:cc:3b:20\t5825\t-60\t[RSN-PSK]\tliC41CD1D9\n' +
    '68:19:aa:bb:3b:21\t5825\t-60\t[RSN-PSK]\tLi106B67FC\n');
  api.fillMacs(dup, dupWpa);
  eq('suffix pin disambiguates', dup.map(r => r.bssid),
     ['68:19:aa:bb:3b:21', '68:19:bb:cc:3b:20']);
  eq('no address reused', new Set(dup.map(r => r.bssid)).size, 2);

  /* Nothing to merge: the redacted value must be left alone, never invented. */
  const solo = api.parseScan(HDR +
    '  68:19:**:**:37:c3       5785  -58  11.1  Solo  [RSN-PSK]\n');
  eq('no supplicant leaves it masked', api.fillMacs(solo, []), 0);
  eq('masked value unchanged', solo[0].bssid, '68:19:**:**:37:c3');
}

/* ---------- 10. SSID bytes survive the bridge ---------- */
console.log('== ssid bytes ==');
{
  /* The WebUI bridge decodes as Latin-1, so a UTF-8 name arrived as mojibake:
     only the first character looked right. Base64 + TextDecoder fixes it, and
     the round trip has to be byte exact for CJK, emoji and emoji-in-CJK. */
  const names = ['华科', '咖啡馆 5G', '🛜 home', 'Café', 'Li5DAA9D1D'];
  names.forEach(n => {
    const b = Buffer.from(n, 'utf8').toString('base64');
    eq('round trip ' + n, api.b64bytes(b), n);
  });
  /* A lone truncated character would blow up a strict decode; it must degrade
     to a replacement glyph instead of throwing and blanking the page. */
  const broken = Buffer.from([0xe5, 0x8d, 0x8e, 0xe7, 0xa7]).toString('base64');
  ok('truncated utf8 degrades', typeof api.b64bytes(broken) === 'string');
  eq('decoded length sane', api.b64bytes('').length, 0);
}

/* ---------- 11. freshness ---------- */
console.log('== freshness ==');
{
  const scan = HDR +
    '  aa:00:00:00:00:01  5180  -50  2.0   A  [RSN-PSK]\n' +
    '  aa:00:00:00:00:02  2437  -70  9.0   B  [RSN-PSK]\n' +
    '  aa:00:00:00:00:03  5745  -60  300.0 C  [RSN-PSK]\n';
  const d = api.analyse(api.parseScan(scan), {}, { gateway: '', loss: null, rtt: null, dns: 'ok' });
  /* The median is what the UI shows: a 300-second neighbour must not drag the
     whole cache "freshness" down to five minutes, which is why the max was
     useless for telling whether a rescan landed. */
  eq('age min', d.ageMin, 2);
  eq('age median', d.ageMed, 9);
  eq('age max still available', d.ageMax, 300);
}

console.log(failures ? `${failures} failure(s)` : '\nall parser tests passed');
process.exit(failures ? 1 : 0);
