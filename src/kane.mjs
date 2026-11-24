// Runs one flow through `kane-cli run --agent` and turns the NDJSON stream into a verdict.
// Stream contract: https://www.testmuai.com/docs/kane-cli-agent-mode
//   exit 0 passed | 1 ran and did not pass | 2 never started (auth, url, chrome) | 3 cancelled / --timeout

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let cached;
export function resolveKane() {
  if (cached) return cached;
  const env = process.env.KANE_BIN;
  if (env) {
    cached = /\.(c|m)?js$/i.test(env) ? { cmd: process.execPath, pre: [env] } : { cmd: env, pre: [] };
    return cached;
  }
  // On Windows the global `kane-cli` is a .cmd shim; call its node entry directly so
  // objectives with quotes and spaces reach Kane untouched (no cmd.exe re-quoting).
  if (process.platform === 'win32') {
    try {
      const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const cjs = join(root, '@testmuai', 'kane-cli', 'bin', 'kane-cli.cjs');
      if (existsSync(cjs)) return (cached = { cmd: process.execPath, pre: [cjs] });
    } catch { /* fall through */ }
  }
  return (cached = { cmd: 'kane-cli', pre: [] });
}

export function parseNdjson(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue; // the contract says: skip anything that is not JSON
    try { events.push(JSON.parse(t)); } catch { /* partial or foreign line */ }
  }
  return events;
}

export function summarize(events, exitCode) {
  const start = events.find(e => e.type === 'stream_start') || {};
  const end = [...events].reverse().find(e => e.type === 'run_end');
  const steps = events.filter(e => e.type === undefined && typeof e.step === 'number' && e.status !== 'running');
  const failedSteps = steps.filter(s => s.status === 'failed').map(s => s.remark).filter(Boolean);
  const errors = events.filter(e => e.type === 'error').map(e => e.message).filter(Boolean);
  const warnings = events.filter(e => e.type === 'warning').map(e => e.message).filter(Boolean);

  const verdict = classify(exitCode, end);

  return {
    verdict,
    exitCode,
    kaneVersion: start.cli_version,
    reason: end?.reason || errors.at(-1) || (exitCode === 2 ? 'Kane CLI refused to start the run' : undefined),
    reasonCode: end?.reason_code,
    summary: end?.summary,
    oneLiner: end?.one_liner,
    steps: steps.filter(s => s.status === 'done' || s.status === 'failed').length,
    failedSteps,
    errors,
    warnings,
    duration: end?.duration,
    credits: end?.credits_consumed ?? end?.credits,
    testUrl: end?.test_url,
    sessionDir: end?.session_dir || start.session_dir,
    resultCode: end?.result_code,
    bug: end?.verdict,
    finalState: end?.final_state,
  };
}

// Verdicts kane-loop acts on. Result-code ranges: https://www.testmuai.com/docs/kane-cli-error-codes
//   passed  : exit 0 + run_end passed
//   failed  : 3xx stuck, 650 error page, 7xx assertion  -> the app's problem, goes to the agent
//   timeout : exit 3 or 530                              -> goes to the agent
//   flaky   : 2xx cancelled, 4xx Kane agent error, 510/520/540 infra, or any failure Kane's own
//             triage marks unconfirmed and not an application issue (automation_bug, environment_issue)
//             -> re-run, never sent to the agent
//   blocked : 6xx except 650 (captcha, paywall, WAF, missing credentials) -> needs a human
//   error   : exit 2, 550 auth, 560 credits              -> setup problem, stop the loop
export function classify(exitCode, end) {
  const rc = Number(end?.result_code);
  if (exitCode === 0 && end?.status === 'passed') return 'passed';
  if (exitCode === 2 || rc === 550 || rc === 560) return 'error';
  if ((rc >= 200 && rc < 300) || (rc >= 400 && rc < 500) || rc === 510 || rc === 520 || rc === 540) return 'flaky';
  const v = end?.verdict;
  const blocker = rc >= 600 && rc < 700 && rc !== 650;
  if (!blocker && v && v.confirmed === false && v.family && v.family !== 'application_issue') return 'flaky';
  if (exitCode === 3 || rc === 530) return 'timeout';
  if (rc >= 600 && rc < 700 && rc !== 650) return 'blocked';
  return end ? 'failed' : 'error';
}

export function runKane(flow, opts = {}) {
  const { cmd, pre } = resolveKane();
  const url = flow.url || opts.url;
  const args = [...pre, 'run', flow.objective, '--agent'];
  if (url) args.push('--url', url);
  if (!opts.headed) args.push('--headless');
  const maxSteps = flow.maxSteps || opts.maxSteps;
  if (maxSteps) args.push('--max-steps', String(maxSteps));
  const timeout = flow.timeout || opts.timeout;
  if (timeout) args.push('--timeout', String(timeout));
  if (opts.bugDetection) args.push('--bug-detection', opts.bugDetection);
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);

  return new Promise(resolve => {
    const t0 = Date.now();
    let out = '';
    let err = '';
    const child = spawn(cmd, args, { cwd: opts.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', d => {
      out += d;
      if (opts.onEvent) {
        for (const e of parseNdjson(String(d))) opts.onEvent(e);
      }
    });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => {
      resolve({ flow: flow.name, title: flow.title, objective: flow.objective, url, ...summarize([], 2),
        reason: `could not launch Kane CLI (${e.code || e.message}). Install it: npm i -g @testmuai/kane-cli`, wallSec: 0 });
    });
    child.on('close', code => {
      const events = parseNdjson(out);
      const res = { flow: flow.name, title: flow.title, objective: flow.objective, url, ...summarize(events, code ?? 1),
        wallSec: Math.round((Date.now() - t0) / 100) / 10, stderrTail: err.split(/\r?\n/).filter(Boolean).slice(-8).join('\n') };
      if (opts.logDir) {
        mkdirSync(opts.logDir, { recursive: true });
        writeFileSync(join(opts.logDir, `${flow.name}.ndjson`), out);
        if (err) writeFileSync(join(opts.logDir, `${flow.name}.stderr.log`), err);
      }
      resolve(res);
    });
  });
}

export async function runAll(flows, opts = {}) {
  const parallel = Math.max(1, opts.parallel || 1);
  const results = new Array(flows.length);
  let next = 0;
  async function worker() {
    while (next < flows.length) {
      const i = next++;
      opts.onStart?.(flows[i], i);
      results[i] = await runKane(flows[i], opts);
      opts.onDone?.(results[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, flows.length) }, worker));
  return results;
}
