#!/usr/bin/env node
/* Tests for the WebUI status bar.
 *
 * The bug this guards against: every button reported into a <pre> that only
 * existed inside the country-code tab, so pressing "探测并应用" on the hosts
 * tab produced no visible feedback at all. Then, after the global bar was
 * added, refreshAll() overwrote the result from busy()'s finally block
 * ("探测完成：5/12" turned into "就绪").
 *
 * Run: node tests/test-status.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'module/webroot/index.html'), 'utf8');
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];

/* Minimal DOM: just enough that the page's own code can run unmodified. */
function el(id) {
  return {
    id, textContent: '', className: '', value: '', checked: false, disabled: false,
    hidden: false, style: {}, innerHTML: '', onclick: null, onchange: null,
    classList: { _s: new Set(), toggle(c, f) { f ? this._s.add(c) : this._s.delete(c); },
                 contains(c) { return this._s.has(c); } }
  };
}
const els = {};
global.document = { getElementById: id => els[id] || (els[id] = el(id)) };
global.btoa = s => Buffer.from(s, 'binary').toString('base64');
global.atob = b => Buffer.from(b, 'base64').toString('binary');
global.unescape = s => decodeURIComponent(s.replace(/%([0-9A-F]{2})/g, (m, p) => '%' + p));
global.escape = s => s;
global.window = global;
/* The probe ticker uses setInterval; tests are synchronous, so disable it. */
global.setInterval = () => 0;
global.clearInterval = () => {};

/* The framework redacts the middle two octets on Android 12+, so this is the
   shape the page actually receives. The real address is in WPA below. */
const SCAN_MASKED = 'BSSID  Frequency  RSSI  Age(sec)  SSID  Flags\n' +
  '  aa:bb:**:**:ee:01  5180  -51(0:-51/1:-56)  7.5  Home  [RSN-PSK][ESS]\n';

/* Mutable so the "rescan" test can hand back a fresher cache. */
let scanOut = () => SCAN_MASKED;

/* wpa_supplicant's table: the real BSSID for the same radio. The framework
   hands the page a redacted address, and this is where the true one comes from. */
const WPA = 'bssid / frequency / signal level / flags / ssid\n' +
  'aa:bb:cc:dd:ee:01\t5180\t-51\t[RSN-PSK-CCMP][ESS]\tHome\n';

/* The page reads scan/status through `| base64` so multibyte SSIDs survive.
   The stub has to answer in the same shape, or every test sees an empty scan. */
const b64 = s => Buffer.from(s, 'utf8').toString('base64') + '\n';
const STATUS = 'WifiInfo: SSID: "Home", RSSI: -51, Link speed: 573Mbps, ' +
               'Frequency: 5180MHz, Wi-Fi standard: 11ax\n';
const MGR_STATUS = 'probed=5\nuser=1\nentries=6\nmounted=1\ncc=US\ncur_cc=US\n' +
                   'use_probed=1\ntimeout=3\nthreads=8';

let probeOut = 'pairs=12\ntimeout=3\nthreads=8\ntried=12\nok=5\n';
/* Every command the page issues, so tests can assert on the transport itself
   and not only on the parsed result. */
const seen = [];

global.ksu = {
  moduleInfo: () => JSON.stringify({ moduleDir: '/m' }),
  exec(cmd, opt, cb) {
    let out = 'ok\n';
    seen.push(cmd);
    /* Commands the page wraps in `| base64` must answer encoded. */
    if (cmd.includes('list-scan-results')) out = b64(scanOut());
    else if (cmd.includes('base64')) out = b64('');
    else if (cmd.includes('scan_results')) out = b64(WPA);
    else if (cmd.includes('cmd wifi status')) out = b64(STATUS);
    else if (cmd.includes('ip route')) out = 'default via 192.168.1.1 dev wlan0\n';
    else if (cmd.includes('ping -c 5'))
      out = '5 packets transmitted, 5 packets received, 0% packet loss\n' +
            'rtt min/avg/max/mdev = 1.2/2.4/3.6/0.8 ms\n';
    else if (cmd.includes('ping -c 1')) out = '0\n';
    else if (cmd.includes('manager.sh status')) out = MGR_STATUS;
    else if (cmd.includes('grep -cvE')) out = '12\n';
    else if (cmd.includes('probe.sh')) out = probeOut;
    setTimeout(() => global.window[cb](0, out, ''), 0);
  }
};

let failures = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`  FAIL ${label}\n    got  ${g}\n    want ${w}`); failures++; }
}
function ok(label, cond, detail) {
  if (!cond) { console.log(`  FAIL ${label}${detail ? '\n    ' + detail : ''}`); failures++; }
}

process.on('unhandledRejection', e => {
  console.log('  FAIL unhandled rejection:', e.message);
  failures++;
});

eval(js);

const g = id => els[id];

setTimeout(async () => {
  console.log('== startup ==');
  ok('status bar visible after init', !g('status').hidden);
  eq('init reports ready', g('status-text').textContent, '就绪 · /m');

  console.log('== visible from another tab ==');
  /* The original bug: the detail pane lived inside #p-cc, so a button on the
     hosts tab wrote where nothing could be seen. The bar must be outside every
     .page container. */
  g('tab-hs').onclick();
  ok('bar visible after switching tabs', !g('status').hidden);
  const pageStart = html.indexOf('id="p-hs"');
  const barPos = html.indexOf('id="status"');
  ok('status bar sits outside the tab sections', barPos < pageStart,
     `bar at ${barPos}, first tab at ${pageStart}`);

  console.log('== probe reports a result, not raw stdout ==');
  g('h-timeout').value = '3'; g('h-threads').value = '8';
  await g('h-onlyprobe').onclick();
  ok('probe result survives refreshAll',
     /探测完成：5 \/ 12/.test(g('status-text').textContent),
     g('status-text').textContent);
  eq('probe result is ok-coloured', g('status').className, 'status ok');
  /* The raw script output belongs in the detail pane, not the status bar. */
  ok('status is not the raw pairs= line', !/^pairs=/.test(g('status-text').textContent),
     g('status-text').textContent);

  console.log('== probe with nothing reachable ==');
  probeOut = 'pairs=12\ntimeout=3\nthreads=8\ntried=12\nok=0\n';
  await g('h-onlyprobe').onclick();
  ok('total failure is reported as a failure',
     /12 个候选全部不可达/.test(g('status-text').textContent), g('status-text').textContent);
  ok('total failure is red or warn-coloured',
     /bad|warn/.test(g('status').className), g('status').className);

  /* Zero candidates is a different failure: nothing was even resolved, so
     "raise the timeout" is the wrong advice and chasing it wastes the user's
     time. This is the case that was reported as "0 个候选全部不可达". */
  probeOut = 'pairs=0\nnohost=12\ntimeout=3\nthreads=8\ntried=0\nok=0\n';
  await g('h-onlyprobe').onclick();
  ok('no candidates names the resolver',
     /一个地址都没解析出来/.test(g('status-text').textContent),
     g('status-text').textContent);
  ok('no candidates does not blame the timeout',
     !/加大超时/.test(g('status-text').textContent), g('status-text').textContent);
  ok('no candidates is red', /bad/.test(g('status').className), g('status').className);

  console.log('== other actions ==');
  g('c-input').value = 'JP';
  await g('c-set').onclick();
  ok('country code result', /国家码已设为 JP/.test(g('status-text').textContent),
     g('status-text').textContent);

  await g('h-remount').onclick();
  ok('remount result', /已重新挂载/.test(g('status-text').textContent),
     g('status-text').textContent);

  /* A rescan that returns the same cache must say so. Reporting "扫描完成" after
     a fixed sleep was the bug: the freshness row never moved and the button
     looked like it did nothing. */
  await g('btn-scan').onclick();
  ok('stale rescan is reported as stale', /没有回来新结果/.test(g('status-text').textContent),
     g('status-text').textContent);

  /* ...and a rescan that really lands fresh entries reports success. */
  scanOut = () => 'BSSID  Frequency  RSSI  Age(sec)  SSID  Flags\n' +
    '  aa:bb:**:**:ee:01  5180  -51(0:-51/1:-56)  0.4  Home  [RSN-PSK][ESS]\n';
  await g('btn-scan').onclick();
  ok('fresh rescan is reported as done', /扫描完成：最新条目 0\.4 秒/.test(g('status-text').textContent),
     g('status-text').textContent);

  console.log('== multibyte ssid survives the bridge ==');
  /* The bridge decodes as Latin-1, so a Chinese SSID used to reach the page as
     its first character plus mojibake. The page must ask for base64 and decode
     once; a plain `cmd wifi ...` read cannot represent these bytes. */
  ok('scan is read through base64',
     seen.some(c => /list-scan-results/.test(c) && /base64/.test(c)),
     seen.filter(c => /list-scan-results/.test(c)).join(' | '));
  ok('status is read through base64',
     seen.some(c => /cmd wifi status/.test(c) && /base64/.test(c)),
     seen.filter(c => /cmd wifi status/.test(c)).join(' | '));

  scanOut = () => 'BSSID  Frequency  RSSI  Age(sec)  SSID  Flags\n' +
    '  68:19:**:**:37:c3  5785  -58(0:-59/1:-63)  11.1  华科  [RSN-PSK][ESS]\n' +
    '  68:19:**:**:37:c2  5785  -58(0:-59/1:-63)  11.1  咖啡馆 5G  [RSN-PSK][ESS]\n';
  await g('btn-scan').onclick();
  const apHtml = g('ap-groups').innerHTML;
  ok('chinese ssid renders intact', apHtml.includes('华科'), apHtml.slice(0, 200));
  ok('chinese ssid with space intact', apHtml.includes('咖啡馆 5G'), apHtml.slice(0, 200));
  ok('no replacement glyphs', !/\ufffd/.test(apHtml), apHtml.slice(0, 200));

  console.log('== failure is visible, not silent ==');
  g('c-input').value = 'X';
  await g('c-set').onclick();
  ok('invalid code is reported', /两位国家码/.test(g('status-text').textContent),
     g('status-text').textContent);

  console.log(failures ? `\n${failures} failure(s)` : '\nall status-bar tests passed');
  process.exit(failures ? 1 : 0);
}, 800);