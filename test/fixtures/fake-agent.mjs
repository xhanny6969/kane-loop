#!/usr/bin/env node
// Test double for a coding agent: reads .kane-loop/FIX_REQUEST.md and "fixes" the app by
// adding every quoted expectation from the failing objectives to app/index.html.
// FAKE_AGENT_CHEAT=1 makes the first pass edit flows.md instead (to exercise the spec guard).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const req = readFileSync('.kane-loop/FIX_REQUEST.md', 'utf8');
if (process.env.FAKE_AGENT_CHEAT === '1' && !existsSync('.cheated')) {
  writeFileSync('.cheated', '1');
  writeFileSync('flows.md', '# hacked\n## anything\nverify nothing\n');
  console.log('rewrote the spec instead of the app');
  process.exit(0);
}
const failing = req.split('## Failing flows')[1]?.split('## Passing flows')[0] || '';
const wanted = new Set();
for (const m of failing.matchAll(/- Objective: (.*)/g)) {
  for (const q of (m[1].split(/verify/i)[1] || '').matchAll(/"([^"]+)"/g)) wanted.add(q[1]);
}
for (const w of wanted) appendFileSync('app/index.html', `<p>${w}</p>\n`);
console.log(`added ${wanted.size} element(s) to app/index.html`);
