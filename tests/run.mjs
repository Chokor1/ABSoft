/**
 * Test runner.
 *
 *   npm test          server-side suites only (no dependencies, always works)
 *   npm run test:ui   browser suites (needs playwright-core and Microsoft Edge)
 *   npm run test:all  both
 *
 * Each suite starts its own ABSoft on its own port against a throwaway database
 * under .test-run/, so running them never touches data/.
 */
import { spawn } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const mode = process.argv[2] || 'server';

const serverSuites = readdirSync(HERE)
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => join(HERE, f));
const uiDir = join(HERE, 'ui');
const uiSuites = existsSync(uiDir)
  ? readdirSync(uiDir)
      .filter((f) => f.endsWith('.test.mjs'))
      .map((f) => join(uiDir, f))
  : [];

const suites =
  mode === 'ui' ? uiSuites : mode === 'all' ? [...serverSuites, ...uiSuites] : serverSuites;

if (mode !== 'server' && uiSuites.length) {
  // playwright-core is a test-only dependency; the app itself needs nothing.
  const installed = existsSync(join(APP, 'node_modules', 'playwright-core'));
  if (!installed) {
    console.error('\n  The browser suites need playwright-core and Microsoft Edge.');
    console.error('  Install it with:  npm install --no-save playwright-core\n');
    process.exit(1);
  }
}

const run = (file) =>
  new Promise((done) => {
    const child = spawn(process.execPath, ['--no-warnings', file], { cwd: APP, stdio: 'inherit' });
    child.on('exit', (code) => done(code === 0));
  });

console.log(`\nABSoft POS tests — ${suites.length} suite(s)\n${'='.repeat(46)}`);

let failed = 0;
for (const file of suites) {
  console.log(`\n▶ ${file.slice(APP.length + 1)}`);
  if (!(await run(file))) failed++;
}

// Kept, not cleaned: the browser suites leave screenshots under .test-run/shots,
// which are the quickest way to see why one failed. Each suite wipes its own
// scratch database on the way in, so nothing here goes stale.

console.log(`\n${'='.repeat(46)}`);
console.log(failed ? `  ${failed} of ${suites.length} suite(s) FAILED` : `  all ${suites.length} suite(s) passed`);
if (suites.some((f) => f.includes('ui'))) console.log('  screenshots: .test-run/shots');
console.log(`${'='.repeat(46)}\n`);
process.exit(failed ? 1 : 0);
