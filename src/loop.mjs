import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadFlows } from './flows.mjs';
import { runAll } from './kane.mjs';
import { runAgent } from './agents.mjs';
import { startServer } from './serve.mjs';
import { color, fixRequest, line, markdownReport, tally } from './report.mjs';

const say = (...a) => console.log(...a);

export function stateDir(cfg) {
  const dir = join(cfg.cwd, '.kane-loop');
  mkdirSync(dir, { recursive: true });
  const gi = join(dir, '.gitignore');
  if (!existsSync(gi)) writeFileSync(gi, 'runs/\nFIX_REQUEST.md\n*.log\n');
  return dir;
}

function gitHead(cwd) {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function gitCommit(cwd, message) {
  if (spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd }).status !== 0) return false;
  spawnSync('git', ['add', '-A', '--', '.'], { cwd }); // only the project under test, not the whole repo
  const r = spawnSync('git', ['commit', '-q', '-m', message], { cwd, encoding: 'utf8' });
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

async function verifyOnce(cfg, doc, runDir, label) {
  const flows = cfg.only?.length ? doc.flows.filter(f => cfg.only.includes(f.name)) : doc.flows;
  if (!flows.length) throw new Error(`--only matched no flows (have: ${doc.flows.map(f => f.name).join(', ')})`);
  say(`\n${color.cyan('▶ Kane CLI')} ${label} ${color.dim(`· ${flows.length} flow(s) · ${cfg.url || flows[0].url || 'default url'}`)}`);
  return runAll(flows, {
    url: cfg.url, headed: cfg.headed, maxSteps: cfg.maxSteps, timeout: cfg.timeout, parallel: cfg.parallel,
    bugDetection: cfg.bugDetection, cwd: cfg.cwd, logDir: runDir, extraArgs: cfg.kaneArgs,
    onDone: r => say(line(r)),
  });
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

function explainError(results) {
  const bad = results.filter(r => r.verdict === 'error');
  say(color.yellow(`\n! Kane CLI could not start ${bad.length} run(s). That is a setup problem, not an app bug, so the agent is not called.`));
  for (const r of bad) {
    say(`  ${r.flow}: ${r.reason || 'exit code 2'}`);
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
  if (results.some(r => r.verdict === 'error')) { explainError(results); return 2; }
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
  let violation = null;

  return withServer(cfg, async () => {
    for (let iteration = 0; ; iteration++) {
      const doc = loadFlows(flowsPath);
      const runDir = join(dir, 'runs', session, `iter-${iteration}`);
      const results = await verifyOnce(cfg, doc, runDir, iteration === 0 ? 'baseline' : `after agent pass ${iteration}`);
      const { passed, total, green } = tally(results);
      history.push({ iteration, passed, total, specViolation: !!violation, at: new Date().toISOString() });
      writeFileSync(join(dir, 'history.json'), JSON.stringify({ session, agent: cfg.agent, history }, null, 2) + '\n');

      if (results.some(r => r.verdict === 'error')) { explainError(results); writeOutputs(cfg, doc, results, { iterations: iteration }); return 2; }
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

      say(`\n${color.cyan('▶ agent')} ${cfg.agent} ${color.dim(`· pass ${iteration + 1}/${maxIter} · ${total - passed} failing flow(s) handed over in .kane-loop/FIX_REQUEST.md`)}`);
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
