#!/usr/bin/env node
/* Tests for the WebUI's action flow and status feedback.
 *
 * The rules this guards:
 *   - a button reports where the user can see it, from any tab;
 *   - detection is read-only: results go to the editor, never to a file;
 *   - one button applies, and nothing else changes mounted state;
 *   - a finished action must not trigger a second, invisible full refresh;
 *   - a rescan that returns the same cache says so instead of claiming success.
 *
 * Run: node tests/test-status.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'module/webroot/index.html'), 'utf8');
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const diagSrc = fs.readFileSync(path.join(ROOT, 'module/webroot/diag.js'), 'utf8');

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
global.window = global;

/* Every command the page issues, so tests can assert on the transport itself. */
const seen = [];
const capState = { json: 'survey=no\nmonitor=no\ninjection=no\n' };
const capOut = () => capState.json;

const SCAN_MASKED = 'BSSID  Frequency  RSSI  Age(sec)  SSID  Flags\n' +
  '  aa:bb:**:**:ee:01  5180  -51(0:-51/1:-56)  7.5  Home  [RSN-PSK][ESS]\n';
let scanOut = () => SCAN_MASKED;

const WPA = 'bssid / frequency / signal level / flags / ssid\n' +
  'aa:bb:cc:dd:ee:01\t5180\t-51\t[RSN-PSK-CCMP][ESS]\tHome\n';

const b64 = s => Buffer.from(s, 'utf8').toString('base64') + '\n';
const STATUS = 'WifiInfo: SSID: "Home", RSSI: -51, Link speed: 573Mbps, ' +
               'Frequency: 5180MHz, Wi-Fi standard: 11ax\n';
const MGR_STATUS = 'user=1\nentries=7\nmounted=1\ncc=US\ncur_cc=US\ntimeout=3\nthreads=8';

/* What collect.sh prints. One command, every block. */
const collect = (scan) => '##scan\n' + scan +
  '##link\n' + STATUS +
  '##route\ndefault via 192.168.1.1 dev wlan0 proto static\n' +
  '##ping\n3 packets transmitted, 3 received, 0% packet loss\n' +
  'rtt min/avg/max/mdev = 1.0/2.4/3.0/0.5 ms\n' +
  '##dns\nrc=0\n' +
  '##mac\n' + WPA;

let userHosts = '1.1.1.1\tmtalk.google.com\n';
let probeOut = '';
let logOut = '';
let applied = [];

global.ksu = {
  moduleInfo: () => JSON.stringify({ moduleDir: '/m' }),
  exec(cmd, opt, cb) {
    let out = '';
    seen.push(cmd);
    if (/probe\.log/.test(cmd)) out = logOut;
    else if (/probe\.sh/.test(cmd)) out = probeOut;
    else if (/collect\.sh scan/.test(cmd)) out = b64(scanOut());
    else if (/collect\.sh/.test(cmd)) out = b64(collect(scanOut()));
    else if (/manager\.sh status/.test(cmd)) out = MGR_STATUS;
    else if (/base64 -w0 .*user-hosts|user-hosts 2>/.test(cmd)) out = b64(userHosts);
    else if (/printf %s/.test(cmd)) { applied.push(cmd); out = 'rc=0\n'; }
    else if (/manager\.sh apply/.test(cmd)) out = '';
    else if (/capacity/.test(cmd)) out = capOut();
    else if (/manager\.sh diagnose/.test(cmd)) out = 'diag output\n';
    else if (/manager\.sh set-cc|force-country-code/.test(cmd)) out = 'cc=US\n';
    setTimeout(() => global.window[cb](0, out, ''), 0);
  }
};

/* Keep the poller's 800 ms tick from slowing the suite down. The bridge stub
   already answers on a 0 ms timer, so ordering is preserved. */
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn) => realSetTimeout(fn, 0);

let failures = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`  FAIL ${label}\n    got  ${g}\n    want ${w}`); failures++; }
}
function ok(label, cond, detail) {
  if (!cond) { console.log(`  FAIL ${label}${detail ? '\n    ' + detail : ''}`); failures++; }
}
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('condition not reached');
    await new Promise(r => realSetTimeout(r, 5));
  }
}

process.on('unhandledRejection', e => {
  console.log('  FAIL unhandled rejection:', e.stack || e.message);
  failures++;
});

/* diag.js and the page share one script scope in the packaged file, so they
   are evaluated together here too. */
eval(diagSrc + '\n' + js);

const g = id => els[id] || (els[id] = el(id));

(async () => {
  await until(() => /就绪|未取得/.test(g('status-text').textContent));

  console.log('== startup ==');
  ok('status bar visible after init', !g('status').hidden);
  eq('init reports ready', g('status-text').textContent, '就绪 · /m');
  eq('editor is the saved file', g('h-manual').value, '1.1.1.1\tmtalk.google.com\n');
  ok('one collection, not one per source',
     seen.filter(c => /collect\.sh/.test(c)).length === 1,
     seen.filter(c => /collect\.sh/.test(c)).length + ' collect calls');

  console.log('== status bar sits outside the tab sections ==');
  g('tab-hs').onclick();
  ok('bar visible after switching tabs', !g('status').hidden);
  const pageStart = html.indexOf('id="p-hs"');
  const barPos = html.indexOf('id="status"');
  ok('status bar sits outside the tab sections', barPos < pageStart,
     `bar at ${barPos}, first tab at ${pageStart}`);

  console.log('== detection appends, never writes ==');
  probeOut = '140.82.113.4\tgithub.com\n142.250.72.14\tmtalk.google.com\n';
  logOut = '[12:00:01] start domains=2 timeout=3s threads=8\n' +
           '[12:00:02] resolve github.com -> 1 ip\n' +
           '[12:00:05] ok   github.com 140.82.113.4 0.032s tls=1\n' +
           '[12:00:06] done hosts=2 candidates=3 seconds=5\n';
  const beforeProbe = seen.length;
  await g('h-probe').onclick();

  ok('probe result appended', g('h-manual').value.includes('140.82.113.4\tgithub.com'),
     g('h-manual').value);
  ok('existing entry kept', g('h-manual').value.includes('1.1.1.1\tmtalk.google.com'),
     g('h-manual').value);
  ok('existing entry not duplicated', g('h-manual').value.split('mtalk.google.com').length === 2,
     g('h-manual').value);
  ok('log pane is visible', !g('h-log').hidden);
  ok('log shows progress', /ok\s+github\.com/.test(g('h-log').textContent),
     g('h-log').textContent);
  ok('status names what was added', /1 条已追加到编辑框/.test(g('status-text').textContent),
     g('status-text').textContent);
  ok('status mentions the skipped entry', /1 条已存在未覆盖/.test(g('status-text').textContent),
     g('status-text').textContent);
  ok('detection did not touch hosts',
     !applied.some(c => /manager\.sh apply/.test(c)), applied.join(' | '));
  ok('detection does not re-read the scan',
     !seen.slice(beforeProbe).some(c => /collect\.sh/.test(c)),
     seen.slice(beforeProbe).filter(c => /collect\.sh/.test(c)).join(' | '));

  console.log('== detection with nothing reachable ==');
  const keep = g('h-manual').value;
  probeOut = '';
  logOut = '[12:00:01] start domains=2 timeout=3s threads=8\n' +
           '[12:00:02] resolve github.com -> none\n' +
           '[12:00:02] done hosts=0 candidates=0\n';
  await g('h-probe').onclick();
  ok('failure is reported', /没有可用地址/.test(g('status-text').textContent),
     g('status-text').textContent);
  ok('failure is not green', /warn|bad/.test(g('status').className), g('status').className);
  eq('editor unchanged on failure', g('h-manual').value, keep);

  console.log('== one button applies ==');
  g('h-manual').value = '9.9.9.9\tgithub.com\n';
  await g('h-save').onclick();
  const cmd = applied[applied.length - 1] || '';
  const enc = (cmd.match(/printf %s (\S+) \|/) || [])[1] || '';
  eq('editor is what gets written', Buffer.from(enc, 'base64').toString('utf8'),
     '9.9.9.9\tgithub.com\n');
  ok('apply runs after the write', /manager\.sh apply/.test(cmd), cmd);
  ok('save reports success', /已保存 1 条/.test(g('status-text').textContent),
     g('status-text').textContent);

  console.log('== rescan tells the truth ==');
  await g('btn-scan').onclick();
  ok('stale rescan is reported as stale', /没有回来新结果/.test(g('status-text').textContent),
     g('status-text').textContent);

  scanOut = () => 'BSSID  Frequency  RSSI  Age(sec)  SSID  Flags\n' +
    '  aa:bb:**:**:ee:01  5180  -51(0:-51/1:-56)  0.4  Home  [RSN-PSK][ESS]\n';
  await g('btn-scan').onclick();
  ok('fresh rescan is reported as done', /扫描完成：最新条目 0\.4 秒/.test(g('status-text').textContent),
     g('status-text').textContent);

  console.log('== multibyte ssid survives the bridge ==');
  ok('scan is read through base64',
     seen.some(c => /collect\.sh/.test(c) && /base64/.test(c)),
     seen.filter(c => /collect\.sh/.test(c)).join(' | '));

  scanOut = () => 'BSSID  Frequency  RSSI  Age(sec)  SSID  Flags\n' +
    '  68:19:**:**:37:c3  5785  -58(0:-59/1:-63)  10.1  华科  [RSN-PSK][ESS]\n' +
    '  68:19:**:**:37:c2  5785  -58(0:-59/1:-63)  10.1  咖啡馆 5G  [RSN-PSK][ESS]\n';
  await g('btn-scan').onclick();
  const apHtml = g('ap-groups').innerHTML;
  ok('chinese ssid renders intact', apHtml.includes('华科'), apHtml.slice(0, 200));
  ok('chinese ssid with space intact', apHtml.includes('咖啡馆 5G'), apHtml.slice(0, 200));
  ok('no replacement glyphs', !/\ufffd/.test(apHtml), apHtml.slice(0, 200));

  console.log('== hardware capability ==');
  capState.json = 'soc=SM8650\nhardware=qcom\ndriver=qcacld\n' +
    'survey=no\nnoise=none\nmonitor=no\ninjection=no\nexternal_adapter=no\n';
  await g('btn-cap').onclick();
  eq('survey shown as unsupported', g('cap-survey').textContent, '不支持');
  eq('monitor shown as unsupported', g('cap-mon').textContent, '不支持');
  eq('injection shown as unsupported', g('cap-inj').textContent, '不支持');
  ok('driver line names the soc', g('cap-drv').textContent.includes('qcacld'),
     g('cap-drv').textContent);
  ok('nothing supported is reported honestly',
     /无法给出噪声\/频谱/.test(g('status-text').textContent), g('status-text').textContent);

  capState.json = 'soc=SM8650\ndriver=qcacld\nsurvey=yes\nsurvey_channels=38\n' +
    'monitor=no\ninjection=no\nexternal_adapter=no\n';
  await g('btn-cap').onclick();
  eq('survey carries the channel count', g('cap-survey').textContent, '支持（38 个信道）');
  eq('survey is green when supported', g('cap-survey').className, 'v ok');

  capState.json = 'soc=SM8650\ndriver=bcmdhd\nsurvey=unknown\nmonitor=yes\n' +
    'monitor_creatable=no\ninjection=no\nexternal_adapter=yes\n';
  await g('btn-cap').onclick();
  eq('claimed but unusable monitor is called out',
     g('cap-mon').textContent, '声明支持，但建不出接口');
  eq('claimed monitor is red', g('cap-mon').className, 'v bad');
  eq('external adapter detected', g('cap-ext').textContent, '已连接');
  eq('survey unknown is not a yes', g('cap-survey').textContent, '未确认');

  console.log('== failure is visible, not silent ==');
  g('c-input').value = 'X';
  await g('c-set').onclick();
  ok('invalid code is reported', /两位国家码/.test(g('status-text').textContent),
     g('status-text').textContent);

  console.log(failures ? `\n${failures} failure(s)` : '\nall status-bar tests passed');
  process.exit(failures ? 1 : 0);
})();
