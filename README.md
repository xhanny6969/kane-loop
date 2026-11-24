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
npm install -g @testmuai/kane-cli      # Kane CLI
kane-cli login                         # TestMu AI account (free credits)
git clone https://github.com/xhanny6969/kane-loop && cd kane-loop
npm test                               # 8 tests, no credits needed (Kane + agent test doubles)
```

Point it at your own project:

```bash
cd my-app
node /path/to/kane-loop/bin/kane-loop.mjs init      # writes flows.md + kane-loop.json
# edit flows.md: one "## heading" per user flow, plain English underneath
kane-loop verify                                    # Kane runs every flow, exit 0 only if all pass
kane-loop fix --agent claude                        # loop until green (hermes | claude | codex | gemini | kiro)
kane-loop gate -- npx wrangler pages deploy dist    # deploy only if every flow passes
```

Node 20+, zero dependencies.

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
| `kane-loop static <dir>` | No-cache static server, so Kane never tests a stale copy of a page the agent just rewrote | — |

Useful options: `--serve "<cmd>"` starts the app and waits for `--url` to answer, then stops it afterwards · `--parallel 3` · `--headed` to watch the browser · `--only a,b` · `--bug-detection continue` · `--commit` adds a git commit per agent pass, so the history shows the loop. Everything can also go in `kane-loop.json`.

## How the loop decides

kane-loop reads Kane CLI's NDJSON stream contract (`stream_start` … step lines … `run_end`) and the exit code:

| Kane exit | kane-loop verdict | What happens |
|---|---|---|
| 0 and `run_end.status = passed` | ✓ passed | counted green |
| 1 | ✗ failed | failing step remark, Kane's summary, bug verdict (if `--bug-detection`), evidence path → `FIX_REQUEST.md` |
| 3 | ⏱ timeout | treated as a failure the agent must fix |
| 2 (not logged in, no URL, no Chrome) | ! error | **the agent is not called.** A setup problem is not an app bug, and sending it to the agent would make it "fix" code that isn't broken |

Guards against reward hacking:
- `flows.md` and `kane-loop.json` are hashed before every agent pass and restored if they change. The next prompt tells the agent its spec edit was reverted.
- Every pass re-runs every flow, so fixing flow B by breaking flow A doesn't count.
- `verified.json` records the spec hash, the git commit, the Kane CLI version and each run's Test Manager link. It is only written on all-green.

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
node ../../bin/kane-loop.mjs fix --agent hermes --commit
```

## Tests

`npm test` runs the whole loop end to end against test doubles in `test/fixtures/`: a fake `kane-cli` that emits the real NDJSON shape and exit codes, and a fake agent (one variant cheats by rewriting the spec). Covered: flow parsing, verdict mapping for exit codes 0/1/2/3, the fix loop reaching green, spec-edit revert, exit 2 never reaching the agent, and the deploy gate staying closed on red.

## License

MIT
