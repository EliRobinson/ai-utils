# mutation-guided-testing

**Status: proof of concept, opt-in.** The plugin is not enabled by default. No other plugin in this marketplace requires it or names it in a default brief, agent-roster included. Install it only if you want to try it.

## What it does

It makes the tests an agent writes catch bugs, rather than just raise coverage. The agent uses it while it develops, inside the red-green-refactor loop, not as a review step afterwards:

1. **Before writing code,** it names 3 to 5 concrete bugs this change could have, from a risk checklist: fail-open on error, a swallowed error, a missing auth, tenant or ownership check, expiry not enforced, a silent environment fallback, an off-by-one, a race, a non-constant-time secret comparison, and for UI components an ignored prop, missing disabled or aria state, controlled vs uncontrolled drift, and a dropped handler or id.
2. **Red, then green,** the usual TDD way.
3. **After green,** it plants each bug, watches a test fail, and reverts. This catches the bug classes mutation tools never generate, such as a deleted guard or a swallowed error.
4. **It runs a mutation tool on the changed lines only:** Gremlins (Go), mutmut (Python) or StrykerJS (TypeScript).
5. **It triages at most 7 × (changed source files) survivors,** ranked by risk. Each is killed, preferably with a stronger assertion in an existing test, or justified in one line as equivalent or not worth testing. There is no percentage gate.
6. **It adds property-based tests** where inputs have structure: parsing, serialization, money, dates, ranking, data transforms.

Its report has the concern table, each survivor and what happened to it, the diff mutation score marked "not a gate", coverage only as a list of changed lines no test runs, and any existing tests that look tautological.

## When it triggers

When an agent writes or changes code with tests, especially Go, Python or TypeScript code that touches auth, tenants, error handling, expiry, environment config, money, dates, parsing, ranking or UI component state. Also when you ask whether the tests really catch bugs, or to triage mutation-testing survivors.

## How it relates to Superpowers TDD

It extends the Superpowers `test-driven-development` skill and its `writing-good-tests.md`, and does not replace them. Their "Mutation Check" is a mental exercise; this skill makes it executable, and steers it toward risks the spec didn't mention. It links to those files for the basics rather than repeating them.

## Why

- **Coverage is a weak signal.** Inozemtseva and Holmes, "Coverage Is Not Strongly Correlated with Test Suite Effectiveness" ([ICSE 2014](https://doi.org/10.1145/2568225.2568271)), found that coverage correlates only weakly with how many faults a suite finds once suite size is controlled for. So coverage here is a map of untested code, never a target.
- **Mutate only the diff, cap the survivors, don't chase a score.** Petrović, Ivanković, Fraser and Just, "Practical Mutation Testing at Scale: A view from Google" ([arXiv:2102.11378](https://arxiv.org/abs/2102.11378)), shows that surfacing a few mutants on changed lines during code review is what makes mutation testing usable, rather than a whole-program mutation score.
- **Mutants from a plain-English concern.** Meta's ACH, "Mutation-Guided LLM-based Test Generation at Meta" ([arXiv:2501.12862](https://arxiv.org/abs/2501.12862)), generates mutants from a stated concern and then writes tests that kill them. The concern bugs named before the code are that idea, done by hand inside the loop.
- **Property tests where inputs have structure.** Maaz et al., "Agentic Property-Based Testing: Finding Bugs Across the Python Ecosystem" ([arXiv:2510.09907](https://arxiv.org/abs/2510.09907), NeurIPS 2025 DL4C Workshop), has agents write property-based tests; the skill's property-based step uses them where inputs have structure, and says so when they don't apply.

## Files

```
skills/mutation-guided-testing/
  SKILL.md                    the loop, gates, decision rules and red flags
  reference/concerns.md       the risk checklist, with one concrete bug shape per language
  reference/go.md             Gremlins: install, commands and traps
  reference/python.md         mutmut: config, commands and traps
  reference/typescript.md     StrykerJS: config, commands and traps
  reference/local.example.md  the shape of your own per-repo notes (placeholders only)
  scripts/diff_scope.py       changed files and line ranges vs the merge base, grouped by
                              language root; suggested commands; JSON out
  scripts/survivors.py        reads tool reports, keeps changed lines, drops class-string
                              noise, ranks, caps, prints a triage table
  scripts/go_mutate.sh        Gremlins wrapper that handles its traps
  scripts/tests/              runs the scripts against throwaway git repos and recorded
                              report samples
```

`go_mutate.sh` works round Gremlins' traps, such as relative `replace` paths that turn every failed build into a false kill; `reference/go.md` lists them under "The traps".

## Your per-repo notes

Commands and traps that belong to one repo (which packages need `--integration`, which Vitest config to use, which tests are flaky) go in a `local.md` that you keep, never in this repo. The skill reads the first of these that exists:

1. `reference/local.md` next to `SKILL.md`, if you copied the skill into your own skills folder.
2. `~/.claude/mutation-guided-testing/reference/local.md`. Use this one with a plugin install, because a plugin update replaces the plugin's own folder.

Start from `reference/local.example.md`. This repo's `.gitignore` keeps a `local.md` out of commits.

## Requirements

- Python 3.9 or later, git, bash and rsync. The scripts use only the Python standard library.
- Mutation tools are installed per repo or in a scratch location, never globally:
  - **Gremlins** 0.6.x in a local `GOBIN`.
  - **mutmut** 3.x through `uv run --with 'mutmut>=3,<4'` in a scratch copy.
  - **StrykerJS** 10.x as a dev dependency on your branch.

## Tests

```bash
python3 -m unittest discover -s skills/mutation-guided-testing/scripts/tests
```

They need no mutation tool: they run the scripts against throwaway git repos, report samples in each tool's format and a stand-in for Gremlins. One extra test runs real Gremlins when `GREMLINS` points at a gremlins binary and `go` is installed. The repo's `python3 scripts/validate-plugins.py` runs these tests too, so CI does.
