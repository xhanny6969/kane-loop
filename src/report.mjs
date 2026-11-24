// Terminal table + markdown report + the prompt the agent reads.

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = {
  green: s => c(32, s), red: s => c(31, s), yellow: s => c(33, s), dim: s => c(2, s), bold: s => c(1, s), cyan: s => c(36, s),
};

const ICON = { passed: '✓', failed: '✗', timeout: '⏱', error: '!' };
const PAINT = { passed: color.green, failed: color.red, timeout: color.yellow, error: color.yellow };

export function line(r) {
  const paint = PAINT[r.verdict] || (s => s);
  const credits = r.credits != null ? `${Math.round(r.credits * 10) / 10} cr` : '';
  const why = r.verdict === 'passed' ? (r.oneLiner || r.reason || '') : (r.failedSteps.at(-1) || r.reason || '');
  return `  ${paint(`${ICON[r.verdict] || '?'} ${r.verdict.toUpperCase().padEnd(7)}`)} ${color.bold(r.flow.padEnd(22))} ${color.dim(`${r.wallSec ?? '-'}s ${credits}`.padEnd(14))} ${clip(why, 90)}`;
}

export function tally(results) {
  const passed = results.filter(r => r.verdict === 'passed').length;
  return { passed, total: results.length, green: passed === results.length };
}

export function clip(s = '', n = 100) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function fixRequest({ results, flowsFile, url, serve, iteration, maxIter, history, violation, protectedFiles }) {
  const failing = results.filter(r => r.verdict !== 'passed');
  const passing = results.filter(r => r.verdict === 'passed');
  const out = [];
  out.push(`# Kane CLI rejected the app — iteration ${iteration} of ${maxIter}`);
  out.push('');
  out.push('You are the coding agent in a kane-loop. Kane CLI just drove the app in a real Chrome browser,');
  out.push(`following the plain-English flows in \`${flowsFile}\`. ${failing.length} of ${results.length} flows did not pass.`);
  out.push('');
  out.push('## Rules');
  out.push(`- The flows are the spec. Do NOT edit ${protectedFiles.map(f => `\`${f}\``).join(', ')} or anything in \`.kane-loop/\`. Edits there are reverted automatically and reported.`);
  out.push('- Change the application code so that every flow below passes in a real browser. Fix the root cause, do not special-case the test text.');
  out.push('- Keep the flows that already pass working.');
  if (url) out.push(`- The app is served at ${url}${serve ? ` (started by kane-loop with \`${serve}\`; static files are re-read on every request, no restart needed)` : ''}.`);
  out.push('- When the code is fixed, stop. kane-loop re-runs Kane CLI on its own; you do not need to run it.');
  if (violation) {
    out.push('');
    out.push(`> Last iteration you modified ${violation.join(', ')}. Those edits were reverted. Fix the application instead.`);
  }
  out.push('');
  out.push('## Failing flows');
  for (const r of failing) {
    out.push('');
    out.push(`### ${r.title}`);
    out.push(`- Objective: ${r.objective}`);
    out.push(`- Kane verdict: **${r.verdict}**${r.reason ? ` — ${r.reason}` : ''}`);
    for (const s of r.failedSteps) out.push(`- Failed step: ${s}`);
    if (r.summary) out.push(`- What Kane saw: ${r.summary}`);
    if (r.bug) out.push(`- Bug verdict: ${JSON.stringify(r.bug)}`);
    for (const e of r.errors) out.push(`- Error: ${e}`);
    if (r.sessionDir) out.push(`- Evidence (screenshots, logs): ${r.sessionDir}`);
  }
  if (passing.length) {
    out.push('');
    out.push('## Passing flows (keep them green)');
    for (const r of passing) out.push(`- ${r.title}: ${r.objective}`);
  }
  if (history.length) {
    out.push('');
    out.push('## Earlier iterations');
    for (const h of history) out.push(`- iteration ${h.iteration}: ${h.passed}/${h.total} passing${h.specViolation ? ' (spec edit reverted)' : ''}`);
  }
  out.push('');
  return out.join('\n');
}

export function markdownReport({ results, flowsSha256, iterations, kaneVersion, gitHead, verifiedAt }) {
  const { passed, total, green } = tally(results);
  const out = [];
  out.push(`# kane-loop report — ${green ? 'VERIFIED' : 'NOT VERIFIED'} (${passed}/${total})`);
  out.push('');
  out.push(`- Checked at: ${verifiedAt}`);
  if (kaneVersion) out.push(`- Kane CLI: ${kaneVersion}`);
  if (gitHead) out.push(`- Commit: \`${gitHead}\``);
  out.push(`- Spec hash (flows): \`${flowsSha256.slice(0, 16)}\``);
  if (iterations != null) out.push(`- Agent iterations: ${iterations}`);
  out.push('');
  out.push('| Flow | Verdict | Time | Credits | Kane run |');
  out.push('|---|---|---|---|---|');
  for (const r of results) {
    const link = r.testUrl ? `[Test Manager](${r.testUrl})` : '';
    out.push(`| ${r.title} | ${ICON[r.verdict]} ${r.verdict} | ${r.duration ?? r.wallSec ?? ''}s | ${r.credits != null ? Math.round(r.credits * 10) / 10 : ''} | ${link} |`);
  }
  const bad = results.filter(r => r.verdict !== 'passed');
  if (bad.length) {
    out.push('');
    out.push('## Why it failed');
    for (const r of bad) out.push(`- **${r.title}**: ${clip(r.failedSteps.at(-1) || r.reason || r.summary, 300)}`);
  }
  out.push('');
  return out.join('\n');
}
