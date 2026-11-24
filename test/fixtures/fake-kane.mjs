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
import { existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const marker = `.flaky-${createHash('md5').update(objective).digest('hex').slice(0, 8)}`;
const { appendFileSync } = await import('node:fs');
const tag = (objective.match(/\"([^\"]+)\"/) || [, objective.slice(0, 12)])[1];
const launchLog = process.env.FAKE_KANE_LAUNCH_LOG;
if (launchLog) appendFileSync(launchLog, `start ${tag}\n`);
// Kane needs a moment to launch Chrome before its first step event
if (process.env.FAKE_KANE_LAUNCH_MS) await new Promise(r => setTimeout(r, Number(process.env.FAKE_KANE_LAUNCH_MS)));
// FAKE_KANE_HANG_ONCE=1: what Kane CLI 0.10.8 did for real: internal error event, then no run_end and no exit
const hangMarker = `.flaky-hang-${createHash('md5').update(objective).digest('hex').slice(0, 8)}`;
if (process.env.FAKE_KANE_HANG_ONCE === '1' && !existsSync(hangMarker)) {
  writeFileSync(hangMarker, '1');
  emit({ type: 'stream_start', cli_version: '0.0.0-fake', surface: 'run', pid: process.pid });
  emit({ step: 2, status: 'failed', remark: 'agent_info: The run stopped on an internal error (TargetClosedError).' });
  emit({ type: 'error', message: 'new_cdp_session: Target page, context or browser has been closed' });
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}
if (process.env.FAKE_KANE_FLAKY_ONCE === '1' && !existsSync(marker)) {
  writeFileSync(marker, '1');
  emit({ type: 'stream_start', cli_version: '0.0.0-fake', surface: 'run', pid: process.pid });
  emit({ step: 2, status: 'failed', remark: 'agent_info: Screenshot failed: TargetClosedError' });
  emit({ type: 'run_end', status: 'failed', reason: 'Screenshot failed: TargetClosedError', result_code: 510, reason_code: 'infra_error.screenshot_failed', verdict: { confirmed: false, family: 'environment_issue', bug_title: 'Browser session closed before screenshot capture' } });
  process.exit(1);
}
// FAKE_KANE_SCRIPT='{"<objective substring>": ["pass","fail",...]}' forces outcomes in order
if (process.env.FAKE_KANE_SCRIPT) {
  const script = JSON.parse(process.env.FAKE_KANE_SCRIPT);
  const key = Object.keys(script).find(k => objective.includes(k));
  if (key) {
    const { readFileSync } = await import('node:fs');
    const counter = `.script-${createHash('md5').update(key).digest('hex').slice(0, 8)}`;
    const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
    writeFileSync(counter, String(n + 1));
    const outcome = script[key][Math.min(n, script[key].length - 1)];
    emit({ type: 'stream_start', cli_version: '0.0.0-fake', surface: 'run', pid: process.pid });
    if (outcome === 'pass') {
      emit({ type: 'run_end', status: 'passed', one_liner: `scripted pass #${n + 1}`, result_code: 100 });
      process.exit(0);
    }
    emit({ step: 2, status: 'failed', remark: `assert: scripted failure #${n + 1}` });
    emit({ type: 'run_end', status: 'failed', reason: 'scripted', result_code: 740, verdict: { confirmed: true, family: 'application_issue', bug_title: `Scripted bug #${n + 1}` } });
    process.exit(1);
  }
}
if (process.env.FAKE_KANE_BLOCKED === '1') {
  emit({ type: 'stream_start', cli_version: '0.0.0-fake', surface: 'run', pid: process.pid });
  emit({ type: 'run_end', status: 'failed', reason: 'CAPTCHA challenge', result_code: 610, reason_code: 'blocker.captcha' });
  process.exit(1);
}
const url = argv[argv.indexOf('--url') + 1];
emit({ type: 'stream_start', cli_version: '0.0.0-fake', surface: 'run', pid: process.pid });
process.stdout.write('not json, should be ignored\n');
emit({ step: 1, status: 'running', remark: 'Step 1' });
if (launchLog) appendFileSync(launchLog, `step ${tag}\n`);
if (process.env.FAKE_KANE_RUN_MS) await new Promise(r => setTimeout(r, Number(process.env.FAKE_KANE_RUN_MS)));
emit({ step: 1, status: 'done', remark: `navigate: ${url}` });

const wanted = [...(objective.split(/verify/i)[1] || '').matchAll(/"([^"]+)"/g)].map(m => m[1]);
let body = '';
try { body = await (await fetch(url)).text(); } catch (e) { body = ''; }
const missing = wanted.filter(w => !body.includes(w));

if (missing.length) {
  emit({ step: 2, status: 'failed', remark: `assert: expected the page to show "${missing[0]}" but it was not found` });
  emit({ type: 'run_end', status: 'failed', summary: `Opened ${url}; ${missing.length} expectation(s) missing`, reason: 'Assertion failed', duration: 1.2, credits_consumed: 3.5, session_dir: '/tmp/fake-session', result_code: 740,
    verdict: { confirmed: true, family: 'application_issue', severity: 'major', bug_title: `Missing text: ${missing[0]}`, root_cause: 'The page does not render the expected text', suggestion: `Render "${missing[0]}"`, confidence: 0.9 } });
  process.exit(1);
}
emit({ step: 2, status: 'done', remark: `assert: page shows ${wanted.join(', ')}` });
emit({ type: 'run_end', status: 'passed', summary: 'All expectations visible', one_liner: 'Page shows the expected text', reason: 'Objective completed', duration: 1.1, credits: 3.1, test_url: 'https://test-manager.example/fake' });
process.exit(0);
