# TypeScript: StrykerJS

Verified with `@stryker-mutator/core` 10.x and its Vitest runner (November 2026).

## Install (in the project; don't commit it unless the repo adopts the tool)

```bash
pnpm add -D @stryker-mutator/core@10 @stryker-mutator/vitest-runner@10   # -w at a pnpm workspace root; npm: npm i -D …
# Jest: @stryker-mutator/jest-runner. node:test has no runner: use the command runner (below).
```

**Never commit `.stryker-tmp/` or `reports/`.** Many repos don't ignore them yet; check `git status` before you commit.

## Config: `stryker.config.mjs`, minimal, Vitest

```js
export default {
  plugins: ["@stryker-mutator/vitest-runner"],   // required under pnpm, or no runner is found
  testRunner: "vitest",
  vitest: { configFile: "vitest.stryker.config.ts" },  // a unit-only config; see below
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  incrementalFile: "reports/stryker-incremental.json",
  tempDirName: ".stryker-tmp",                    // never under node_modules, or Vitest finds no tests
  concurrency: 4,
};
```

- **Unit-only Vitest config.** The Vitest runner has no project filter. If the main config also defines browser or Storybook projects, Stryker starts them all. Point it at a config that has only the unit project.
- **pnpm.** List the runner in `plugins: [...]`, as above, or Stryker finds no runner.
- **Temp dir.** Keep `tempDirName` out of `node_modules`.

## Run on the diff

```bash
S="$(git rev-parse --absolute-git-dir)/mgt-scope.json"
python3 <skill-dir>/scripts/diff_scope.py --json "$S"     # prints --mutate spans and --testFiles
cd <project> && npx --no-install stryker run --ignoreStatic \
  --mutate "src/a.tsx:40-58,src/b.ts:10-12" \
  --testFiles "src/a.test.tsx,src/b.test.ts"
python3 <skill-dir>/scripts/survivors.py --scope "$S" --stryker <project>=<project>/reports/mutation/mutation.json
```

- **`npx --no-install`:** without it, a missing local Stryker makes npx offer the unrelated, old `stryker` package from npm.
- **`--mutate "file:start-end"`** comes from the diff, so only changed lines are mutated.
- **`--testFiles`:** run the changed files' own tests. That gave the same kills as the "related" tests at about a fifth of the dry-run cost. `diff_scope.py` adds the sibling `*.test.*` and `*.spec.*` files it finds, and says so when a file has none.
- **`--ignoreStatic`:** static mutants (module-level constants, `cva(...)` calls) cost most of the run time and are mostly class strings. When you change a module-level `cva(...)` call, run once without it, because it also hides `defaultVariants` mutants.
- **`--incremental`** reuses results, but the dry run always re-runs in full, so it saves less than `--testFiles`.

## Other runners and compilers

- **`node:test`:** use `testRunner: "command"` with `commandRunner: { command: "node --test <the changed files' tests>" }`. With `coverageAnalysis: "off"`, every mutant runs that command, so keep it narrow. Tests that read files outside the project break in Stryker's sandbox copy.
- **Jest:** `testRunner: "jest"` with `@stryker-mutator/jest-runner`, also listed in `plugins` under pnpm.
- **TypeScript 7 (native compiler):** the JS compiler API is gone, and Stryker crashes with `ts.parseConfigFileTextToJson is not a function`. Set `tsconfigFile` to a file that doesn't exist, such as `"tsconfigFile": "no-such-tsconfig.json"`, in the config file; it isn't a CLI flag. If npm then crashes with `edgesOut`, install with `--legacy-peer-deps`.
- **Debug logging:** `--logLevel debug` has crashed Stryker and left `.stryker-tmp/` behind. Delete it before the next run.

## Reading UI survivors

- **Class strings:** `StringLiteral` mutants on Tailwind/CSS class strings (`cn(...)`, `cva(...)`) are visual-only. `survivors.py` counts them and leaves them out of the list. Visual or accessibility snapshot tests own them.
- **Storybook play tests:** a unit-runner Stryker run can't see them, so a survivor may already be killed by a story. Say so in the report; don't count it as killed. To count them, run Stryker a second time with a Storybook Vitest config and pass both reports to `survivors.py` (two `--stryker <project>=…` arguments): a mutant counts as killed if either run killed it.
- **Layout:** jsdom can't observe layout (popup placement, sizes). Mark those survivors "browser-only".

## Runtime guide (indicative: one laptop, November 2026)

| Target | Mutants | Time |
|---|---|---|
| One component, whole file, "related" tests | 49 | ~520 s |
| Two components, `--mutate` spans and `--testFiles` | 70 | ~120 s |
| One small module | 24 | ~20 s |
| Two files, command runner | 195 | ~70 s (~20 s incremental) |
