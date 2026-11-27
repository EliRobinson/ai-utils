# Go: Gremlins

Verified with Gremlins 0.6.x (November 2026).

## Install (local, never global)

```bash
GOBIN=$PWD/.tools/bin go install github.com/go-gremlins/gremlins/cmd/gremlins@v0.6.0
export GREMLINS=$PWD/.tools/bin/gremlins     # keep .tools/ out of commits
```

A scratch `GOBIN` outside the repo works too. Never `go install` it into your global `GOBIN` without asking.

## Run on the diff

```bash
python3 <skill-dir>/scripts/diff_scope.py --json /tmp/scope.json
bash <skill-dir>/scripts/go_mutate.sh <module-dir> --files '<changed files>' [--integration] ./<pkg> ...
python3 <skill-dir>/scripts/survivors.py --scope /tmp/scope.json --gremlins <module-dir>/<pkg>=<report.json>
```

`diff_scope.py` prints the `go_mutate.sh` line, and `go_mutate.sh` prints the `--gremlins` arguments. Anything after `--` goes to Gremlins as it is, for example `-- --coverpkg=./...`.

## The traps, and what `go_mutate.sh` does about them

- **Relative `replace` paths.** Gremlins copies only the module dir to `$TMPDIR`, so `replace x => ../x` breaks every build, and Gremlins counts each failed build as a kill: a false 100%. `go_mutate.sh` runs on a copy whose `go.mod` replaces are absolute. The tell is kills that take under ~0.1 s each; `survivors.py` warns when it sees that.
- **`--diff` in a monorepo silently skips everything.** It compares repo-root paths with module-relative ones and mutates nothing. Treat "Runnable: 0" as a failure, never as a clean result; `go_mutate.sh` exits non-zero when no mutant ran. Two ways round it:
  - Per changed package with `--exclude-files` for the unchanged files. This is what `go_mutate.sh --files` does, and `survivors.py` then keeps only the changed lines.
  - Or keep `--diff` and make git print module-relative paths: from the module root, run `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.relative GIT_CONFIG_VALUE_0=true gremlins unleash --diff <base> .`
- **Cached test results.** The coverage pass reads cached results, the per-mutant timeout becomes tiny, and almost everything "times out". `go_mutate.sh` sets `GOFLAGS=-count=1`.
- **Tight timeouts.** `go_mutate.sh` passes `--timeout-coefficient 10`. Raise it with `MGT_TIMEOUT` for slow packages.
- **Mutators off by default.** `go_mutate.sh` turns on `--invert-logical` and the other `--invert-*` and `--remove-self-assignments` mutators. Without them, `||` ↔ `&&` in a token check and `continue` ↔ `break` in a path matcher are never generated.
- **Tests that live in another package.** The package shows every mutant as "not covered". Use `--integration` (the whole module's tests run per mutant, which is slow), or mutate from the package that tests it with `-- --coverpkg=./...`. `go_mutate.sh` adds `--integration` on its own for a package with no `_test.go`.
- **One run at a time.** Two Gremlins runs at once compete for CPU and give false timeouts.
- **Never use a full-module `-race` suite as the per-mutant test command.**

## Gaps in Gremlins' mutators

Gremlins has no "remove call", "return the zero value" or "delete statement" mutator, and it doesn't negate a call such as `if !strings.EqualFold(a, b)`. So a swallowed error, a missing auth guard and a missing lock are never generated. Those come from the concern bugs you plant in step 4, which is why that step is required for Go.

## Runtime guide (laptop, November 2026)

| Target | Mutants | Time |
|---|---|---|
| One package, 2 changed files | 32 | ~100 s |
| The same package, whole | 402 | ~8.5 min |
| A router package, `--integration` | 455 (68 covered) | ~90 s |
