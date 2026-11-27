# Changelog

## 0.1.0

**Upgrade steps:**

1. The plugin is opt-in. To try it: `claude plugin marketplace update ai-utils`, then `claude plugin install mutation-guided-testing@ai-utils`, then restart Claude Code.
2. Optional: write your per-repo notes in `~/.claude/mutation-guided-testing/reference/local.md`, starting from `reference/local.example.md`.

**Changes:**

- **New plugin, a proof of concept.** The `mutation-guided-testing` skill makes the tests an agent writes catch bugs, not just raise coverage. Inside the red-green-refactor loop it names 3 to 5 concrete bugs from a risk checklist before the code, proves a test fails for each, runs a mutation tool on the diff only, and triages at most 7 survivors per changed source file. There is no percentage gate. It extends Superpowers `test-driven-development` and links to it for the basics.
- `reference/` has the risk checklist with one bug shape per language, and recipes and traps for Gremlins 0.6.x, mutmut 3.x and StrykerJS 10.x.
- `scripts/diff_scope.py` finds the changed lines against the merge base and suggests the commands. `scripts/survivors.py` turns Gremlins, Stryker and mutmut reports into a ranked, capped triage table. `scripts/go_mutate.sh` runs Gremlins without its known traps.
- `scripts/tests/` runs the scripts against throwaway git repos and recorded report samples. `scripts/validate-plugins.py` now runs every skill's `scripts/tests/`, so CI runs them.
