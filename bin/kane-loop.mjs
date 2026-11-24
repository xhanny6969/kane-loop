#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibrate, fix, gate, verify } from '../src/loop.mjs';
import { serveStatic } from '../src/serve.mjs';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

const HELP = `kane-loop ${pkg.version} — your coding agent builds, Kane CLI proves it, failures go back to the agent.

Usage
  kane-loop init                         write flows.md + kane-loop.json
  kane-loop verify [options]             run every flow in Kane CLI, exit 0 only if all pass
  kane-loop fix --agent <a> [options]    verify → hand failures to the agent → re-verify, until green
  kane-loop gate [options] -- <cmd>      run <cmd> (deploy, publish, merge) only if every flow passes
  kane-loop calibrate [--runs 3]         run every flow N times on identical code; report how stable Kane's verdicts are
  kane-loop static <dir> [--port 4173]   zero-dependency no-cache static server for the app under test

Agents (--agent)
  hermes | claude | codex | gemini | kiro, or any command containing {prompt} / {prompt_file}

Options
  --flows <file>        spec file (default flows.md)
  --url <url>           start URL for every flow (flows.md "url:" also works)
  --serve <cmd>         start the app before testing, stop it after
  --wait-url <url>      URL that answers once the app is up (default --url)
  --only <a,b>          run only these flows
  --parallel <n>        Kane runs in parallel (default 1)
  --headed              show the browser (default headless)
  --max-steps <n>       per-run step cap passed to Kane
  --timeout <s>         per-run timeout passed to Kane
  --bug-detection <m>   off | stop | continue (passed to Kane)
  --max-iter <n>        agent passes before giving up (default 5)
  --retries <n>         re-runs for Kane infrastructure errors, never sent to the agent (default 2)
  --stall-timeout <s>   kill a Kane run that prints nothing for this long (default 600)
  --error-grace <s>     kill a Kane run that reported an internal error but never ended (default 90)
  --launch-gap <s>      parallel: max wait for one run's browser before starting the next (default 45)
  --runs <n>            calibrate: runs per flow (default 3)
  --commit              git commit after every agent pass and on green
  --agent-timeout <s>   kill the agent after this long (default 900)
  --quiet-agent         do not stream agent output
  --config <file>       config file (default kane-loop.json)

Exit codes: 0 verified · 1 flows still failing · 2 stopped for a non-app reason (auth, credits, url, Chrome, captcha, Kane infra)`;

const FLAGS = new Set(['headed', 'commit', 'quiet-agent', 'help', 'version']);
const NUMS = new Set(['parallel', 'max-steps', 'timeout', 'max-iter', 'agent-timeout', 'port', 'serve-timeout', 'retries', 'runs', 'stall-timeout', 'error-grace', 'launch-gap']);
const camel = s => s.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());

function parse(argv) {
  const opts = {};
  const pos = [];
  let rest = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest = argv.slice(i + 1); break; }
    if (a === '-h') { opts.help = true; continue; }
    if (a.startsWith('--')) {
      let [k, v] = a.slice(2).split(/=(.*)/s);
      if (FLAGS.has(k)) { opts[camel(k)] = true; continue; }
      if (v === undefined) {
        v = argv[++i];
        if (v === undefined) throw new Error(`--${k} needs a value`);
      }
      opts[camel(k)] = NUMS.has(k) ? Number(v) : v;
      continue;
    }
    pos.push(a);
  }
  return { opts, pos, rest };
}

const FLOWS_TEMPLATE = `# My app — kane-loop flows
> One "## heading" per flow. Write what a user does and what they should see.
> kane-loop sends each objective to Kane CLI, which drives a real Chrome and returns pass or fail.

url: http://localhost:4173

## home page loads
Open the page and verify the main heading is visible and the page shows no error message

## primary action works
Click the main call-to-action button and verify the page responds with the expected result
`;

async function main() {
  const { opts, pos, rest } = parse(process.argv.slice(2));
  const cmd = pos[0];
  if (opts.version) { console.log(pkg.version); return 0; }
  if (opts.help || !cmd) { console.log(HELP); return cmd ? 0 : 1; }

  const cwd = resolve(opts.cwd || process.cwd());
  if (cmd === 'init') {
    const wrote = [];
    if (!existsSync(resolve(cwd, 'flows.md'))) { writeFileSync(resolve(cwd, 'flows.md'), FLOWS_TEMPLATE); wrote.push('flows.md'); }
    if (!existsSync(resolve(cwd, 'kane-loop.json'))) {
      writeFileSync(resolve(cwd, 'kane-loop.json'), JSON.stringify({ flows: 'flows.md', url: 'http://localhost:4173', serve: 'npx kane-loop static . --port 4173', agent: 'claude', maxIter: 5 }, null, 2) + '\n');
      wrote.push('kane-loop.json');
    }
    console.log(wrote.length ? `wrote ${wrote.join(', ')}` : 'flows.md and kane-loop.json already exist');
    return 0;
  }
  if (cmd === 'static') {
    const dir = pos[1] || '.';
    const port = opts.port || 4173;
    await serveStatic(resolve(cwd, dir), port);
    console.log(`serving ${resolve(cwd, dir)} at http://127.0.0.1:${port} (no-store)`);
    return new Promise(() => {});
  }

  const configFile = opts.config || 'kane-loop.json';
  const configPath = resolve(cwd, configFile);
  const fileCfg = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  const cfg = { flows: 'flows.md', ...fileCfg, ...opts, cwd };
  cfg.configFile = existsSync(configPath) ? relative(cwd, configPath) : null;
  if (typeof cfg.only === 'string') cfg.only = cfg.only.split(',').map(s => s.trim()).filter(Boolean);
  if (!existsSync(resolve(cwd, cfg.flows))) throw new Error(`no ${cfg.flows} here — run "kane-loop init" or pass --flows`);

  if (cmd === 'verify') return verify(cfg);
  if (cmd === 'fix') return fix(cfg);
  if (cmd === 'gate') return gate(cfg, rest?.join(' '));
  if (cmd === 'calibrate') return calibrate(cfg);
  throw new Error(`unknown command "${cmd}" (try --help)`);
}

main().then(code => { if (typeof code === 'number') process.exitCode = code; }, e => {
  console.error(`kane-loop: ${e.message}`);
  process.exitCode = e.exitCode ?? 2;
});
