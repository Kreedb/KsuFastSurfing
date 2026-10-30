#!/usr/bin/env node
/* Tests for the WebUI's action flow, with no shell script in the path.
 *
 * The rules this guards:
 *   - every command the page runs appears in the console tab;
 *   - the page never executes a module .sh: all measurement and all state
 *     changes are plain Android commands issued from the page;
 *   - detection is read-only: results go to the editor, never to a file;
 *   - one button writes user-hosts, merges hosts in JS, and mounts;
 *   - the country code is written to config + system.prop and applied;
 *   - a finished action must not trigger a second, invisible full refresh;
 *   - there is no scan trigger left, and the AP list is on the overview.
 *
 * Run: node tests/test-status.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'module/webroot/index.html'), 'utf8');
const js = html.match(/<script>\n(const \$ =[\s\S]*?)\n<\/script>/)[1];
const diagSrc = fs.readFileSync(path.join(ROOT, 'module/webroot/diag.js'), 'utf8');

/* Minimal DOM: just enough that the page's own code can run unmodified. */
function el(id) {
  return {
    id, textContent: '', className: '', value: '', checked: false, disabled: false,
    hidden: false, style: {}, innerHTML: '', onclick: null, onchange: null,
    focus() {}, scrollIntoView() {},
    classList: { _s: new Set(), toggle(c, f) { f ? this._s.add(c) : this._s.delete(c); },
                 contains(c) { return this._s.has(c); } }
  };
}
const els = {};
global.document = { getElementById: id => els[id] || (els[id] = el(id)) };
global.btoa = s => Buffer.from(s, 'binary').toString('base64');
global.atob = b => Buffer.from(b, 'base64').toString('binary');
global.window = global;

const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); }
};

/* ---------- device state the mock answers from ---------- */
const HDR = 'BSSID              Frequency      RSSI           Age(sec)     SSID                                 Flags\n';
const SCAN = HDR +
  '  68:19:aa:bb:cc:01  5180  -51(0:-51/1:-56)  7.5  Home  [RSN-PSK][ESS]\n' +
  '  68:19:aa:bb:cc:02  5745  -66(0:-66/1:-71)  7.5  咖啡馆 5G  [RSN-PSK][ESS]\n';
const LINK = 'WifiInfo: SSID: "Home", RSSI: -51, Link speed: 573Mbps, ' +
             'Frequency: 5180MHz, Wi-Fi standard: 11ax\n';
const ROUTE = 'default via 192.168.1.1 dev wlan0 proto static\n' +
              '192.168.1.0/24 dev wlan0 proto kernel scope link src 192.168.1.5\n';
const PING = '3 packets transmitted, 3 received, 0% packet loss, time 400ms\n' +
             'rtt min/avg/max/mdev = 1.0/2.4/3.0/0.5 ms\n';

const state = {
  scan: SCAN,
  link: LINK,
  route: ROUTE,
  ping: PING,
  dns: 'rc=0\n',
  curCC: 'Wifi Country Code: US\n',
  userHosts: '1.1.1.1\tmtalk.google.com\n',
  hosts: '# KsuFastSurfing - seed\n\n127.0.0.1\tlocalhost\n' +
         '::1\tlocalhost ip6-localhost ip6-loopback\n',
  sysHosts: '# android stock hosts\n',
  config: 'CC=US\n',
  systemProp: '',
  domains: 'github.com\nmtalk.google.com\n',
  mounted: false,
  cmds: [],
  writes: []
};

const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');
const strip = cmd => {
  const m = cmd.match(/^\(([\s\S]*)\) 2>&1 \| base64$/);
  return m ? [m[1], true] : [cmd, false];
};

const FILES = {
  '/m/user-hosts': 'userHosts',
  '/m/hosts': 'hosts',
  '/system/etc/hosts': 'sysHosts',
  '/m/config': 'config',
  '/m/system.prop': 'systemProp',
  '/m/domains': 'domains'
};

function answer(cmd) {
  const [x, wrapped] = strip(cmd);
  const B = s => (wrapped ? b64(s) : s);

  if (/^base64 -w0 '([^']+)'/.test(cmd)) {
    const f = cmd.match(/^base64 -w0 '([^']+)'/)[1];
    return b64(FILES[f] ? state[FILES[f]] : '');
  }

  /* writeFile() funnels every text write into printf|base64 -d. */
  const w = x.match(/printf %s (\S*) \| base64 -d > '([^']+)'/);
  if (w) {
    const body = Buffer.from(w[1], 'base64').toString('utf8');
    state.writes.push({ path: w[2], body });
    const key = FILES[w[2]];
    if (key) state[key] = body;
    return 'write=ok\n';
  }

  if (/cmd wifi list-scan-results/.test(x)) return B(state.scan);
  if (/cmd wifi status/.test(x)) return B(state.link);
  if (/^ip route/.test(x)) return B(state.route);
  if (/^ping -c 3/.test(x)) return B(state.ping);
  /* the outbound check is one HTTPS GET to the echo page; it answers in GBK */
  if (/only-[a-z0-9]{32}\.nstool\.laiqukankan\.com/.test(x)) {
    /* Real bytes from the server: content-type says GBK, so the base64 below is
       GBK-encoded text, not UTF-8. Anything that decodes it as UTF-8 produces
       mojibake and the labels stop matching. */
    return 'xPq6w6Os1/C+tLXEzfjS19PDu6c8YnI+xPq1xElQtdjWt9DFz6I6IDM5Ljk2LjE5'
         + 'LjEyNSCxsb6pytA8YnI+xPq1xEROU7XY1rfQxc+iOiAzOS4xMDMuMjYuMjI5ILGxvqnK'
         + '0Dxicj7E+rXERE5TyejWw9X9yLc=';
  }
  if (/ip addr show dev/.test(x)) return B(
    '2: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP\n' +
    '    link/ether aa:bb:cc:dd:ee:ff brd ff:ff:ff:ff:ff:ff\n' +
    '    inet 192.168.1.13/24 brd 192.168.1.255 scope global wlan0\n');
  if (/cmd wifi get-country-code/.test(x)) return B(state.curCC);
  if (/^mount 2>\/dev\/null \| grep ' \/system\/etc\/hosts '/.test(x))
    return B(state.mounted ? '/m/hosts on /system/etc/hosts type none (rw,seclabel,bind)\n' : '');
  if (/grep -c 'WCNSS_qcom_cfg'/.test(x)) return B('0\n');
  if (/^\[ -e '([^']+)' \] && readlink -f/.test(x))
    return B(x.match(/'([^']+)'/)[1] + '\n');
  if (/mount -o bind/.test(x)) { state.mounted = true; return B('mounted=1\n'); }
  if (/^umount/.test(x)) return B('');
  if (/^chmod /.test(x)) return B('');

  /* DNS: one shell, N backgrounded subshells. Each prints a hex reply on its
     own line; two distinct A records come back per reply. */
  if (/wait \$p/.test(x) && /burst=/.test(x)) {
    const n = +((x.match(/burst=(\d+)/) || [])[1] || 1);
    const reply = '12348180000100020000000006676f6f676c6503636f6d0000010001' +
                  'c00c000100010000012c0004' + 'd04320c8' +
                  'c00c000100010000012c0004' + 'd04320ad';
    return B('R' + reply + '\n'.repeat(1) +
             Array.from({ length: n - 1 }, () => 'R' + reply).join('\n') +
             '\nburst=' + n + '\n');
  }

  /* probe */
  if (/ping -c 1 -W 1 '([^']+)'/.test(x) && /getent ahosts/.test(x)) {
    const host = x.match(/ping -c 1 -W 1 '([^']+)'/)[1];
    return B(host === 'github.com' ? '140.82.113.4\n' : '142.250.72.14\n');
  }
  /* DoH is queried alongside the system lookup, not as a fallback: it is the
     only source that returns the whole A set. */
  if (/cloudflare-dns\.com/.test(x)) {
    const name = decodeURIComponent((x.match(/name=([^&']+)/) || [])[1] || '');
    const set = name === 'github.com'
      ? ['140.82.113.4', '140.82.112.4']
      : ['142.250.72.14', '142.250.73.14'];
    return B(JSON.stringify({ Answer: set.map(d => ({ type: 1, data: d })) }));
  }
  if (/dns\.google/.test(x)) return B(JSON.stringify({ Answer: [] }));
  if (/command -v curl/.test(x)) return B('yes\n');
  if (/curl .*--resolve/.test(x)) return B('0.032 0.081\n');

  /* country code */
  if (/force-country-code enabled/.test(x)) return B('');
  if (/force-country-code disabled/.test(x)) return B('');
  if (/^command -v resetprop/.test(x)) return B('rc=0\n');
  if (/iw reg set/.test(x)) return B('');

  /* diagnose */
  if (/dumpsys wifi/.test(x)) return B('Current Country Code: US\n');
  if (/settings get global wifi_country_code/.test(x)) return B('US\n');
  if (/^\[ -r '.*' \] && grep/.test(x)) return B('');

  /* capacity */
  if (/^getprop ro\.soc\.model/.test(x)) return B('SM8650\n\nqcom\n');
  if (/ls -d \/sys\/module/.test(x)) return B('/sys/module/qcacld\n');
  if (/ls \/sys\/class\/net/.test(x)) return B('wlan0 p2p0 \n');
  if (/ls -d \/sys\/class\/ieee80211/.test(x)) return B('1\n');
  if (/command -v iw/.test(x)) return B('');
  if (/find \/sys\/kernel\/debug\/ieee80211.*survey/.test(x)) return B('0\n');
  if (/find \/sys\/kernel\/debug\/ieee80211.*interface_modes/.test(x)) return B('');
  if (/nexmon/.test(x)) return B('');
  if (/for d in \/sys\/class\/net\/\*\/device/.test(x)) return B('');

  return B('');
}

global.ksu = {
  moduleInfo: () => JSON.stringify({ moduleDir: '/m' }),
  exec(cmd, opt, cbName) {
    /* KernelSU takes the callback *name*, not a function. */
    state.cmds.push(cmd);
    const slow = state.slowCurl && /--resolve/.test(cmd) ? 150 : 0;
    realSetTimeout(() => global.window[cbName](0, answer(cmd), ''), slow);
  }
};

/* Keep the console's 60 ms flush and the poller's 800 ms tick from slowing the
   suite down. The bridge stub already answers on a 0 ms timer. */
const realSetTimeout = global.setTimeout;
/* Speed up the poll/flush timers, but leave the 120 s exec timeout at its real
   scale: speeding that one up makes every command reject before its callback
   runs. */
global.setTimeout = (fn, ms) => realSetTimeout(fn, ms < 5000 ? 0 : ms);

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
  await until(() => /就绪|未取得|未检测/.test(g('status-text').textContent));

  const src = fs.readFileSync(path.join(ROOT, 'module/webroot/index.html'), 'utf8');

  console.log('== startup ==');
  ok('status bar visible after init', !g('status').hidden);
  eq('init reports ready', g('status-text').textContent, '就绪 · /m');
  eq('editor is the saved file', g('h-manual').value, '1.1.1.1\tmtalk.google.com\n');
  eq('entries come from the merged file', g('h-entries').textContent, '0 条');
  eq('unmounted stock hosts is reported', g('h-mount').textContent, '未挂载');
  ok('scan was read directly', state.cmds.some(c => /cmd wifi list-scan-results/.test(c)),
     state.cmds.slice(0, 8).join(' | '));

  console.log('== gateway, mask and routes ==');
  eq('local address carries its prefix', g('n-addr').textContent, '192.168.1.13/24');
  eq('gateway is printed', g('n-gw').textContent, '192.168.1.1');
  eq('mask is derived from the prefix', g('n-mask').textContent, '255.255.255.0');
  ok('route rows are rendered', /default/.test(g('n-routes').innerHTML) &&
     /192\.168\.1\.1/.test(g('n-routes').innerHTML), g('n-routes').innerHTML);
  const routeHtml = g('n-routes').innerHTML;
  ok('the default route sorts first',
     routeHtml.indexOf('default') < routeHtml.indexOf('192.168.1.0/24'), routeHtml);

  console.log('== outbound identity ==');
  eq('egress ip from the echo page', g('n-cip').textContent, '39.96.19.125');
  eq('resolver ip from the echo page', g('n-dip').textContent, '39.103.26.229');
  eq('dns verdict from the echo page', g('n-dns').textContent, '正确');
  ok('the gbk page was decoded', !/\ufffd/.test(g('n-cip').textContent), g('n-cip').textContent);

  console.log('== hosts: read-only mirror and editor ==');
  g('h-editbox').hidden = true;        /* the attribute in the HTML */
  g('h-edit').textContent = '编辑';
  await loadStatus();
  ok('the effective file is shown read-only', /# android stock hosts/.test(g('h-view').textContent),
     g('h-view').textContent);
  eq('the editor starts collapsed', g('h-editbox').hidden, true);
  g('h-edit').onclick();
  eq('the editor opens on demand', g('h-editbox').hidden, false);
  eq('the button becomes a collapse control', g('h-edit').textContent, '收起');

  console.log('== dns burst and diagnosis are gone ==');
  ok('no dns card', !/id="d-run"/.test(src) && !/id="d-host"/.test(src));
  ok('no diagnosis button', !/id="c-diag"/.test(src));
  ok('no detail panel', !/id="out"/.test(src));
  ok('nothing issues nc', !state.cmds.some(c => /nc -u/.test(c)),
     state.cmds.filter(c => /nc -u/.test(c)).join('\n'));

  console.log('== one button writes and mounts ==');
  g('h-manual').value = '9.9.9.9\tgithub.com\n9.9.9.9\tgithub.com\n';
  await g('h-save').onclick();
  const uh = state.writes.filter(w => w.path === '/m/user-hosts').pop();
  const hs = state.writes.filter(w => w.path === '/m/hosts').pop();
  const sy = state.writes.filter(w => w.path === '/m/system/etc/hosts').pop();
  eq('editor is written verbatim', uh.body, '9.9.9.9\tgithub.com\n9.9.9.9\tgithub.com\n');
  ok('merged file has the entry once',
     (hs.body.match(/9\.9\.9\.9\tgithub\.com/g) || []).length === 1, hs.body);
  ok('both copies are the same file', sy.body === hs.body, sy.body);
  ok('the merged file still starts with the header', hs.body.startsWith('# Generated '), hs.body);
  ok('mount ran', state.cmds.some(c => /mount -o bind/.test(c)), 'no mount command');
  eq('one entry in effect', g('h-entries').textContent, '1 条');
  eq('mount state read back', g('h-mount').textContent, '已挂载');
  ok('save reports success', /已保存 2 条并重新挂载/.test(g('status-text').textContent),
     g('status-text').textContent);

  console.log('== country code is written and applied ==');
  g('c-input').value = 'jp';
  await g('c-set').onclick();
  ok('config keeps the key', /^CC=JP$/m.test(state.config), state.config);
  ok('system.prop has all four keys',
     ['ro.boot.wificountrycode=JP', 'ro.product.wifi.country=JP',
      'persist.sys.wifi.countrycode=JP', 'ro.wifi.country_code=JP']
       .every(l => state.systemProp.includes(l)), state.systemProp);
  ok('resetprop was called', state.cmds.some(c => /resetprop -n ro\.boot\.wificountrycode JP/.test(c)),
     'no resetprop');
  ok('runtime API was called', state.cmds.some(c => /cmd wifi force-country-code enabled JP/.test(c)),
     'no force-country-code');
  ok('cache is updated', g('c-want').textContent === 'JP', g('c-want').textContent);
  ok('success is reported', /国家码已设为 JP/.test(g('status-text').textContent),
     g('status-text').textContent);

  console.log('== there is no scan trigger any more ==');
  ok('no scan command is ever issued',
     !state.cmds.some(c => /start-scan|wifi_scan_throttle|iw dev .* scan|svc wifi/.test(c)),
     state.cmds.filter(c => /scan|svc wifi/.test(c)).join('\n'));

  console.log('== AP list lives on the overview ==');
  ok('the 信道 tab is gone', !/id="tab-ap"/.test(src) && !/id="p-ap"/.test(src));
  ok('the strongest-AP card is gone', !/id="o-best"/.test(src));
  ok('the AP list is on the overview page',
     src.indexOf('id="ap-groups"') < src.indexOf('id="p-hs"'));

  /* Default order is signal: the group with the loudest radio first, and the
     rows inside a group the same way. */
  state.scan = HDR +
    '  11:11:11:11:11:11  2412  -80(0:-80/1:-80)  3.0  Low   [RSN-PSK][ESS]\n' +
    '  22:22:22:22:22:22  5180  -40(0:-40/1:-40)  3.0  High  [RSN-PSK][ESS]\n' +
    '  33:33:33:33:33:33  5745  -60(0:-60/1:-60)  3.0  Mid   [RSN-PSK][ESS]\n';
  await refreshAll();
  const order = g('ap-groups').innerHTML;
  ok('the strongest network is listed first',
     order.indexOf('High') >= 0 && order.indexOf('High') < order.indexOf('Mid') &&
     order.indexOf('Mid') < order.indexOf('Low'),
     order.slice(0, 300));

  console.log('== multibyte ssid survives the bridge ==');
  state.scan = HDR +
    '  68:19:**:**:37:c3  5785  -58(0:-59/1:-63)  10.1  华科  [RSN-PSK][ESS]\n' +
    '  68:19:**:**:37:c2  5785  -58(0:-59/1:-63)  10.1  咖啡馆 5G  [RSN-PSK][ESS]\n';
  await refreshAll();
  const apHtml = g('ap-groups').innerHTML;
  ok('chinese ssid renders intact', apHtml.includes('华科'), apHtml.slice(0, 200));
  ok('chinese ssid with space intact', apHtml.includes('咖啡馆 5G'), apHtml.slice(0, 200));
  ok('no replacement glyphs', !/\ufffd/.test(apHtml), apHtml.slice(0, 200));
  ok('the redacted address is shown as delivered', apHtml.includes('68:19:**:**:37:c3'),
     apHtml.slice(0, 200));

  /* No supplicant path is left: `wpa_cli` burns ten seconds per call on the AIDL
     supplicant and never answers, so the page does not ask at all. */
  ok('nothing consults wpa_cli', !state.cmds.some(c => /wpa_cli/.test(c)),
     state.cmds.filter(c => /wpa_cli/.test(c)).join('\n'));

  console.log('== failure is visible, not silent ==');
  g('c-input').value = 'X';
  await g('c-set').onclick();
  ok('invalid code is reported', /两位国家码/.test(g('status-text').textContent),
     g('status-text').textContent);

  console.log('== console stays bounded ==');
  ok('console still counts commands', /^\d+ 命令 · 0 失败$/.test(g('con-count').textContent),
     g('con-count').textContent);
  ok('console is non-empty', g('con').textContent.length > 200, 'console empty');

  console.log(failures ? `\n${failures} failure(s)` : '\nall status-bar tests passed');
  process.exit(failures ? 1 : 0);
})();
