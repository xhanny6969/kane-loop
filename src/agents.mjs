// Agent adapters. Every agent gets the same short instruction pointing at FIX_REQUEST.md,
// so nothing with quotes, newlines or backticks ever has to survive a shell.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

export const INSTRUCTION =
  'Read the file .kane-loop/FIX_REQUEST.md in the current directory and follow its instructions exactly. Edit the application files in place.';

export const PRESETS = {
  hermes: { cmd: 'hermes', args: p => ['-z', p] },
  claude: { cmd: 'claude', args: p => ['-p', p, '--permission-mode', 'acceptEdits'] },
  codex: { cmd: 'codex', args: p => ['exec', '--full-auto', p] },
  gemini: { cmd: 'gemini', args: p => ['--yolo', '-p', p] },
  kiro: { cmd: 'kiro-cli', args: p => ['chat', '--no-interactive', '--trust-all-tools', p] },
};

const q = s => (/[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

// spec: a preset name, or a custom command line containing {prompt} and/or {prompt_file}.
export function agentCommand(spec, promptFile) {
  const preset = PRESETS[spec];
  if (preset) return [preset.cmd, ...preset.args(INSTRUCTION)].map(q).join(' ');
  if (!/\{prompt(_file)?\}/.test(spec)) return `${spec} ${q(INSTRUCTION)}`;
  return spec.replaceAll('{prompt_file}', q(promptFile)).replaceAll('{prompt}', q(INSTRUCTION));
}

export function runAgent(spec, { cwd, promptFile, logFile, timeoutSec = 900, onOutput } = {}) {
  const line = agentCommand(spec, promptFile);
  return new Promise(resolve => {
    const t0 = Date.now();
    const log = logFile ? createWriteStream(logFile) : null;
    log?.write(`$ ${line}\n\n`);
    let tail = '';
    const child = spawn(line, { cwd, shell: true, env: { ...process.env, KANE_LOOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => { kill(child); tail += `\n[kane-loop] agent timed out after ${timeoutSec}s`; }, timeoutSec * 1000);
    const onData = d => {
      const s = String(d);
      log?.write(s);
      tail = (tail + s).slice(-4000);
      onOutput?.(s);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => onData(`\n[kane-loop] failed to start agent: ${e.message}\n`));
    child.on('close', code => {
      clearTimeout(timer);
      log?.end();
      resolve({ command: line, exitCode: code, seconds: Math.round((Date.now() - t0) / 1000), tail });
    });
  });
}

export function kill(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  }
}
