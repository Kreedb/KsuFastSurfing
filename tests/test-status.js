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

const SCAN = 'BSSID  Frequency  RSSI  Age(sec)  SSID  Flags\n' +
  '  aa:bb:cc:dd:ee:01  5180  -51(0:-51/1:-56)  3.0  Home  [RSN-PSK][ESS]\n';
const STATUS = 'WifiInfo: SSID: "Home", RSSI: -51, Link speed: 573Mbps, ' +
               'Frequency: 5180MHz, Wi-Fi standard: 11ax\n';
const MGR_STATUS = 'probed=5\nuser=1\nentries=6\nmounted=1\ncc=US\ncur_cc=US\n' +
                   'use_probed=1\ntimeout=3\nthreads=8';

let probeOut = 'pairs=12\ntimeout=3\nthreads=8\ntried=12\nok=5\n';

global.ksu = {
  moduleInfo: () => JSON.stringify({ moduleDir: '/m' }),
  exec(cmd, opt, cb) {
    let out = 'ok\n';
    if (cmd.includes('list-scan-results')) out = SCAN;
    else if (cmd.includes('cmd wifi status')) out = STATUS;
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

  console.log('== other actions ==');
  g('c-input').value = 'JP';
  await g('c-set').onclick();
  ok('country code result', /国家码已设为 JP/.test(g('status-text').textContent),
     g('status-text').textContent);

  await g('h-remount').onclick();
  ok('remount result', /已重新挂载/.test(g('status-text').textContent),
     g('status-text').textContent);

  await g('btn-scan').onclick();
  ok('scan result', /扫描完成/.test(g('status-text').textContent),
     g('status-text').textContent);

  console.log('== failure is visible, not silent ==');
  g('c-input').value = 'X';
  await g('c-set').onclick();
  ok('invalid code is reported', /两位国家码/.test(g('status-text').textContent),
     g('status-text').textContent);

  console.log(failures ? `\n${failures} failure(s)` : '\nall status-bar tests passed');
  process.exit(failures ? 1 : 0);
}, 800);