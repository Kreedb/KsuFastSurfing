#!/usr/bin/env node
/* Regression tests for the in-page diagnostic parser (webroot/diag.js).
 *
 * The page reads `cmd wifi list-scan-results` directly, so this parser is the
 * only thing standing between raw device output and every number on screen. The cases below are the ones that broke during development, plus the
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
           rssiBand, b64bytes, parseNet, routeText, mergeHosts,
           countHosts, setKV, parseCC, parseEcho, prefixToMask, parseAddr,
           parseRoutes, dnsQuery, dnsParseHex };
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
  /* ch36-48 is UNII-1: counting it as UNII-2A inflated the (52-64) bucket. */
  const low = api.parseScan(HDR +
    '  aa:bb:cc:dd:ee:09       5180    -50(0:-50/1:-55)    2.0    U1       [RSN-PSK][ESS]\n');
  eq('ch36 is UNII-1', low[0].unii, 'UNII-1');
  eq('ch36 is not DFS', low[0].dfs, 0);
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
  eq('nunii2a', d.summary.nunii2a, 1);   /* ch60 only; ch36 is UNII-1 */
  eq('dfs channels', d.dfsCh, [60, 100]);

  /* The link/L3 scalars must be carried through: they were dropped once and
     the network card showed "未获取" on a perfectly healthy link. */
  eq('gateway carried', d.gateway, '192.168.1.1');
  eq('loss carried', d.loss, 0);
  eq('rtt carried', d.rtt, 2.4);
  eq('verdict dfs', d.verdict.dfs, 'ok');

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


/* ---------- 9. redacted BSSIDs stay redacted ---------- */
console.log('== bssid redaction ==');
{
  /* Android 12+ blanks the middle two octets unless the caller holds location
     access. There is no portable way to undo that from a shell (`wpa_cli` is
     mute on the AIDL supplicant, `iw` is absent from retail ROMs), so the page
     shows what the framework gives and never invents the rest. */
  const scan = HDR +
    '  68:19:**:**:37:c3       5785    -58(0:-59/1:-63)    11.1    Li5DAA9D1D        [RSN-PSK][ESS]\n' +
    '  54:69:**:**:da:c0       2437    -69(0:-69/1:-83)    11.2    华科              [RSN-PSK][ESS]\n';
  const rows = api.parseScan(scan);
  eq('masked address is kept verbatim', rows[0].bssid, '68:19:**:**:37:c3');
  eq('masked rows still parse', rows.length, 2);
  eq('ssid is not disturbed by the mask', rows[1].ssid, '华科');
  eq('masked row still carries its band', api.rssiBand(rows[0].rssi).cls, 'ok');
}

/* ---------- 9b. default route lives in another table ---------- */
console.log('== gateway behind a per-network table ==');
{
  /* What Android actually prints on a connected phone: the on-link prefix and
     nothing else. The old parser looked for `default` and gave up, so the
     gateway card stayed empty and the gateway ping never ran. */
  const onlink = '192.168.1.0/24 dev wlan0 proto kernel scope link src 192.168.1.13\n';
  const got = '1.1.1.1 via 192.168.1.1 dev wlan0 table wlan0 src 192.168.1.13 uid 0\n';
  const merged = api.routeText(onlink, got);
  const net = api.parseNet(merged, '3 packets transmitted, 3 received, 0% packet loss\nrtt min/avg/max/mdev = 2.1/3.4/5.0/0.4 ms\n', 'rc=0');
  eq('gateway recovered from ip route get', net.gateway, '192.168.1.1');
  eq('iface recovered too', api.parseNet(merged, '', '').gateway, '192.168.1.1');
  ok('the synthetic line is a real default', /^default via 192\.168\.1\.1 dev wlan0$/m.test(merged), merged);

  /* A table that already has a default is passed through untouched. */
  const withDef = 'default via 10.0.0.1 dev wlan0\n192.168.1.0/24 dev wlan0 proto kernel\n';
  eq('existing default is not duplicated', api.routeText(withDef, got), withDef);
  /* Nothing usable: keep the original text rather than inventing a route. */
  eq('no gateway anywhere leaves the text alone', api.routeText(onlink, ''), onlink);
}

/* ---------- 9c. outbound echo page ---------- */
console.log('== outbound echo page ==');
{
  /* The page is HTML written for humans, in GBK. Addresses are picked out by
     shape and by label, and the verdict sentence decides the DNS state. */
  /* Real bytes captured from the server: GBK, as content-type says. */
  const gbk = Buffer.from(
    'xPq6w6Os1/C+tLXEzfjS19PDu6c8YnI+xPq1xElQtdjWt9DFz6I6IDM5Ljk2LjE5' +
    'LjEyNSCxsb6pytA8YnI+xPq1xEROU7XY1rfQxc+iOiAzOS4xMDMuMjYuMjI5ILGxvqnK' +
    '0Dxicj7E+rXERE5TyejWw9X9yLc=', 'base64');
  const text = new TextDecoder('gbk').decode(new Uint8Array(gbk));
  const e = api.parseEcho(text);
  eq('client ip', e.client, '39.96.19.125');
  eq('resolver ip', e.dns, '39.103.26.229');
  eq('verdict', e.verdict, 'ok');

  /* A wrong-resolver page must not read as success. */
  const bad = api.parseEcho('您的IP地址信息: 1.2.3.4<br>您的DNS地址信息: 5.6.7.8<br>您的DNS设置错误');
  eq('mismatch is reported', bad.verdict, 'bad');
  eq('mismatch still yields addresses', bad.dns, '5.6.7.8');

  /* No addresses at all: not a crash, an empty answer. */
  const empty = api.parseEcho('<html>error</html>');
  eq('nothing parsed, nothing invented', [empty.client, empty.dns], ['', '']);
  eq('nothing parsed is unknown, not ok', empty.verdict, 'unknown');
}

/* ---------- 9d. mask and route table ---------- */
console.log('== mask and routes ==');
{
  eq('/24', api.prefixToMask(24), '255.255.255.0');
  eq('/0', api.prefixToMask(0), '0.0.0.0');
  eq('/32', api.prefixToMask(32), '255.255.255.255');
  eq('/20', api.prefixToMask(20), '255.255.240.0');
  eq('out of range is refused', api.prefixToMask(40), '');

  const a = api.parseAddr('2: wlan0: <BROADCAST> mtu 1500\n' +
                          '    inet 192.168.1.13/24 brd 192.168.1.255 scope global wlan0\n');
  eq('address and prefix', [a.addr, a.prefix, a.mask], ['192.168.1.13', 24, '255.255.255.0']);
  eq('iface from the addr block', a.iface, 'wlan0');
  eq('no inet line yields nothing', api.parseAddr('wlan0: no addresses').addr, '');

  const rows = api.parseRoutes(
    '192.168.1.0/24 dev wlan0 proto kernel scope link src 192.168.1.13\n' +
    'default via 192.168.1.1 dev wlan0 proto static\n' +
    '10.1.99.212/30 dev rmnet_data4 proto kernel scope link src 10.1.99.214\n');
  eq('default first', rows[0].dest, 'default');
  eq('gateway parsed', rows[0].gw, '192.168.1.1');
  eq('on-link row has no gateway', rows[1].gw, '');
  eq('source kept where present', rows[1].src, '192.168.1.13');
  eq('three rows', rows.length, 3);
}

/* ---------- 9e. DNS wire format ---------- */
console.log('== dns burst ==');
{
  /* Byte-for-byte against the same query dns.sh builds with od/awk. */
  eq('google.com query bytes',
     Buffer.from(api.dnsQuery('google.com', 1)).toString('hex'),
     '00010100000100000000000006676f6f676c6503636f6d0000010001');

  /* Labels longer than 63 bytes cannot be encoded; they are dropped instead of
     producing a malformed packet. */
  const long = Buffer.from(api.dnsQuery('a'.repeat(70) + '.com', 1)).toString('hex');
  eq('over-long label is skipped', /03636f6d0000010001$/.test(long), true);

  /* Shaped like a real reply, with a compression pointer in the answer name. */
  const reply = '12348180000100010000000003777777' + '0667697468756203636f6d0000010001' +
                'c00c000100010000012c0004' + '14cd2c02';
  eq('compressed answer decodes', api.dnsParseHex(reply), ['20.205.44.2']);
  ok('a header-only reply yields nothing', api.dnsParseHex('123481800000000000000000').length === 0);

  /* CNAME then A: the name walk must skip the first record's rdata and still
     find the address behind it. */
  const cname = '12348180000100020000000003777777' + '0667697468756203636f6d0000010001' +
                'c00c000500010000012c0002' + 'c010' +
                'c010000100010000012c0004' + '14cd2c02';
  eq('address behind a cname', api.dnsParseHex(cname), ['20.205.44.2']);
  eq('garbage is not a crash', api.dnsParseHex('zzzz'), []);
  eq('empty is not a crash', api.dnsParseHex(''), []);
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
}

/* ---------- 13. one RSSI scale ---------- */
console.log('== rssi band ==');
{
  eq('strong', api.rssiBand(-45), { label: '很强', cls: 'ok' });
  eq('good', api.rssiBand(-58), { label: '良好', cls: 'ok' });
  eq('fair', api.rssiBand(-66), { label: '一般', cls: 'warn' });
  eq('weak', api.rssiBand(-80), { label: '弱', cls: 'bad' });
}

console.log(failures ? `${failures} failure(s)` : '\nall parser tests passed');
process.exit(failures ? 1 : 0);
