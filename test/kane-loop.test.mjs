import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlows } from '../src/flows.mjs';
import { classify, parseNdjson, summarize } from '../src/kane.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const BIN = join(here, '..', 'bin', 'kane-loop.mjs');
const FAKE_KANE = join(here, 'fixtures', 'fake-kane.mjs');
const FAKE_AGENT = join(here, 'fixtures', 'fake-agent.mjs');
let port = 4300 + Math.floor(Math.random() * 500);

function project(flowsText, html = '<h1>Hello</h1>\n') {
  const dir = mkdtempSync(join(tmpdir(), 'kane-loop-'));
  mkdirSync(join(dir, 'app'));
  writeFileSync(join(dir, 'app', 'index.html'), html);
  const p = port++;
  writeFileSync(join(dir, 'flows.md'), flowsText.replaceAll('PORT', String(p)));
  writeFileSync(join(dir, 'kane-loop.json'), JSON.stringify({
    flows: 'flows.md', url: `http://127.0.0.1:${p}/`, serve: `node "${BIN}" static app --port ${p}`, agent: `node "${FAKE_AGENT}"`, maxIter: 3,
  }));
  return dir;
}

function cli(dir, args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, KANE_BIN: FAKE_KANE, NO_COLOR: '1', ...env }, timeout: 60000 });
  return { code: r.status, out: r.stdout + r.stderr };
}

const TWO_FLOWS = `# demo
url: http://127.0.0.1:PORT/
> notes are ignored

## greeting
Open the page and verify it shows "Hello"

## total
Type 90 and 3, then verify it shows "Each pays 30.00"
`;

test('parseFlows: defaults, overrides, notes, fences, comments', () => {
  const { flows } = parseFlows(`# t\nurl: http://a\nmax-steps: 20\n> note\n<!-- hidden\n## x\n-->\n\`\`\`\n## fenced\n\`\`\`\n## First Flow\nline one\nline two\n## second\nurl: http://b\ntimeout: 30s\ndo it\n`);
  assert.equal(flows.length, 2);
  assert.deepEqual(flows[0], { name: 'first-flow', title: 'First Flow', objective: 'line one line two', url: 'http://a', maxSteps: 20, timeout: undefined });
  assert.equal(flows[1].url, 'http://b');
  assert.equal(flows[1].timeout, 30);
});

test('parseFlows: rejects empty, duplicate and missing flows', () => {
  assert.throws(() => parseFlows('## a\n## b\ntext\n'), /no objective/);
  assert.throws(() => parseFlows('## a\nx\n## A\ny\n'), /duplicate/);
  assert.throws(() => parseFlows('# only a title\n'), /no flows/);
});

test('summarize: passed, failed, refused, timeout', () => {
  const pass = parseNdjson('{"type":"stream_start","cli_version":"0.10.8"}\ngarbage\n{"step":1,"status":"running"}\n{"step":1,"status":"done","remark":"ok"}\n{"type":"run_end","status":"passed","credits":4.2,"test_url":"u"}\n');
  const p = summarize(pass, 0);
  assert.equal(p.verdict, 'passed');
  assert.equal(p.steps, 1);
  assert.equal(p.credits, 4.2);
  assert.equal(p.kaneVersion, '0.10.8');

  const fail = summarize(parseNdjson('{"step":2,"status":"failed","remark":"button missing"}\n{"type":"run_end","status":"failed","reason":"Assertion failed","result_code":740,"verdict":{"bug":true}}'), 1);
  assert.equal(fail.verdict, 'failed');
  assert.deepEqual(fail.failedSteps, ['button missing']);
  assert.deepEqual(fail.bug, { bug: true });

  assert.equal(summarize([], 2).verdict, 'error');
  assert.equal(summarize([{ type: 'run_end', status: 'failed' }], 3).verdict, 'timeout');
  assert.equal(summarize([{ type: 'run_end', status: 'passed' }], 1).verdict, 'failed', 'exit code wins over a passed run_end');
});

test('verify: exits 1 and writes a report when a flow fails', () => {
  const dir = project(TWO_FLOWS);
  const r = cli(dir, ['verify']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /PASSED\s+greeting/);
  assert.match(r.out, /FAILED\s+total.*bug: Missing text/);
  assert.match(readFileSync(join(dir, '.kane-loop', 'report.md'), 'utf8'), /NOT VERIFIED \(1\/2\)/);
  assert.equal(existsSync(join(dir, '.kane-loop', 'verified.json')), false);
});

test('fix: hands failures to the agent and stops once Kane passes everything', () => {
  const dir = project(TWO_FLOWS);
  const r = cli(dir, ['fix']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /VERIFIED 2\/2 after 1 agent pass/);
  const stamp = JSON.parse(readFileSync(join(dir, '.kane-loop', 'verified.json'), 'utf8'));
  assert.equal(stamp.verified, true);
  assert.equal(stamp.iterations, 1);
  const req = readFileSync(join(dir, '.kane-loop', 'FIX_REQUEST.md'), 'utf8');
  assert.match(req, /Failed step: assert: expected the page to show "Each pays 30.00"/);
  assert.match(req, /Passing flows \(keep them green\)/);
  assert.match(req, /Kane bug report: \*\*Missing text: Each pays 30.00\*\* \(major, confidence 0.9\)/);
  assert.match(req, /Suggested fix \(Kane\): Render/);
  assert.match(readFileSync(join(dir, 'app', 'index.html'), 'utf8'), /Each pays 30.00/);
});

test('fix: reverts an agent that edits the spec, then still gets to green honestly', () => {
  const dir = project(TWO_FLOWS);
  const original = readFileSync(join(dir, 'flows.md'), 'utf8');
  const r = cli(dir, ['fix'], { FAKE_AGENT_CHEAT: '1' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /agent edited flows\.md — reverted/);
  assert.equal(readFileSync(join(dir, 'flows.md'), 'utf8'), original);
  const hist = JSON.parse(readFileSync(join(dir, '.kane-loop', 'history.json'), 'utf8')).history;
  assert.equal(hist.length, 3);
  assert.equal(hist[1].specViolation, true);
});

test('fix: a Kane setup error (exit 2) never reaches the agent', () => {
  const dir = project(TWO_FLOWS);
  const r = cli(dir, ['fix'], { FAKE_KANE_EXIT: '2' });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /reasons outside the app/);
  assert.match(r.out, /Not logged in/);
  assert.equal(existsSync(join(dir, '.kane-loop', 'FIX_REQUEST.md')), false);
});

test('gate: runs the deploy command only when every flow passes', () => {
  const dir = project(TWO_FLOWS);
  const deploy = `node -e "require('fs').writeFileSync('deployed','1')"`;
  const closed = cli(dir, ['gate', '--', deploy]);
  assert.equal(closed.code, 1, closed.out);
  assert.match(closed.out, /gate closed/);
  assert.equal(existsSync(join(dir, 'deployed')), false);

  writeFileSync(join(dir, 'app', 'index.html'), '<h1>Hello</h1><p>Each pays 30.00</p>');
  const open = cli(dir, ['gate', '--', deploy]);
  assert.equal(open.code, 0, open.out);
  assert.equal(existsSync(join(dir, 'deployed')), true);
});

test('classify: result-code ranges decide who has to act', () => {
  const end = rc => ({ type: 'run_end', status: 'failed', result_code: rc });
  assert.equal(classify(0, { type: 'run_end', status: 'passed', result_code: 100 }), 'passed');
  assert.equal(classify(1, end(720)), 'failed');
  assert.equal(classify(1, end(310)), 'failed', 'stuck usually means the UI the flow needs is missing');
  assert.equal(classify(1, end(650)), 'failed', 'an HTTP error page is the app');
  assert.equal(classify(1, end(510)), 'flaky');
  assert.equal(classify(1, end(420)), 'flaky');
  assert.equal(classify(3, end(530)), 'timeout');
  assert.equal(classify(1, end(610)), 'blocked');
  assert.equal(classify(1, end(560)), 'error');
  assert.equal(classify(2, undefined), 'error');
  // Kane's own triage: the assertion misread a correct page -> not the app's fault
  assert.equal(classify(1, { type: 'run_end', status: 'failed', result_code: 710, verdict: { confirmed: false, family: 'automation_bug' } }), 'flaky');
  assert.equal(classify(1, { type: 'run_end', status: 'failed', result_code: 740, verdict: { confirmed: true, family: 'application_issue' } }), 'failed');
});

test('verify: a Kane infra error is re-run on its own, not reported as an app failure', () => {
  const dir = project(TWO_FLOWS, '<h1>Hello</h1><p>Each pays 30.00</p>');
  const r = cli(dir, ['verify'], { FAKE_KANE_FLAKY_ONCE: '1' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /FLAKY\s+greeting/);
  assert.match(r.out, /infra_error.screenshot_failed — re-running on its own \(1\/2\)/);
  assert.match(r.out, /PASSED\s+greeting.*\(retry 1\)/);
});

test('fix: a site blocker (captcha) stops the loop without calling the agent', () => {
  const dir = project(TWO_FLOWS);
  const r = cli(dir, ['fix'], { FAKE_KANE_BLOCKED: '1' });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /blocked blocker.captcha/);
  assert.equal(existsSync(join(dir, '.kane-loop', 'FIX_REQUEST.md')), false);
});

test('fix: a "fail" on code that already passed that flow is re-checked, not sent to the agent', () => {
  const dir = project(TWO_FLOWS);
  const script = JSON.stringify({ 'shows "Hello"': ['pass', 'fail', 'pass'], 'Each pays': ['fail', 'pass'] });
  // the agent changes nothing, so the app fingerprint stays identical between iterations
  const cfg = JSON.parse(readFileSync(join(dir, 'kane-loop.json'), 'utf8'));
  cfg.agent = 'node -e "0"';
  writeFileSync(join(dir, 'kane-loop.json'), JSON.stringify(cfg));
  const r = cli(dir, ['fix'], { FAKE_KANE_SCRIPT: script });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /greeting: Kane says failed, but this exact code \([0-9a-f]{12}\) passed it before — re-checking \(1\/2\)/);
  assert.match(r.out, /VERIFIED 2\/2 after 1 agent pass/);
  const hist = JSON.parse(readFileSync(join(dir, '.kane-loop', 'history.json'), 'utf8')).history;
  assert.equal(hist[1].flows.greeting, 'passed (re-run 1)');
  assert.equal(hist[0].appFingerprint, hist[1].appFingerprint);
});

test('fix: a flow whose verdict keeps flipping on identical code goes to a human, not the agent', () => {
  const dir = project(TWO_FLOWS, '<h1>Hello</h1><p>Each pays 30.00</p>');
  const script = JSON.stringify({ 'shows "Hello"': ['pass', 'fail', 'fail', 'fail'], 'Each pays': ['fail', 'pass'] });
  const cfg = JSON.parse(readFileSync(join(dir, 'kane-loop.json'), 'utf8'));
  cfg.agent = 'node -e "0"';
  writeFileSync(join(dir, 'kane-loop.json'), JSON.stringify(cfg));
  const r = cli(dir, ['fix'], { FAKE_KANE_SCRIPT: script });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /kane_loop.nondeterministic/);
  assert.match(r.out, /a human should look at the evidence/);
});
