# Python: mutmut

Verified with mutmut 3.x under uv (November 2026). The recipe pins mutmut to exactly **3.8.1**, the latest 3.x release on PyPI when this was written, so a new release never runs on your code unreviewed. To update it, check the release notes, change the version in the `mm()` line below and in the plugin README, and rerun the recipe once on a small change. The pin covers mutmut only: uv still resolves its dependencies fresh on each run, which is one reason the recipe runs in a scratch copy without `.git`.

mutmut writes a `mutants/` directory and reads its config from `[tool.mutmut]` in `pyproject.toml`. Run it in a scratch copy, so neither ends up in a commit, and run it through `uv run --with 'mutmut==3.8.1'` (or a throwaway venv with that version), never a global install.

```bash
S="$(git rev-parse --absolute-git-dir)/mgt-scope.json"   # diff_scope.py wrote it
mm() { uv run --with 'mutmut==3.8.1' mutmut "$@"; }        # the pinned version (see above)
P=$(mktemp -d); rsync -a --exclude .git --exclude .venv --exclude __pycache__ --exclude mutants <project>/ $P/
(
cd $P && cat >> pyproject.toml <<'EOF'

[tool.mutmut]
source_paths = ["pkg/changed_module.py"]                                 # the changed files, from diff_scope.py
pytest_add_cli_args_test_selection = ["tests/test_changed_module.py"]    # their own tests
also_copy = ["pkg"]                                                      # the top-level package; without it tests can't import
EOF
mm run --max-children 8
mm results > results.txt      # non-killed only: "name: survived" / "name: no tests"
for m in $(sed -n 's/^ *\([^:]*\): .*/\1/p' results.txt); do mm show "$m"; done > show.txt
)                             # back in the repo: survivors.py runs from the repo diff_scope.py scanned
python3 <skill-dir>/scripts/survivors.py --scope "$S" --mutmut <project>=$P/show.txt
```

`<project>` is the repo-relative dir that holds `pyproject.toml`, as `diff_scope.py` prints it.

Notes:

- **Keys:** `paths_to_mutate` and `tests_dir` are deprecated in mutmut 3. Use `source_paths`, `also_copy` and `pytest_add_cli_args_test_selection`.
- **No diff mode:** mutmut can't scope by diff, so `source_paths` built from `diff_scope.py` is the scope. `survivors.py` then keeps only the changed lines.
- **Line numbers:** the hunk line numbers in `mutmut show` count from the mutated function, not the file. `survivors.py` maps them back to file lines through the `def` line in your working tree, so run it before you edit that file again. It warns about any mutant whose function it can't find.
- **Statuses:** `survivors.py` maps every mutmut status (`MUTMUT_STATUS` and `MUTMUT_NOT_RUN` in the script). Two are worth knowing: `suspicious` counts as a survivor, and a mutant that never ran (`not checked`, `skipped`) is left out.
- **No score:** the report above lists only the mutants mutmut did not kill, so `survivors.py` prints "n/a" for mutmut's score. That is fine: the score is not a gate.
- **Test selection matters:** too narrow a selection shows many "no tests" mutants that wider tests would kill. If many show "no tests", widen the selection to the tests that import the module.
- **Slow or networked tests:** keep them deselected, the way the repo's default markers do.

Runtime guide (indicative: one laptop): one module, 372 mutants, ~160 s with 8 children.
