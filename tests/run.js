#!/usr/bin/env node
/* One entry point for every suite.
 *
 * The three suites share nothing, so they run as separate processes at the
 * same time instead of in a row: wall time is the slowest one (~0.4 s) rather
 * than the sum, and a failure in one does not hide the output of the others.
 * The exit code is 1 if any suite failed, so build.sh and CI can rely on it.
 *
 * Run: node tests/run.js  [--verbose]
 */
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SUITES = [
  ['parsers', 'test-diag.js'],
  ['hosts', 'test-hosts.js'],
  ['page', 'test-status.js']
];
const verbose = process.argv.includes('--verbose');

function runOne([name, file]) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [path.join(__dirname, file)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => resolve({ name, ok: false, ms: 0, out: '', err: String(e) }));
    p.on('close', code => resolve({
      name, ok: code === 0, ms: Date.now() - t0, out, err
    }));
  });
}

(async () => {
  const t0 = Date.now();
  const results = await Promise.all(SUITES.map(runOne));

  let failed = 0;
  for (const r of results) {
    const mark = r.ok ? 'ok  ' : 'FAIL';
    console.log(`${mark} ${r.name.padEnd(8)} ${String(r.ms).padStart(4)}ms`);
    if (!r.ok) {
      failed++;
      /* Only the failing suite's transcript is worth printing; the passing
         ones would bury it. */
      console.log((r.out + r.err).split('\n').filter(l => /FAIL|Error|error/.test(l))
        .map(l => '     ' + l).join('\n'));
    } else if (verbose) {
      console.log((r.out + r.err).trim().split('\n').map(l => '     ' + l).join('\n'));
    }
  }

  const ms = Date.now() - t0;
  if (failed) {
    console.log(`\n${failed} of ${results.length} suites failed (${ms}ms)`);
    process.exit(1);
  }
  console.log(`\nall ${results.length} suites passed (${ms}ms)`);
})();