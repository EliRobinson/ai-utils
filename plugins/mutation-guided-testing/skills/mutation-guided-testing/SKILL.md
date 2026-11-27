---
name: mutation-guided-testing
description: Use when writing or changing code with tests, especially Go, Python or TypeScript code that touches auth, tenants or ownership, error handling, expiry, environment config, money, dates, parsing, ranking, or UI component state (props, variants, disabled or aria state, controlled vs uncontrolled). Also use when asked whether tests really catch bugs, to judge or strengthen tests rather than raise coverage, or to triage mutation-testing survivors.
---

# Mutation-guided testing

**REQUIRED BACKGROUND:** `superpowers:test-driven-development` and its `writing-good-tests.md`. This skill runs inside that red-green-refactor loop; read those for the basics. It makes their mental "Mutation Check" executable: bugs you plant on purpose, and a mutation tool run on the diff.

**Core rule:** a test counts only if it fails when the code is wrong in a way that matters. Coverage is a map of code no test runs. It is never the goal.

`<skill-dir>` below is the folder this file is in. Run each script through its interpreter (`python3 …`, `bash …`).

## The loop

Do this for each commit-sized change, while you develop. It is not a review you run once the feature is done.

1. **Concerns first, before you write code.** Pick the 3 to 5 risks from [reference/concerns.md](reference/concerns.md) that this change could get wrong, including ones the task didn't mention. Write each one as a concrete bug: the line and the bad edit. Keep them in a table:

   | # | concern | bug (file: edit) | caught by |
   |---|---|---|---|

2. **Red.** Write the tests that would catch those bugs, the usual TDD way. Keep them DRY: case tables with shared fixtures, one behaviour per test, named after the bug it catches.
3. **Green.** Implement.
4. **Prove each concern.** Apply each bug, run the narrowest test command, see a failure, then revert. Fill in "caught by". A bug no test catches means a missing test, not a finished task: write or strengthen one and repeat. After the last revert, `git diff` must show only your intended changes.
5. **Run the tool on the diff only.**
   ```bash
   S="$(git rev-parse --absolute-git-dir)/mgt-scope.json"   # one scope per worktree
   python3 <skill-dir>/scripts/diff_scope.py --json "$S"    # prints the commands to run
   ```
   The scope is the merge base against the default branch, plus uncommitted and untracked files, without tests, stories, fixtures and generated code. Run the commands it prints; for Python it prints the `[tool.mutmut]` config, then follow the Python reference. Per language: [Go](reference/go.md), [Python](reference/python.md), [TypeScript](reference/typescript.md). Then rank the survivors:
   ```bash
   python3 <skill-dir>/scripts/survivors.py --scope "$S" --gremlins DIR=report.json ...
   ```
   It keeps mutants on changed lines, drops Tailwind/CSS class-string noise, ranks by risk, shows at most **7 × changed source files** (`--cap N` can only lower that), and lists every changed line no test runs.
6. **Triage every survivor shown.** A kill counts only if a test calls the code's public API, or renders and uses the component, and asserts the outcome. Each survivor ends one way:
   - **Killed:** preferably a stronger assertion in an existing test, or a new case in its table. Write a new test file only when no test covers the behaviour at all.
   - **Equivalent:** one line on why no input can tell the mutant from the original.
   - **Not worth testing:** one line naming the behaviour and why a wrong value is harmless, such as log wording.

   Class-string mutants are visual-only: report the count, don't list them. Then confirm the kills: if you changed source lines, re-run `diff_scope.py` first, then the tool on the files you touched.
7. **Property-based tests** when the change touches parsing, serialization, money, dates, ranking or data transforms: Hypothesis (Python), fast-check (TypeScript), rapid (Go). When they don't apply (most UI components), say so.
8. **Report** (in the PR body or the hand-off):
   - the concern table
   - the survivors and what happened to each
   - the diff mutation score, marked "not a gate"
   - coverage only as a list of changed lines no test runs (the "No coverage" line `survivors.py` prints)
   - existing tests that look tautological, with reasons. Never delete them in passing.

## Gates

- Every concern has a test that failed when its bug was planted.
- Every survivor shown is killed or has its one-line reason.
- There is no percentage gate, for mutation score or for coverage.

## Decision rules

| Situation | Do |
|---|---|
| The tool is missing | Install it into the repo as a dev dependency, a scratch venv or a local `GOBIN` (see the reference). Never install globally without asking. |
| The run would take more than ~10 min | Narrow it: changed files only, plus each file's own tests (`--testFiles`, `--files`, `source_paths`). Never mutate the whole repo by default. |
| Gremlins: every mutant killed in under ~0.1 s each | A false result: the build is failing. Use `go_mutate.sh`; if you already did, run `go vet` and `go test -count=1` on the package to find why, and don't trust the score. |
| Gremlins: "Runnable: 0" | A failure, not a clean result. Check the scope; use `--integration` or the package that tests it. |
| A package's tests live in another package | `go_mutate.sh --integration`, or mutate from the package that tests it. |
| Survivors are only class strings | Visual-only. Report the count; don't chase them. |
| Behaviour is tested only by Storybook play tests | Say so in the report. The unit runner can't see play tests. |
| A survivor sits in old code that only moved or was re-indented | Mark it "pre-existing, not in this change" and file it as follow-up work. |
| No mutants on changed lines | Check the scope (the base ref, the file filters) before you call the result clean. |

## Red flags: stop and redo the step

| Thought | Reality |
|---|---|
| "Coverage is 98%, so it's tested" | Line coverage can be high while most mutants survive. Coverage says a line ran, not that a test checked it. |
| "The spec didn't ask about tenant or error cases" | Concerns come from the risk checklist, not only from the spec. |
| "This survivor is equivalent", with no reason | Then it isn't. Name why no input tells them apart, or kill it. |
| "I'll grep the source or pin the constant so the mutant dies" | That's a change detector. Test the behaviour the constant drives, or mark it "not worth testing". |
| "I'll add a new test file for these survivors" | First strengthen the assertion that already runs that line. |
| "Let me mutate the whole package or repo" | Use the diff scope. A whole-package run can take many minutes per package. |
| "I'll do the mutation pass at the end" | Steps 4 and 5 run per change. A weak test costs least to fix while the code is fresh. |
| "The concern bug failed no test, but the code is right" | Right today isn't the point. Nothing stops it going wrong tomorrow. Add the test. |

## Repo notes

If a `local.md` exists, read it for the commands, configs and traps of the repos you're in. Look in `reference/local.md` next to this file, then `~/.claude/mutation-guided-testing/reference/local.md`. [reference/local.example.md](reference/local.example.md) shows its shape.
