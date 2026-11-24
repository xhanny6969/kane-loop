#!/usr/bin/env node
// Test double for `kane-cli run --agent`: fetches --url and checks that every "quoted"
// string after the word "verify" appears in the page. Emits the same NDJSON shape and
// exit codes as Kane CLI, so kane-loop can be tested end to end without spending credits.
const argv = process.argv.slice(2);
const emit = o => process.stdout.write(JSON.stringify({ ...o, v: 1, ts: new Date().toISOString() }) + '\n');

if (process.env.FAKE_KANE_EXIT === '2') {
  process.stderr.write('Not logged in. Run: kane-cli login\n');
  process.exit(2);
}

const objective = argv[1] || '';
const url = argv[argv.indexOf('--url') + 1];
emit({ type: 'stream_start', cli_version: '0.0.0-fake', surface: 'run', pid: process.pid });
process.stdout.write('not json, should be ignored\n');
emit({ step: 1, status: 'running', remark: 'Step 1' });
emit({ step: 1, status: 'done', remark: `navigate: ${url}` });

const wanted = [...(objective.split(/verify/i)[1] || '').matchAll(/"([^"]+)"/g)].map(m => m[1]);
let body = '';
try { body = await (await fetch(url)).text(); } catch (e) { body = ''; }
const missing = wanted.filter(w => !body.includes(w));

if (missing.length) {
  emit({ step: 2, status: 'failed', remark: `assert: expected the page to show "${missing[0]}" but it was not found` });
  emit({ type: 'run_end', status: 'failed', summary: `Opened ${url}; ${missing.length} expectation(s) missing`, reason: 'Assertion failed', duration: 1.2, credits_consumed: 3.5, session_dir: '/tmp/fake-session' });
  process.exit(1);
}
emit({ step: 2, status: 'done', remark: `assert: page shows ${wanted.join(', ')}` });
emit({ type: 'run_end', status: 'passed', summary: 'All expectations visible', one_liner: 'Page shows the expected text', reason: 'Objective completed', duration: 1.1, credits: 3.1, test_url: 'https://test-manager.example/fake' });
process.exit(0);
