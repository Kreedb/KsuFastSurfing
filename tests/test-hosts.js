#!/usr/bin/env node
/* Tests for the in-page hosts merge.
 *
 * The page is now the only writer of user-hosts and of the merged file, so the
 * rules that used to live in manager.sh's awk live in diag.js. This suite
 * guards the ones that broke before:
 *
 *   - an all-comment input must not leave a half-written section header;
 *   - a hostname on two lines keeps the first address, and appears once;
 *   - several hostnames on one line each get their own line;
 *   - a non-address first column is dropped, not written to /system/etc/hosts;
 *   - countHosts() reports what survived, so "3 lines in, 2 in effect" is
 *     visible instead of silent.
 *
 * Run: node tests/test-hosts.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'module/webroot/diag.js'), 'utf8');

const api = new Function('exec', src + `
  return { mergeHosts, countHosts, setKV, parseCC };
`)(async () => ({ stdout: '', stderr: '', errno: 0 }));

let failures = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`  FAIL ${label}\n    got  ${g}\n    want ${w}`); failures++; }
}
function ok(label, cond, detail) {
  if (!cond) { console.log(`  FAIL ${label}${detail ? '\n    ' + detail : ''}`); failures++; }
}

const WHEN = '2026-10-30 12:00:00';
const body = t => t.split('\n').filter(l => l && !/^#/.test(l));

/* ---------- 1. empty input ---------- */
console.log('== empty input ==');
{
  const m = api.mergeHosts('', WHEN);
  eq('loopback present', body(m), ['127.0.0.1\tlocalhost', '::1\tlocalhost ip6-localhost ip6-loopback']);
  ok('no empty user section', !/^# --- /m.test(m), m);
  eq('nothing counted', api.countHosts(m), 0);
}

/* ---------- 2. first line wins, one entry per name ---------- */
console.log('== dedup ==');
{
  const m = api.mergeHosts('9.9.9.9\tgithub.com\n8.8.8.8\tgithub.com\n', WHEN);
  const lines = m.split('\n').filter(l => /\bgithub\.com\b/.test(l));
  eq('appears once', lines.length, 1);
  eq('first address wins', lines[0], '9.9.9.9\tgithub.com');
  eq('one entry in effect', api.countHosts(m), 1);
  ok('section header present', /^# --- user entries ---$/m.test(m), m);
}

/* ---------- 3. several names on one line ---------- */
console.log('== multi-name line ==');
{
  const m = api.mergeHosts('1.2.3.4  a.example  b.example\n', WHEN);
  const names = m.split('\n').filter(l => /example/.test(l)).map(l => l.split('\t')[1]);
  eq('both names written', names, ['a.example', 'b.example']);
  eq('counted twice', api.countHosts(m), 2);
}

/* ---------- 4. comments, blanks, invalid columns ---------- */
console.log('== junk ==');
{
  const m = api.mergeHosts(
    '# a comment\n' +
    '\n' +
    '   \n' +
    'not-an-ip example.com\n' +
    '1.2.3.4\t# only a comment\n' +
    '5.6.7.8\tgood.example # trailing note\n' +
    '\t\n', WHEN);
  eq('only the valid entry survives', body(m), [
    '127.0.0.1\tlocalhost',
    '::1\tlocalhost ip6-localhost ip6-loopback',
    '5.6.7.8\tgood.example'
  ]);
  eq('inline comment ran the loop to a stop', api.countHosts(m), 1);
}

/* ---------- 5. IPv6 ---------- */
console.log('== ipv6 ==');
{
  const m = api.mergeHosts('2001:db8::1\tv6.example\n::1\tloopback.example\n', WHEN);
  ok('global v6 kept', m.includes('2001:db8::1\tv6.example'), m);
  ok('user ::1 kept in file', m.includes('::1\tloopback.example'), m);
  /* countHosts excludes loopback addresses regardless of the name: those lines
     are infrastructure, not user entries. */
  eq('loopback not counted', api.countHosts(m), 1);
}

/* ---------- 6. whitespace and duplicates across mixed separators ---------- */
console.log('== separators ==');
{
  const m = api.mergeHosts('1.1.1.1   one.example\n1.1.1.1\tone.example\n2.2.2.2\t two.example \n', WHEN);
  eq('dedup across tabs and spaces', body(m).filter(l => /example/.test(l)),
     ['1.1.1.1\tone.example', '2.2.2.2\ttwo.example']);
}

/* ---------- 7. config key replacement ---------- */
console.log('== setKV ==');
{
  eq('replace existing', api.setKV('CC=US\nFOO=1\n', 'CC', 'JP'), 'CC=JP\nFOO=1\n');
  eq('append missing', api.setKV('FOO=1\n', 'CC', 'JP'), 'FOO=1\nCC=JP\n');
  eq('empty config', api.setKV('', 'CC', 'DE'), 'CC=DE\n');
  eq('does not touch a prefix match', api.setKV('PROBE_TIMEOUT=3\n', 'CC', 'DE'),
     'PROBE_TIMEOUT=3\nCC=DE\n');
}

/* ---------- 8. country-code wording across OEMs ---------- */
console.log('== country code parsing ==');
{
  eq('cmd wifi style', api.parseCC('Wifi Country Code: US'), 'US');
  eq('dumpsys style', api.parseCC('Current Country Code: JP\n'), 'JP');
  eq('upper-case sentence', api.parseCC('COUNTRY CODE IS: DE'), 'DE');
  eq('trailing note', api.parseCC('Country code: GB (driver)'), 'GB');
  eq('nothing to read', api.parseCC('Wifi is disabled'), '');
  eq('last token fallback', api.parseCC('regdom set to FR'), 'FR');
}

console.log(failures ? `${failures} failure(s)` : '\nall hosts tests passed');
process.exit(failures ? 1 : 0);
