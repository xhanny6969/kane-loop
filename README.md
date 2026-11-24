# kane-loop

**Your coding agent builds the app. Kane CLI proves whether it works. Anything that fails goes straight back to the agent, and the loop repeats until every flow passes in a real browser.**

AI coding agents ship fast and grade their own homework. kane-loop takes the grading away from them. You write the spec as plain-English user flows, Kane CLI drives a real Chrome through each one, and the failures (failed step, what Kane saw, the evidence path) become the agent's next task. The agent may only change the app. If it edits the spec to make a test pass, the edit is reverted and reported back to it.

```
flows.md ──▶ Kane CLI (real Chrome) ──▶ ✗ failures ──▶ FIX_REQUEST.md ──▶ agent edits the app
   ▲                                                                            │
   └──────────────────────────── re-run every flow ◀────────────────────────────┘
                                   ✓ all green ──▶ .kane-loop/verified.json ──▶ gate opens deploy
```

## Quickstart

```bash
npm install -g @testmuai/kane-cli github:xhanny6969/kane-loop   # Kane CLI + kane-loop (no git? use https://github.com/xhanny6969/kane-loop/archive/refs/heads/main.tar.gz)
kane-cli login                                                  # TestMu AI account (free credits)

cd my-app
kane-loop init                                      # writes flows.md + kane-loop.json
# edit flows.md: one "## heading" per user flow, plain English underneath
kane-loop verify                                    # Kane runs every flow, exit 0 only if all pass
kane-loop fix --agent claude                        # loop until green (hermes | claude | codex | gemini | kiro)
kane-loop gate -- npx wrangler pages deploy dist    # deploy only if every flow passes
kane-loop calibrate --runs 3                        # is each flow's verdict stable enough to trust?
```

Try it without spending credits, or replay the demo:

```bash
git clone https://github.com/xhanny6969/kane-loop && cd kane-loop
npm test                                            # 17 tests against a fake kane-cli and a fake agent
cd examples/splitbill && node ../../bin/kane-loop.mjs verify   # 4 real Kane runs against the built demo app
```

Node 20+, zero dependencies. Developed and recorded on Windows 11; the macOS/Linux code paths are not tested yet.

## The spec: `flows.md`

```markdown
# Split the bill
url: http://127.0.0.1:4173/
max-steps: 25

## tip is added before splitting
Enter 100 as the bill amount, 4 as the number of people and 10 as the tip percent,
then verify the page shows a total of 110.00 and that each person pays 27.50
```

- `## heading` starts a flow; the text under it is the Kane CLI objective.
- `url:`, `max-steps:`, `timeout:` at the top set defaults; inside a flow they override.
- Lines starting with `>` and HTML comments are notes for humans and are not sent to Kane.

## Commands

| Command | What it does | Exit code |
|---|---|---|
| `kane-loop verify` | Runs every flow through `kane-cli run --agent`, prints a verdict table, writes `.kane-loop/report.md` + `last-run.json` | 0 all pass · 1 something failed · 2 Kane could not start |
| `kane-loop fix --agent <a>` | Baseline verify, then for up to `--max-iter` passes: write `FIX_REQUEST.md`, run the agent, revert any spec edits, re-verify **all** flows (regressions count) | same |
| `kane-loop gate -- <cmd>` | Verify, then run `<cmd>` only on all-green | the command's exit code, or 1/2 |
| `kane-loop calibrate --runs 3` | Runs every flow N times on identical code (the app files are hashed and must not change) and classifies each flow as stable-pass, stable-fail, unstable or noisy. Writes `.kane-loop/calibration.md` + `.json` | 0 every flow stable · 1 stable failures · 2 unstable or noisy |
| `kane-loop static <dir>` | No-cache static server, so Kane never tests a stale copy of a page the agent just rewrote | — |

Useful options: `--serve "<cmd>"` starts the app and waits for `--url` to answer, then stops it afterwards · `--parallel 3` (launches are staggered, see below) · `--stall-timeout 600` / `--error-grace 90` kill a Kane run that hangs · `--headed` to watch the browser · `--only a,b` · `--bug-detection continue` · `--commit` adds a git commit per agent pass, so the history shows the loop. Everything can also go in `kane-loop.json`.

## How the loop decides

kane-loop reads Kane CLI's NDJSON stream contract (`stream_start` … step lines … `run_end`) and the exit code:

| Kane says | kane-loop verdict | What happens |
|---|---|---|
| exit 0, `run_end.status = passed` | ✓ passed | counted green |
| `3xx` stuck, `650` error page, `7xx` assertion (Kane confirms an application issue) | ✗ failed | failed step, Kane's summary, its bug report (title, root cause, suggested fix) and the evidence path → `FIX_REQUEST.md` |
| exit 3 / `530` | ⏱ timeout | handed to the agent like a failure |
| `2xx`, `4xx`, `510/520/540`, or any failure Kane's own triage marks *unconfirmed* and not an application issue (`automation_bug`, `environment_issue`) | ↻ flaky | **re-run on its own** (`--retries`, default 2). Never sent to the agent |
| `6xx` captcha, paywall, WAF, missing credentials | ⊘ blocked | loop stops: a human has to act |
| exit 2, `550` auth, `560` no credits | ! error | loop stops: a setup problem is not an app bug |

Guards that keep the agent honest, and keep it from being sent on wild-goose chases:
- **The spec is read-only.** `flows.md` and `kane-loop.json` are hashed before every agent pass and restored if they change; the next prompt says the edit was reverted.
- **No regressions.** Every pass re-runs every flow, so fixing flow B by breaking flow A doesn't count.
- **Evidence beats a single verdict.** kane-loop hashes the app files. If a flow already passed on this exact code and now "fails", it is re-checked instead of handed to the agent. A flow whose verdict keeps flipping on identical code is reported as `kane_loop.nondeterministic` for a human.
- **Parallel runs never share a browser.** With `--parallel`, the next Kane run starts only after the previous run's browser is up (first step event, at most `--launch-gap` 45 s). See *Kane CLI and parallel runs* below.
- **A hung Kane run is killed, not waited on.** A run that reports an internal error but never sends `run_end` (90 s), or prints nothing at all (600 s), is killed with its Chrome and re-run as a Kane problem, never sent to the agent.
- **A stamp you can check.** `verified.json` records the spec hash, the git commit of the verified code, the Kane CLI version and each run's public Test Manager link. It is only written on all-green.

## Agents

All agents get the same one-line instruction that points at `.kane-loop/FIX_REQUEST.md`. No multi-line prompt has to survive shell quoting on Windows, macOS or Linux.

| `--agent` | Runs |
|---|---|
| `hermes` | `hermes -z "<instruction>"` |
| `claude` | `claude -p "<instruction>" --permission-mode acceptEdits` |
| `codex` | `codex exec --full-auto "<instruction>"` |
| `gemini` | `gemini --yolo -p "<instruction>"` |
| `kiro` | `kiro-cli chat --no-interactive --trust-all-tools "<instruction>"` |
| anything else | your command; `{prompt}` / `{prompt_file}` are substituted |

## Demo: an app written only from Kane failures

`examples/splitbill` starts as an empty "Coming soon" page plus four flows: even split, tip before splitting, cents that add up exactly (no `33.33 × 3 = 99.99`), and rejecting zero people.

```bash
cd examples/splitbill
node ../../bin/kane-loop.mjs fix --agent hermes --commit --parallel 1
```

### Recorded run (24 Nov 2026, Kane CLI 0.10.8, Windows 11, Hermes Agent)

| Step | What happened |
|---|---|
| Baseline | 0/4. Kane filed four confirmed application bugs, e.g. *"Bill splitter page displays Coming soon instead of calculator"* |
| Agent pass 1 (110 s) | Hermes read `FIX_REQUEST.md` and built the calculator → commit [`b1cbd9a`](https://github.com/xhanny6969/kane-loop/commit/b1cbd9a) |
| Re-verify | **4/4 passed** in a real Chrome → commit [`254859b`](https://github.com/xhanny6969/kane-loop/commit/254859b), [`verified.json`](examples/splitbill/.kane-loop/verified.json) |

Wall clock 10 min 51 s, about 72 Kane credits. Every verdict is public:

| Flow | Verdict | Kane time | Credits | Evidence |
|---|---|---|---|---|
| even-split | ✓ passed | 50.9s | 11.9 | [Kane run](https://test-manager.lambdatest.com/projects/01M85XF6009JA4MV9V1H6PG1ZH/test-cases/01M85ZDFWXEJE4H9SNN4323Z0F/dashboard/share/US_IL1E7TU9ZTXIU3XC57NV7VSUJWT1F2I554UMTW08Y1DQNIMWT11GUR1GE6L88OJN?type=summary&agentView=true&fqdn=summary-page) |
| tip-is-added-before-splitting | ✓ passed | 46.7s | 12.4 | [Kane run](https://test-manager.lambdatest.com/projects/01M85XF6009JA4MV9V1H6PG1ZH/test-cases/01M85ZG5D4BYSEXVY490TDD6PH/dashboard/share/US_B33HOYXUYN5XZKI6EMR4C90UOO7IR2SKRPB1PDTAH8CN74Z4O00ZEU9XNDNHTKIW?type=summary&agentView=true&fqdn=summary-page) |
| cents-add-up-exactly | ✓ passed | 49.9s | 16.8 | [Kane run](https://test-manager.lambdatest.com/projects/01M85XF6009JA4MV9V1H6PG1ZH/test-cases/01M85ZJK173CF2QBVF8BMCXGQ1/dashboard/share/US_NUALFUTHHI1Q5FQWUZY7Z15IBPKHKQRMBUR2DLF17MKXMM7NKGQLZEDIB78ISQCL?type=summary&agentView=true&fqdn=summary-page) |
| zero-people-is-rejected | ✓ passed | 48.8s | 6.7 | [Kane run](https://test-manager.lambdatest.com/projects/01M85XF6009JA4MV9V1H6PG1ZH/test-cases/01M85ZN1W5GKR3KHA6SQ7G3A9C/dashboard/share/US_WKX00280GVMO0W3ATPQKT42FSXBTCPANFYSL55LPJOTWGBLI463LN6KGN38TG6ZT?type=summary&agentView=true&fqdn=summary-page) |

### What the first real run taught us

The first attempt used a naive loop that sent every Kane failure to the agent, with `--parallel 2`. After agent pass 1 the app was correct: every flow passed at least once in the following re-runs, and Hermes made no edits after pass 1. Yet across three re-runs Kane reported **7 failures**: browser sessions closed before a screenshot (`510`, 3×), final assertions that misread correct values (`710`, 3×), and one *confirmed* bug, "Bill splitter resets other inputs after field updates", that the code has no logic for. Hermes, reading Kane's own triage in the fix request, refused to edit the app three times in a row, but the loop could never go green. That run is why kane-loop re-runs infra failures, trusts Kane's *unconfirmed* triage, and re-checks any failure on code that already passed that flow.

Those failures had a cause, and it was not the app.

## Kane CLI and parallel runs

Two `kane-cli run` processes that start at the same moment can end up driving **the same Chrome** (Kane CLI 0.10.8, Windows 11).

- Kane picks its CDP port by probing `127.0.0.1:9222`–`9230` and taking the first port that refuses a connection, then talks to `http://127.0.0.1:<port>`.
- When `127.0.0.1:<port>` is already taken, Chrome on Windows listens on `[::1]:<port>` instead, so a second probe still sees the port as free.
- Two runs that start together therefore pick the same port. One Chrome holds `127.0.0.1`, the other `[::1]`, and **both** Kane processes connect to the first one. They type over each other's inputs. When one finishes it closes the page, and the other gets `TargetClosedError`.

`scripts/cdp-port-race.mjs` reproduces this with plain headless Chrome. It uses no Kane runs and no credits:

```
$ node scripts/cdp-port-race.mjs together
  run A: picked port 9231; http://127.0.0.1:9231 is answered by "run A"
  run B: picked port 9231; http://127.0.0.1:9231 is answered by "run A"
  listening on 9231: TCP 127.0.0.1:9231  |  TCP [::1]:9231
  -> both runs drive ONE browser
$ node scripts/cdp-port-race.mjs staggered
  run A: picked port 9231; http://127.0.0.1:9231 is answered by "run A"
  run B: picked port 9232; http://127.0.0.1:9232 is answered by "run B"
  -> each run drives its own browser
```

Kane's own session logs (`~/.testmuai/kaneai/sessions/*/tui.log`) show the same thing in real runs. Two runs that started in the same second kept re-typing the bill amount: 11 s after one typed 100, the other (which had to enter 90) logged "Pressing down to decrease the bill amount". Every `TargetClosedError` landed 0–11 s after the other run finished. Once, Kane then emitted `{"type":"error"}` and never exited: no `run_end` for 1 h 47 min, until it was killed.

All Kane runs on the correct splitbill code on 24 Nov, from Kane's session logs:

| How the run started | Runs | Passed | Failed | Hung |
|---|---|---|---|---|
| within 3 s of another Kane run (no launch gap) | 12 | 3 | 8 (`710` ×4, `510` ×3, `740` ×1) | 1 |
| alone, or after the other run's browser was up | 36 | **36** | 0 | 0 |

Same app, same four flows, 3 runs each (`kane-loop calibrate --runs 3`):

| Setting | Result | Wall clock | Credits |
|---|---|---|---|
| `--parallel 1` | 12/12 stable-pass | 18 min 53 s | 174.8 |
| `--parallel 2`, launches together (before the fix) | round 1: one false `710`, one run hung for 1 h 47 min | — | — |
| `--parallel 2`, staggered launch (kane-loop now) | **12/12 stable-pass** | **8 min 53 s** | 167.1 |

kane-loop now staggers launches by default and kills hung runs. If you call Kane yourself from scripts or CI, start parallel runs a few seconds apart or give each one its own `--cdp-endpoint`.

## Tests

`npm test` runs the whole loop end to end against test doubles in `test/fixtures/`: a fake `kane-cli` that emits the real NDJSON shape, exit codes and result codes (including scripted pass/fail sequences), and a fake agent (one variant cheats by rewriting the spec). 17 tests cover flow parsing, result-code classification, the fix loop reaching green, spec-edit revert, infra errors re-run instead of reported, captcha/auth stopping the loop without calling the agent, re-checking a failure on code that already passed, flipping verdicts going to a human, calibrate's stability classes, a Kane run that hangs after an internal error being killed and re-run, parallel launches never overlapping, and the deploy gate staying closed on red.

## License

MIT
