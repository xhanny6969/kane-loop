// Dev-server lifecycle plus a zero-dependency static server (`kane-loop static <dir>`).
// The static server sends no-store headers so Kane never tests a cached copy of the
// page the agent just rewrote.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { kill } from './agents.mjs';

export async function waitForUrl(url, timeoutSec = 60) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.status < 500) return true;
      last = `HTTP ${r.status}`;
    } catch (e) { last = e.cause?.code || e.message; }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error(`server at ${url} did not come up in ${timeoutSec}s (${last})`);
}

export async function startServer(command, url, { cwd, timeoutSec = 60, log } = {}) {
  const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  child.stdout.on('data', d => log?.(String(d)));
  child.stderr.on('data', d => log?.(String(d)));
  let exited = null;
  child.on('close', code => { exited = code; });
  try {
    await Promise.race([
      waitForUrl(url, timeoutSec),
      new Promise((_, rej) => child.on('close', code => rej(new Error(`serve command exited with code ${code} before ${url} answered`)))),
    ]);
  } catch (e) { kill(child); throw e; }
  return { stop: () => { if (exited === null) kill(child); } };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
};

export function serveStatic(dir, port = 4173, host = '127.0.0.1') {
  const root = resolve(dir);
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = normalize(join(root, path));
      if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      const st = await stat(file).catch(() => null);
      if (st?.isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  return new Promise(ok => server.listen(port, host, () => ok(server)));
}
