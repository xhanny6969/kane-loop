#!/usr/bin/env node
// Zero-credit reproduction of why two `kane-cli run` processes that start together share one Chrome.
//
// Kane CLI 0.10.8 picks its CDP port by probing 127.0.0.1:9222..9230 and taking the first port that
// refuses a TCP connection, then launches Chrome with --remote-debugging-port=<port> and talks to
// http://127.0.0.1:<port>. On Windows, a Chrome that finds 127.0.0.1:<port> taken listens on [::1]:<port>
// instead, so a second probe still sees the port as free.
//
// This script does the same with plain headless Chrome (no Kane, no credits):
//   node scripts/cdp-port-race.mjs together    -> both pick one port; 127.0.0.1 answers with ONE browser
//   node scripts/cdp-port-race.mjs staggered   -> second launch waits; each run gets its own port
import { spawn, execSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mode = process.argv[2] || 'together';
const FIRST = Number(process.argv[3] || 9231); // stay clear of a real Kane run on 9222+
const CHROME = process.env.KANE_CLI_CHROME_PATH || {
  win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
}[process.platform] || 'google-chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const refuses = (port, host) => new Promise(res => {
  const s = net.connect({ port, host });
  s.setTimeout(1000);
  s.on('connect', () => { s.destroy(); res(false); });
  s.on('timeout', () => { s.destroy(); res(true); });
  s.on('error', () => { s.destroy(); res(true); });
});
async function pickPortLikeKane() {
  for (let p = FIRST; p <= FIRST + 8; p++) if (await refuses(p, '127.0.0.1')) return p;
  throw new Error('no free port');
}
async function launch(name) {
  const port = await pickPortLikeKane();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cdp-race-${name}-`));
  const child = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--headless=new', '--no-first-run',
    '--no-default-browser-check', `data:text/html,<title>run ${name}</title>`], { stdio: 'ignore', detached: true });
  return { name, port, pid: child.pid, dir };
}
async function pageTitles(port) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
    return list.filter(t => t.type === 'page').map(t => t.title).join(', ') || '(no page)';
  } catch { return 'nothing answers'; }
}
function listeners(port) {
  const cmd = process.platform === 'win32' ? 'netstat -ano' : 'netstat -an';
  return execSync(cmd).toString().split(/\r?\n/).filter(l => l.includes(`:${port} `) && /LISTEN/.test(l)).map(l => l.trim().split(/\s+/).slice(0, 2).join(' '));
}

const runs = mode === 'together'
  ? await Promise.all([launch('A'), launch('B')])
  : [await launch('A'), await sleep(4000).then(() => launch('B'))];
await sleep(4000);

console.log(`mode: ${mode}`);
for (const r of runs) console.log(`  run ${r.name}: picked port ${r.port}; http://127.0.0.1:${r.port} is answered by "${await pageTitles(r.port)}"`);
for (const p of new Set(runs.map(r => r.port))) console.log(`  listening on ${p}: ${listeners(p).join('  |  ') || 'none'}`);
const shared = runs.length === 2 && runs[0].port === runs[1].port;
console.log(shared ? '  -> both runs drive ONE browser' : '  -> each run drives its own browser');

for (const r of runs) {
  try { process.platform === 'win32' ? execSync(`taskkill /PID ${r.pid} /T /F`, { stdio: 'ignore' }) : process.kill(-r.pid, 'SIGKILL'); } catch { /* gone */ }
}
await sleep(1000);
for (const r of runs) { try { fs.rmSync(r.dir, { recursive: true, force: true }); } catch { /* locked */ } }
