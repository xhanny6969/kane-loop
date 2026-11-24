import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadFlows } from './flows.mjs';
import { runAll, runKane } from './kane.mjs';
import { runAgent } from './agents.mjs';
import { startServer } from './serve.mjs';
import { AGENT_FIXABLE, color, fixRequest, line, markdownReport, setNameWidth, tally } from './report.mjs';

const say = (...a) => console.log(...a);

export function stateDir(cfg) {
  const dir = join(cfg.cwd, '.kane-loop');
  mkdirSync(dir, { recursive: true });
  const gi = join(dir, '.gitignore');
  if (!existsSync(gi)) writeFileSync(gi, 'runs/\nFIX_REQUEST.md\n*.log\n');
  return dir;
}

// KANE_LOOP_GIT points at a git binary when the one on PATH cannot be spawned by Node
// (for example a git.exe inside a sandboxed Windows app package, which fails with EPERM).
let gitWarned = false;
function git(cwd, args) {
  const r = spawnSync(process.env.KANE_LOOP_GIT || 'git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.error && !gitWarned) {
    gitWarned = true;
    say(color.yellow(`  ! git could not be started (${r.error.code || r.error.message}); git steps skipped. Set KANE_LOOP_GIT to a git binary.`));
  }
  return r;
}

function gitHead(cwd) {
  const r = git(cwd, ['rev-parse', '--short', 'HEAD']);
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function gitCommit(cwd, message) {
  if (git(cwd, ['rev-parse', '--is-inside-work-tree']).status !== 0) return false;
  git(cwd, ['add', '-A', '--', '.']); // only the project under test, not the whole repo
  const r = git(cwd, ['commit', '-q', '-m', message]);
  if (r.status === 0) say(color.dim(`  git: ${message}`));
  return r.status === 0;
}

export async function withServer(cfg, fn) {
  if (!cfg.serve) return fn();
  const url = cfg.waitUrl || cfg.url;
  if (!url) throw new Error('"serve" needs "url" (or "waitUrl") so kane-loop knows when the app is up');
  say(color.dim(`  starting app: ${cfg.serve}`));
  const srv = await startServer(cfg.serve, url, { cwd: cfg.cwd, timeoutSec: cfg.serveTimeout || 60 });
  try { return await fn(); } finally { srv.stop(); }
}

// Content hash of the app under test. A flow that already passed on this exact code and now
// "fails" is contradicted by evidence, so kane-loop re-checks it instead of sending the agent
// to fix code that has not changed.
const IGNORE = new Set(['.kane-loop', '.git', 'node_modules']);
export function fingerprint(dir) {
  const h = createHash('sha256');
  const walk = d => {
    for (const name of readdirSync(d).sort()) {
      if (IGNORE.has(name) || name.startsWith('.flaky-') || name.startsWith('.script-')) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else { h.update(relative(dir, p)); h.update(readFileSync(p)); }
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 12);
}

async function verifyOnce(cfg, doc, runDir, label, memory = { passedOn: new Map() }) {
  const flows = cfg.only?.length ? doc.flows.filter(f => cfg.only.includes(f.name)) : doc.flows;
  if (!flows.length) throw new Error(`--only matched no flows (have: ${doc.flows.map(f => f.name).join(', ')})`);
  say(`\n${color.cyan('▶ Kane CLI')} ${label} ${color.dim(`· ${flows.length} flow(s) · ${cfg.url || flows[0].url || 'default url'}`)}`);
  setNameWidth(flows.map(f => f.name));
  const opts = {
    url: cfg.url, headed: cfg.headed, maxSteps: cfg.maxSteps, timeout: cfg.timeout, parallel: cfg.parallel,
    bugDetection: cfg.bugDetection, cwd: cfg.cwd, logDir: runDir, extraArgs: cfg.kaneArgs,
    stallSec: cfg.stallTimeout, errorGraceSec: cfg.errorGrace, launchGapSec: cfg.launchGap,
  };
  const results = await runAll(flows, { ...opts, onDone: r => say(line(r)) });
  // Kane infrastructure hiccups (screenshot failed, browser crashed, Kane agent error) are not
  // the app's fault: re-run them on their own instead of sending them to the coding agent.
  const retries = cfg.retries ?? 2;
  for (let i = 0; i < results.length; i++) {
    for (let n = 1; results[i].verdict === 'flaky' && n <= retries; n++) {
      say(color.dim(`  ↻ ${results[i].flow}: ${results[i].reasonCode || 'Kane infra error'} — re-running on its own (${n}/${retries})`));
      const again = await runKane(flows[i], { ...opts, logDir: join(runDir, `retry-${n}`) });
      again.retried = n;
      results[i] = again;
      say(line(again));
    }
  }
  const fp = fingerprint(resolve(cfg.cwd, cfg.watch || '.'));
  for (let i = 0; i < results.length; i++) {
    const seen = memory.passedOn.get(results[i].flow);
    if (!AGENT_FIXABLE.has(results[i].verdict) || !seen?.has(fp)) continue;
    let confirmedFail = 0;
    for (let n = 1; n <= retries && AGENT_FIXABLE.has(results[i].verdict); n++) {
      say(color.dim(`  ↻ ${results[i].flow}: Kane says ${results[i].verdict}, but this exact code (${fp}) passed it before — re-checking (${n}/${retries})`));
      const again = await runKane(flows[i], { ...opts, logDir: join(runDir, `recheck-${n}`) });
      again.retried = n;
      if (AGENT_FIXABLE.has(again.verdict)) confirmedFail++;
      results[i] = again;
      say(line(again));
    }
    if (AGENT_FIXABLE.has(results[i].verdict) && confirmedFail === retries) {
      results[i] = { ...results[i], verdict: 'flaky', reasonCode: 'kane_loop.nondeterministic',
        reason: `passed earlier on identical code (${fp}) but failed ${retries} re-check(s): Kane's verdict is not stable for this flow — a human should look at the evidence` };
    }
  }
  for (const r of results) {
    r.fingerprint = fp;
    if (r.verdict === 'passed') {
      if (!memory.passedOn.has(r.flow)) memory.passedOn.set(r.flow, new Set());
      memory.passedOn.get(r.flow).add(fp);
    }
  }
  return results;
}

function writeOutputs(cfg, doc, results, extra = {}) {
  const dir = stateDir(cfg);
  const { green } = tally(results);
  const verifiedAt = new Date().toISOString();
  const kaneVersion = results.find(r => r.kaneVersion)?.kaneVersion;
  const head = gitHead(cfg.cwd);
  const stamp = {
    verified: green, verifiedAt, kaneCliVersion: kaneVersion, flowsFile: cfg.flows, flowsSha256: doc.sha256, gitHead: head,
    iterations: extra.iterations,
    results: results.map(r => ({ flow: r.flow, verdict: r.verdict, reason: r.reason, failedStep: r.failedSteps.at(-1), duration: r.duration, credits: r.credits, testUrl: r.testUrl })),
  };
  writeFileSync(join(dir, 'last-run.json'), JSON.stringify(stamp, null, 2) + '\n');
  if (green) writeFileSync(join(dir, 'verified.json'), JSON.stringify(stamp, null, 2) + '\n');
  writeFileSync(join(dir, 'report.md'), markdownReport({ results, flowsSha256: doc.sha256, iterations: extra.iterations, kaneVersion, gitHead: head, verifiedAt }));
  return stamp;
}

const STOP = new Set(['error', 'blocked']);
function mustStop(results) {
  if (results.some(r => STOP.has(r.verdict))) return true;
  // only infrastructure noise left after retries: nothing the agent could fix
  return !results.some(r => AGENT_FIXABLE.has(r.verdict)) && results.some(r => r.verdict === 'flaky');
}

function explainError(results) {
  const bad = results.filter(r => r.verdict !== 'passed' && !AGENT_FIXABLE.has(r.verdict));
  say(color.yellow(`\n! ${bad.length} run(s) failed for reasons outside the app (setup, credentials, Kane infrastructure or a site blocker), so the agent is not called.`));
  for (const r of bad) {
    say(`  ${r.flow} [${r.verdict}${r.reasonCode ? ` ${r.reasonCode}` : ''}]: ${r.reason || 'exit code 2'}`);
    if (r.stderrTail) say(color.dim(r.stderrTail.split('\n').map(l => `    ${l}`).join('\n')));
  }
  say(color.dim('  Check: kane-cli whoami  ·  the --url is reachable  ·  Chrome is installed'));
}

export async function verify(cfg) {
  const doc = loadFlows(resolve(cfg.cwd, cfg.flows));
  const runDir = join(stateDir(cfg), 'runs', stamp());
  const results = await withServer(cfg, () => verifyOnce(cfg, doc, runDir, 'verify'));
  const out = writeOutputs(cfg, doc, results);
  const { passed, total, green } = tally(results);
  if (mustStop(results)) { explainError(results); return 2; }
  say(`\n${green ? color.green(`✓ VERIFIED ${passed}/${total}`) : color.red(`✗ NOT VERIFIED ${passed}/${total}`)} ${color.dim(`→ .kane-loop/report.md`)}`);
  return green ? 0 : 1;
}

export async function fix(cfg) {
  if (!cfg.agent) throw new Error('fix needs --agent (hermes | claude | codex | gemini | kiro | "<command with {prompt}>")');
  const flowsPath = resolve(cfg.cwd, cfg.flows);
  const protectedFiles = [cfg.flows, cfg.configFile].filter(Boolean);
  const dir = stateDir(cfg);
  const session = stamp();
  const maxIter = cfg.maxIter ?? 5;
  const history = [];
  const memory = { passedOn: new Map() };
  let violation = null;

  return withServer(cfg, async () => {
    for (let iteration = 0; ; iteration++) {
      const doc = loadFlows(flowsPath);
      const runDir = join(dir, 'runs', session, `iter-${iteration}`);
      const results = await verifyOnce(cfg, doc, runDir, iteration === 0 ? 'baseline' : `after agent pass ${iteration}`, memory);
      const { passed, total, green } = tally(results);
      history.push({ iteration, passed, total, appFingerprint: results[0]?.fingerprint, specViolation: !!violation, at: new Date().toISOString(),
        flows: Object.fromEntries(results.map(r => [r.flow, r.verdict + (r.retried ? ` (re-run ${r.retried})` : '')])) });
      writeFileSync(join(dir, 'history.json'), JSON.stringify({ session, agent: cfg.agent, history }, null, 2) + '\n');

      if (mustStop(results)) { explainError(results); writeOutputs(cfg, doc, results, { iterations: iteration }); return 2; }
      if (green) {
        writeOutputs(cfg, doc, results, { iterations: iteration });
        if (cfg.commit && iteration > 0) gitCommit(cfg.cwd, `kane-loop: verified ${passed}/${total} flows after ${iteration} agent pass(es)`);
        say(`\n${color.green(`✓ VERIFIED ${passed}/${total}`)} after ${iteration} agent pass(es) ${color.dim('→ .kane-loop/verified.json')}`);
        return 0;
      }
      if (iteration >= maxIter) {
        writeOutputs(cfg, doc, results, { iterations: iteration });
        say(`\n${color.red(`✗ still ${passed}/${total} after ${maxIter} agent pass(es)`)} — giving up. Read .kane-loop/report.md`);
        return 1;
      }

      const prompt = fixRequest({ results, flowsFile: cfg.flows, url: cfg.url, serve: cfg.serve, iteration: iteration + 1, maxIter, history: history.slice(0, -1), violation, protectedFiles });
      const promptFile = join(dir, 'FIX_REQUEST.md');
      writeFileSync(promptFile, prompt);
      const before = new Map(protectedFiles.map(f => [f, read(resolve(cfg.cwd, f))]));

      const fixable = results.filter(r => AGENT_FIXABLE.has(r.verdict)).length;
      say(`\n${color.cyan('▶ agent')} ${cfg.agent} ${color.dim(`· pass ${iteration + 1}/${maxIter} · ${fixable} failing flow(s) handed over in .kane-loop/FIX_REQUEST.md`)}`);
      const res = await runAgent(cfg.agent, {
        cwd: cfg.cwd, promptFile: relative(cfg.cwd, promptFile), logFile: join(dir, `agent-${session}-${iteration + 1}.log`),
        timeoutSec: cfg.agentTimeout, onOutput: cfg.quietAgent ? null : s => {
          const text = s.replace(/\r/g, '').replace(/\n$/, '');
          if (text) say(color.dim(text.replace(/^/gm, '  │ ')));
        },
      });
      say(color.dim(`  agent exited ${res.exitCode} in ${res.seconds}s`));

      violation = [];
      for (const [f, content] of before) {
        const p = resolve(cfg.cwd, f);
        if (read(p) !== content) {
          if (content === null) rmSync(p, { force: true }); else writeFileSync(p, content);
          violation.push(f);
        }
      }
      if (violation.length) say(color.yellow(`  ! agent edited ${violation.join(', ')} — reverted. The spec is not the agent's to change.`));
      else violation = null;
      if (cfg.commit) gitCommit(cfg.cwd, `kane-loop pass ${iteration + 1}: ${cfg.agent} fixing ${total - passed} failing flow(s)`);
    }
  });
}

export async function gate(cfg, command) {
  if (!command) throw new Error('gate needs a command after "--", e.g. kane-loop gate -- npx wrangler pages deploy dist');
  const code = await verify(cfg);
  if (code !== 0) {
    say(color.red(`\n✗ gate closed — not running: ${command}`));
    return code;
  }
  say(color.green(`\n✓ gate open — running: ${command}`));
  return new Promise(res => {
    const child = spawn(command, { cwd: cfg.cwd, shell: true, stdio: 'inherit' });
    child.on('close', c => res(c ?? 1));
  });
}

function read(p) { try { return readFileSync(p, 'utf8'); } catch { return null; } }
function stamp() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); }

// calibrate: run every flow N times on the same code and measure how stable Kane's verdict is.
// A flow you cannot trust to give the same answer twice should not be gating a deploy or steering an agent.
export function stability(outcomes) {
  const passes = outcomes.filter(v => v === 'passed').length;
  const fixable = outcomes.filter(v => AGENT_FIXABLE.has(v)).length;
  const n = outcomes.length;
  let cls;
  if (passes === n) cls = 'stable-pass';
  else if (fixable === n) cls = 'stable-fail';
  else if (passes > 0) cls = 'unstable';
  else cls = 'noisy';
  const majority = Math.max(passes, n - passes);
  return { cls, passes, n, agreement: majority / n };
}

export async function calibrate(cfg) {
  const doc = loadFlows(resolve(cfg.cwd, cfg.flows));
  const flows = cfg.only?.length ? doc.flows.filter(f => cfg.only.includes(f.name)) : doc.flows;
  const runs = Math.max(2, cfg.runs || 3);
  const appDir = resolve(cfg.cwd, cfg.watch || '.');
  const fp = fingerprint(appDir);
  const dir = stateDir(cfg);
  const base = join(dir, 'runs', `calibrate-${stamp()}`);
  const opts = { url: cfg.url, headed: cfg.headed, maxSteps: cfg.maxSteps, timeout: cfg.timeout, parallel: cfg.parallel, bugDetection: cfg.bugDetection, cwd: cfg.cwd, extraArgs: cfg.kaneArgs,
    stallSec: cfg.stallTimeout, errorGraceSec: cfg.errorGrace, launchGapSec: cfg.launchGap };
  const all = Object.fromEntries(flows.map(f => [f.name, []]));
  setNameWidth(flows.map(f => f.name));

  await withServer(cfg, async () => {
    say(`\n${color.cyan('▶ Kane CLI calibrate')} ${color.dim(`· ${flows.length} flow(s) × ${runs} runs on identical code (app ${fp})`)}`);
    for (let round = 1; round <= runs; round++) {
      say(color.dim(`  round ${round}/${runs}`));
      // round-robin, so a slow or broken minute on the machine hits every flow, not one
      const results = await runAll(flows, { ...opts, logDir: join(base, `round-${round}`), onDone: r => say(line(r)) });
      for (const r of results) all[r.flow].push(r);
      if (results.some(r => r.verdict === 'error')) { explainError(results); throw Object.assign(new Error('Kane could not start; calibration aborted'), { exitCode: 2 }); }
      const now = fingerprint(appDir);
      if (now !== fp) throw Object.assign(new Error(`app files changed during calibration (${fp} → ${now}); results discarded`), { exitCode: 2 });
    }
  });

  const MARK = { passed: '✓', failed: '✗', timeout: '⏱', flaky: '↻', blocked: '⊘', error: '!' };
  const rows = flows.map(f => {
    const rs = all[f.name];
    const st = stability(rs.map(r => r.verdict));
    const noise = rs.filter(r => r.verdict !== 'passed').map(r => `${r.resultCode ?? r.verdict}${r.bug?.family ? ` ${r.bug.family}` : ''}${r.bug?.confirmed ? ' (confirmed)' : ''}`);
    const avg = k => { const xs = rs.map(r => r[k]).filter(x => typeof x === 'number'); return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null; };
    return { flow: f.name, title: f.title, ...st, marks: rs.map(r => MARK[r.verdict] || '?').join(''), noise, avgDuration: avg('duration'), avgCredits: avg('credits'),
      runs: rs.map(r => ({ verdict: r.verdict, resultCode: r.resultCode, reasonCode: r.reasonCode, family: r.bug?.family, confirmed: r.bug?.confirmed, bugTitle: r.bug?.bug_title, credits: r.credits, testUrl: r.testUrl })) };
  });

  const paint = { 'stable-pass': color.green, 'stable-fail': color.red, unstable: color.yellow, noisy: color.yellow };
  say(`\n${color.bold('Verdict stability')} ${color.dim(`(app ${fp}, ${runs} runs per flow)`)}`);
  for (const r of rows) {
    say(`  ${r.marks.padEnd(runs + 1)} ${color.bold(r.flow.padEnd(30))} ${paint[r.cls](r.cls.toUpperCase().padEnd(12))} ${`${r.passes}/${r.n}`.padEnd(5)} ${color.dim(r.noise.length ? r.noise.join(', ') : `${r.avgDuration ?? '-'}s, ${r.avgCredits ?? '-'} cr avg`)}`);
  }
  const totalRuns = rows.reduce((a, r) => a + r.n, 0);
  const agreeing = rows.reduce((a, r) => a + Math.round(r.agreement * r.n), 0);
  const nonApp = rows.flatMap(r => r.runs).filter(x => x.verdict !== 'passed' && !(x.confirmed && x.family === 'application_issue')).length;
  const falseConfirmed = rows.filter(r => r.cls === 'unstable').flatMap(r => r.runs).filter(x => x.confirmed && x.family === 'application_issue').length;
  const credits = Math.round(rows.flatMap(r => r.runs).reduce((a, x) => a + (x.credits || 0), 0) * 10) / 10;
  say(`\n  ${agreeing}/${totalRuns} runs agreed with their flow's majority verdict · ${nonApp} non-app failure(s) · ${falseConfirmed} "confirmed" bug(s) on a flow that also passed · ${credits} credits`);
  const unstable = rows.filter(r => r.cls === 'unstable' || r.cls === 'noisy');
  const failing = rows.filter(r => r.cls === 'stable-fail');
  if (unstable.length) say(color.yellow(`  ! not gate-worthy yet: ${unstable.map(r => r.flow).join(', ')} — tighten the objective (see https://www.testmuai.com/docs/kane-cli-writing-objectives) or raise --retries`));
  if (failing.length) say(color.red(`  ✗ consistently failing (a real bug, or a wrong spec): ${failing.map(r => r.flow).join(', ')}`));
  if (!unstable.length && !failing.length) say(color.green(`  ✓ every flow gave the same answer ${runs}/${runs} times — safe to gate on`));

  const report = { calibratedAt: new Date().toISOString(), appFingerprint: fp, flowsSha256: doc.sha256, runsPerFlow: runs, parallel: cfg.parallel || 1,
    kaneCliVersion: rows.flatMap(r => all[r.flow]).find(r => r.kaneVersion)?.kaneVersion, agreement: `${agreeing}/${totalRuns}`, nonAppFailures: nonApp, falseConfirmed, credits, flows: rows };
  writeFileSync(join(dir, 'calibration.json'), JSON.stringify(report, null, 2) + '\n');
  const md = ['# kane-loop calibration', '', `- App fingerprint: \`${fp}\` · ${runs} runs per flow · parallel ${report.parallel} · Kane CLI ${report.kaneCliVersion || '?'}`,
    `- ${agreeing}/${totalRuns} runs agreed with their flow's majority · ${nonApp} non-app failure(s) · ${falseConfirmed} false "confirmed" bug(s) · ${credits} credits`, '',
    '| Flow | Runs | Class | Passed | Non-pass verdicts |', '|---|---|---|---|---|',
    ...rows.map(r => `| ${r.title} | ${r.marks} | ${r.cls} | ${r.passes}/${r.n} | ${r.noise.join(', ') || '—'} |`), ''];
  writeFileSync(join(dir, 'calibration.md'), md.join('\n'));
  say(color.dim(`  → .kane-loop/calibration.json, .kane-loop/calibration.md`));
  return failing.length ? 1 : unstable.length ? 2 : 0;
}
