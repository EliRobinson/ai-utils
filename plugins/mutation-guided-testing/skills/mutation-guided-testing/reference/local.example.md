# Local notes: example

Copy this file to `reference/local.md` and fill it in for the repos you work in. The skill reads `local.md` if it exists; this example holds only placeholders. Never commit a `local.md` to this plugin's repo: it holds your repo names, paths and commands. The README says where to keep it so a plugin update doesn't replace it.

These facts change faster than the skill, so re-check a command if it fails.

## <repo name> (default branch `<main>`)

### <project dir, e.g. packages/ui>

- **Tool:** Stryker with the `<vitest|jest|command>` runner, run from `<project dir>`.
- **Config:** unit-only Vitest config at `<path>`; Stryker config at `<path>`.
- **Run:** always pass `--testFiles` with the component's own tests.
- **Storybook:** second run with `<stories config>`; pass both reports to `survivors.py`.
- **Known flakes:** `<test file:line>` fails under heavy parallel load.

### <Go module dir>

- **Integration:** most tests live in `<package>`; run `go_mutate.sh <module dir> --integration --files '…' ./<pkg> -- --coverpkg=./...`.
- **Timeout:** needs `MGT_TIMEOUT=<n>`.
- **Skip:** `<package>` has timing tests that fail under coverage.

### <Python project dir>

- **Run:** mutmut from a scratch copy; `also_copy = ["<package>"]`.
- **Deselect:** `<marker>` tests need the network.

## Don't touch

- `<files or dirs another team owns>`
