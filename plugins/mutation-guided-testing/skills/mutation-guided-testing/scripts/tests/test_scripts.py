"""Run the skill's scripts against throwaway git repos and recorded report samples.

    python3 -m unittest discover -s scripts/tests     (from the skill folder)

No mutation tool is needed: the reports in fixtures/ are samples in each
tool's real format, and fixtures/fake-gremlins stands in for Gremlins. The
last test runs real Gremlins, and is skipped unless GREMLINS points at a
gremlins binary and `go` is installed.
"""
import copy
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
FIXTURES = os.path.join(HERE, "fixtures")
sys.path.insert(0, SCRIPTS)
import survivors  # noqa: E402  (the pure helpers; the scripts themselves run as processes)

# Keep the user's git config (signing, hooks, templates) out of the test repos.
GIT_ENV = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}


def run(cwd, *cmd, env=None, check=True):
    return subprocess.run(cmd, cwd=cwd, check=check, capture_output=True, text=True,
                          env={**os.environ, **GIT_ENV, **(env or {})})


def split_shell(line):
    """A command line's words as a shell reads them; `(`, `)` and `&&` are words."""
    lex = shlex.shlex(line, posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    return list(lex)


def write(root, rel, text):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(textwrap.dedent(text).lstrip("\n"))


def fixture(name):
    with open(os.path.join(FIXTURES, name)) as f:
        return json.load(f) if name.endswith(".json") else f.read()


class Repo:
    """A git repo whose `origin/main` is a base commit holding `base_files`."""

    def __init__(self, test, base_files, prefix="mgt-test-"):
        self.dir = os.path.realpath(tempfile.mkdtemp(prefix=prefix))
        test.addCleanup(shutil.rmtree, self.dir)
        run(self.dir, "git", "init", "-q", "-b", "main")
        self.commit(base_files)
        run(self.dir, "git", "update-ref", "refs/remotes/origin/main", "HEAD")

    def commit(self, files):
        for rel, text in files.items():
            write(self.dir, rel, text)
        run(self.dir, "git", "add", "-A")
        run(self.dir, "git", "commit", "-qm", "change", "--allow-empty")

    def scratch(self, name):
        """A path under .git/, so test output never shows up in the diff."""
        return os.path.join(self.dir, ".git", name)

    def diff_scope(self, *args, check=True):
        return run(self.dir, sys.executable, os.path.join(SCRIPTS, "diff_scope.py"), *args,
                   check=check)

    def scope(self):
        out = self.scratch("scope.json")
        self.diff_scope("--base", "origin/main", "--json", out)
        with open(out) as f:
            return json.load(f)

    def commands(self):
        """diff_scope.py's suggested command lines, split as a shell would."""
        out = self.diff_scope("--base", "origin/main").stdout.split("Suggested commands", 1)[1]
        return [split_shell(line) for line in out.splitlines()[1:]
                if not line.lstrip().startswith("#")]

    def save(self, name, data):
        path = self.scratch(name)
        with open(path, "w") as f:
            f.write(data if isinstance(data, str) else json.dumps(data))
        return path

    def survivors(self, scope, *args, check=True):
        return run(self.dir, sys.executable, os.path.join(SCRIPTS, "survivors.py"),
                   "--scope", self.save("scope-in.json", scope), *args, check=check)

    def triage(self, scope, *args):
        """survivors.py's --json result for these report arguments, and the process."""
        out = self.scratch("triage.json")
        proc = self.survivors(scope, *args, "--json", out)
        with open(out) as f:
            return json.load(f), proc


def gremlins_report(*mutations):
    """fixtures/gremlins-report.json, with these mutations in its one file."""
    rep = fixture("gremlins-report.json")
    if mutations:
        rep["files"][0]["mutations"] = list(mutations)
    return rep


GO_BASE = {"svc/go.mod": "module example.com/svc\n\ngo 1.22\n",
           "svc/auth/auth.go": "package auth\n\nfunc A() int { return 1 }\n"}
VITEST_PKG = '{"devDependencies":{"vitest":"5"}}'


class DiffScopeTest(unittest.TestCase):
    def setUp(self):
        self.repo = Repo(self, GO_BASE)

    def paths(self):
        return [f["path"] for f in self.repo.scope()["files"]]

    def test_counts_committed_unstaged_and_untracked_changes(self):
        self.repo.commit({"svc/auth/a.go": "package auth\n"})
        write(self.repo.dir, "svc/auth/auth.go", "package auth\n\nfunc A() int { return 2 }\n")
        write(self.repo.dir, "svc/auth/new.go", "package auth\n\nvar X = 1\n")
        self.assertEqual(self.paths(), ["svc/auth/a.go", "svc/auth/auth.go", "svc/auth/new.go"])

    def test_leaves_out_files_that_are_not_mutation_targets(self):
        self.repo.commit({
            "svc/auth/auth_test.go": "package auth\n",
            "web/src/Button.test.tsx": "x\n",
            "web/src/Button.stories.tsx": "x\n",
            "web/src/types.d.mts": "x\n",
            "web/node_modules/lib/index.js": "x\n",
            "py/tests/test_load.py": "x\n",
            "py/conftest.py": "x\n",
            "svc/gen/api.go": "// Code generated by oapi. DO NOT EDIT.\npackage gen\n",
            "py/pkg/api_pb2.py": "# Generated by the protocol buffer compiler.  DO NOT EDIT!\n",
            "web/vite.config.ts": "x\n",
            "docs/readme.md": "x\n",
        })
        self.assertEqual(self.paths(), [])

    def test_a_file_that_only_mentions_the_generated_marker_is_still_a_target(self):
        self.repo.commit({"py/scope.py": '# Skips files headed "DO NOT EDIT" or @generated.\nX = 1\n'})
        self.assertEqual(self.paths(), ["py/scope.py"])

    def test_esm_and_cjs_typescript_files_are_targets(self):
        self.repo.commit({"web/a.mts": "export const a = 1;\n", "web/b.cts": "exports.b = 1;\n"})
        self.assertEqual(self.paths(), ["web/a.mts", "web/b.cts"])

    def test_records_only_added_or_changed_lines(self):
        self.repo.commit({"svc/auth/auth.go":
                          "package auth\n\nfunc A() int { return 2 }\n\nfunc B() {}\n"})
        self.assertEqual(self.repo.scope()["files"][0]["lines"], [[3, 5]])

    def test_git_diff_prefix_settings_do_not_change_the_paths(self):
        for key in ("diff.noprefix", "diff.mnemonicPrefix"):
            with self.subTest(key):
                run(self.repo.dir, "git", "config", key, "true")
                self.repo.commit({"svc/auth/auth.go": f"package auth\n\n// {key}\n"})
                self.assertEqual(self.paths(), ["svc/auth/auth.go"])

    def test_an_added_line_that_starts_with_plus_signs_is_not_a_file_header(self):
        self.repo.commit({"svc/auth/auth.go":
                          "package auth\n++ x\n\nfunc A() int { return 1 }\n// end\n"})
        self.assertEqual(self.repo.scope()["files"][0]["lines"], [[2, 2], [5, 5]])

    def test_a_file_name_with_a_newline_is_skipped_with_a_warning(self):
        self.repo.commit({"web/src/a\nrm -rf x #.ts": "export const a = 1;\n"})
        out = self.repo.diff_scope("--base", "origin/main")
        self.assertEqual(("nothing to mutate" in out.stdout, "control character" in out.stderr),
                         (True, True))

    def test_pure_deletion_leaves_nothing_to_mutate(self):
        self.repo.commit({"svc/auth/auth.go": "package auth\n"})
        self.assertEqual(self.paths(), [])

    def test_go_file_gets_module_root_and_package(self):
        self.repo.commit({"svc/auth/auth.go": "package auth\n\nfunc A() int { return 3 }\n"})
        f = self.repo.scope()["files"][0]
        self.assertEqual((f["root"], f["package"]), ("svc", "./auth"))

    def test_ts_file_gets_runner_from_package_json(self):
        cases = [({"devDependencies": {"vitest": "5"}}, "vitest"),
                 ({"devDependencies": {"jest": "30"}}, "jest"),
                 ({"scripts": {"test": "node --test"}}, "command")]
        for pkg, runner in cases:
            with self.subTest(runner=runner):
                self.repo.commit({"web/package.json": json.dumps(pkg),
                                  "web/src/a.ts": f"export const r = '{runner}';\n"})
                f = [x for x in self.repo.scope()["files"] if x["path"] == "web/src/a.ts"][0]
                self.assertEqual(f["runner"], runner)

    def test_ts_root_is_where_the_runner_or_stryker_config_lives(self):
        cases = [
            ("runner one level up", {"ui/package.json": VITEST_PKG, "ui/react/package.json": "{}"},
             "ui"),
            ("stryker config wins", {"ui/package.json": VITEST_PKG, "ui/react/package.json": "{}",
                                     "ui/react/stryker.config.mjs": "export default {}"},
             "ui/react"),
            ("no runner anywhere", {"ui/package.json": "{}", "ui/react/package.json": "{}"},
             "ui/react"),
        ]
        for name, files, root in cases:
            with self.subTest(name):
                repo = Repo(self, files)
                repo.commit({"ui/react/src/a.ts": "export const a = 1;\n"})
                self.assertEqual(repo.scope()["files"][0]["root"], root)

    def test_stryker_command_runs_only_the_files_own_tests(self):
        self.repo.commit({"web/package.json": VITEST_PKG,
                          "web/src/a.ts": "export const a = 1;\n",
                          "web/src/a.test.ts": "x\n"})
        argv = self.repo.commands()[0]
        self.assertEqual(argv[argv.index("--testFiles") + 1], "src/a.test.ts")

    def test_file_names_reach_the_command_as_literal_arguments(self):
        name = "src/a$(touch pwned) '\"b.ts"
        self.repo.commit({"web/package.json": VITEST_PKG, f"web/{name}": "export const a = 1;\n"})
        argv = self.repo.commands()[0]
        self.assertEqual(argv[argv.index("--mutate") + 1], f"{name}:1-1")

    def test_notes_what_the_suggested_commands_lack(self):
        cases = {
            "ts file without its own tests": ({"web/package.json": VITEST_PKG,
                                               "web/src/a.ts": "export const a = 1;\n"},
                                              "no sibling tests for web/src/a.ts"),
            "python file without pyproject": ({"py/pkg/m.py": "X = 1\n"},
                                              "no pyproject.toml above py/pkg/m.py"),
        }
        for name, (files, note) in cases.items():
            with self.subTest(name):
                repo = Repo(self, {})
                repo.commit(files)
                self.assertIn(note, repo.diff_scope("--base", "origin/main").stdout)

    def test_without_base_uses_origin_main(self):
        self.repo.commit({"svc/auth/a.go": "package auth\n"})
        out = self.repo.diff_scope().stdout
        self.assertIn("(origin/main)", out)

    def test_without_any_base_ref_fails_with_a_message(self):
        run(self.repo.dir, "git", "update-ref", "-d", "refs/remotes/origin/main")
        out = self.repo.diff_scope(check=False)
        self.assertEqual((out.returncode, "pass --base" in out.stderr), (1, True))


AUTH_GO = """
package auth

func Allowed(org string, ok bool) bool {
	if !ok {
		return false
	}
	return org != ""
}

func pad(n int) int {
	return n + 1
}
"""


class GremlinsSurvivorsTest(unittest.TestCase):
    """fixtures/gremlins-report.json mutates AUTH_GO: line 4 killed, line 7
    lived and timed out, line 11 not covered and not viable."""

    def setUp(self):
        self.repo = Repo(self, GO_BASE)
        self.repo.commit({"svc/auth/auth.go": AUTH_GO})
        self.scope = self.repo.scope()

    def triage(self, report=None, *args, **scope_changes):
        rep = self.repo.save("grem.json", report or fixture("gremlins-report.json"))
        return self.repo.triage(dict(self.scope, **scope_changes),
                                "--gremlins", f"svc/auth={rep}", *args)

    def test_killed_and_timed_out_count_as_killed_and_not_viable_is_left_out(self):
        t, _ = self.triage()
        self.assertEqual((t["on_diff"], t["killed"]), (4, 2))

    def test_not_covered_is_a_survivor_with_no_coverage(self):
        t, _ = self.triage()
        self.assertIn((11, "no coverage"), [(m["line"], m["status"]) for m in t["shown"]])

    def test_not_covered_lines_are_listed_in_full(self):
        t, proc = self.triage(None, "--cap", "0")
        shown = {"JSON": t["no_coverage"], "printed": re.findall(r"svc/auth/auth\.go:11",
                                                                 proc.stdout)}
        for where, found in shown.items():
            with self.subTest(where):
                self.assertEqual(found, ["svc/auth/auth.go:11"])

    def test_mutants_outside_the_diff_are_ignored(self):
        run(self.repo.dir, "git", "update-ref", "refs/remotes/origin/main", "HEAD")
        self.repo.commit({"svc/auth/auth.go": AUTH_GO.replace("n + 1", "n + 2")})
        self.scope = self.repo.scope()
        self.assertEqual([m["line"] for m in self.triage()[0]["shown"]], [11])

    def test_two_mutants_of_one_kind_on_one_line_count_separately(self):
        rep = gremlins_report(*({"type": "CONDITIONALS_BOUNDARY", "status": status, "line": 7,
                                 "column": col} for status, col in (("KILLED", 9), ("LIVED", 13))))
        self.assertEqual([m["column"] for m in self.triage(rep)[0]["shown"]], [13])

    def test_stronger_mutator_ranks_first(self):
        self.assertEqual([m["line"] for m in self.triage()[0]["shown"]], [7, 11])

    def test_same_mutation_ranks_first_on_a_risky_line(self):
        # `if !ok {` vs `return org != ""`
        rep = gremlins_report(*({"type": "CONDITIONALS_NEGATION", "status": "LIVED", "line": ln,
                                 "column": 5} for ln in (4, 7)))
        self.assertEqual([m["line"] for m in self.triage(rep)[0]["shown"]], [7, 4])

    def test_survivor_cap_is_seven_per_changed_file(self):
        t, _ = self.triage(None, files=self.scope["files"] * 3)
        self.assertEqual(t["cap"], 21)

    def test_list_is_capped(self):
        t, proc = self.triage(None, "--cap", "1")
        shown = {"JSON list": len(t["shown"]),
                 "printed table": len(re.findall(r"^\| \d+ \|", proc.stdout, re.M))}
        for name, count in shown.items():
            with self.subTest(name):
                self.assertEqual(count, 1)

    def test_kills_too_fast_to_be_real_mark_the_score_untrustworthy(self):
        rep = dict(fixture("gremlins-report.json"), mutants_lived=0, elapsed_time=0.05)
        _, proc = self.triage(rep)
        cases = {"warning": "build is failing" in proc.stderr,
                 "score line": bool(re.search(r"^Diff mutation score.*not trustworthy", proc.stdout, re.M))}
        for where, found in cases.items():
            with self.subTest(where):
                self.assertTrue(found, proc)


class StrykerSurvivorsTest(unittest.TestCase):
    """fixtures/stryker-report.json mutates its own `source`, committed here as
    web/src/select.tsx."""

    def setUp(self):
        self.report = fixture("stryker-report.json")
        source = self.report["files"]["src/select.tsx"]["source"]
        self.repo = Repo(self, {"web/package.json": "{}"})
        self.repo.commit({"web/src/select.tsx": source})
        self.scope = self.repo.scope()

    def triage(self, *reports):
        args = []
        for i, rep in enumerate(reports or [self.report]):
            args += ["--stryker", f"web={self.repo.save(f'm{i}.json', rep)}"]
        return self.repo.triage(self.scope, *args)

    def with_status(self, mutant_id, status):
        rep = copy.deepcopy(self.report)
        for m in rep["files"]["src/select.tsx"]["mutants"]:
            if m["id"] == mutant_id:
                m["status"] = status
        return rep

    def alive(self, t):
        return sorted((m["line"], m["mutator"], m["status"]) for m in t["shown"])

    def test_survivors_and_no_coverage_are_listed_and_the_rest_are_not(self):
        self.assertEqual(self.alive(self.triage()[0]), [
            (1, "BlockStatement", "no coverage"),
            (3, "StringLiteral", "survived"),
            (4, "ConditionalExpression", "survived"),
        ])

    def test_class_string_survivors_are_counted_as_noise(self):
        self.assertEqual(self.triage()[0]["noise"], 1)

    def test_a_mutant_killed_by_either_test_set_counts_once_as_killed(self):
        stories = self.with_status("2", "Killed")
        t, _ = self.triage(self.report, stories)
        self.assertNotIn((4, "ConditionalExpression", "survived"), self.alive(t))

    def test_absolute_file_names_map_to_repo_paths(self):
        rep = copy.deepcopy(self.report)
        rep["files"] = {os.path.join(self.repo.dir, "web/src/select.tsx"):
                        rep["files"]["src/select.tsx"]}
        self.assertEqual(self.alive(self.triage(rep)[0]), self.alive(self.triage()[0]))

    def test_file_names_outside_the_repo_are_left_out_with_a_warning(self):
        rep = copy.deepcopy(self.report)
        rep["files"] = {"../../outside.tsx": rep["files"]["src/select.tsx"]}
        t, proc = self.triage(rep)
        self.assertEqual((t["shown"], "outside the repo" in proc.stderr), ([], True))


class ClassStringTest(unittest.TestCase):
    CASES = [
        ('"h-8 px-2 text-sm"', "", True),
        ("'flex items-center gap-2'", "", True),
        ('"flex grow"', 'className="flex grow"', True),   # a class prop on the line
        ('"flex grow"', "", False),
        ('"Choose one"', "", False),                       # words, no utility class
        ('"org-admin"', "", False),                        # one hyphenated value
        ('"aria-disabled"', "", False),
        ('"2024-01-01"', "", False),
        ('"read-only file"', "", False),                   # copy with a hyphen in it
        ('"non-empty value required"', "", False),
        ('"Sign-in failed"', "", False),
        ('"Content-Type: application/json"', "", False),
    ]

    def test_only_class_lists_are_noise(self):
        for literal, line, noise in self.CASES:
            with self.subTest(literal=literal, line=line):
                self.assertEqual(survivors.is_class_string("StringLiteral", literal, line), noise)


PRICES_PY = '''
import statistics


def infer_price(prices):
    """Median of the positive prices.

    Returns None when there are none.
    """
    vals = [p for p in prices if p and p > 0]
    if not vals:
        return None
    return statistics.median(vals)
'''


class MutmutSurvivorsTest(unittest.TestCase):
    def setUp(self):
        self.repo = Repo(self, {"py/pyproject.toml": "[project]\nname='x'\n"})

    def survivors(self, source, show=None):
        self.repo.commit({"py/pkg/prices.py": source})
        path = self.repo.save("show.txt", show or fixture("mutmut-show.txt"))
        return self.repo.triage(self.repo.scope(), "--mutmut", f"py={path}")

    def test_function_relative_hunks_map_to_file_lines(self):
        t, _ = self.survivors(PRICES_PY)
        self.assertEqual(sorted((m["line"], m["status"]) for m in t["shown"]),
                         [(9, "survived"), (11, "no coverage")])

    def test_each_status_maps_to_its_outcome(self):
        cases = {"suspicious": [(9, "survived")], "timeout": [], "not checked": [],
                 "skipped": []}
        for status, alive in cases.items():
            with self.subTest(status):
                show = fixture("mutmut-show.txt").replace(": survived", f": {status}")
                t, _ = self.survivors(PRICES_PY, show)
                self.assertEqual([(m["line"], m["status"]) for m in t["shown"]
                                  if m["line"] == 9], alive)

    def test_score_is_not_given_for_a_survivors_only_report(self):
        _, proc = self.survivors(PRICES_PY)
        self.assertIn("score for mutmut: n/a", proc.stdout)

    def test_a_file_outside_the_repo_is_left_out_with_a_warning(self):
        show = fixture("mutmut-show.txt").replace("--- pkg/prices.py", "--- ../../outside.py")
        t, proc = self.survivors(PRICES_PY, show)
        self.assertEqual((t["shown"], "outside the repo" in proc.stderr), ([], True))

    def test_a_mutant_whose_function_is_gone_is_reported_not_dropped_silently(self):
        _, proc = self.survivors(PRICES_PY.replace("def infer_price", "def median_price"))
        self.assertIn("cannot find the function", proc.stderr)


class DefLineTest(unittest.TestCase):
    LINES = ("class Foo:", "    def validate(self):", "        pass",
             "class Bar:", "    def setup(self):", "        def validate():", "            pass",
             "    def validate(self):", "        pass",
             "def validate():", "    pass")

    def test_mutmut_name_gives_the_function(self):
        m = survivors.MUTMUT_NAME.search("pkg.x_tools.xǁBarǁvalidate__mutmut_1")
        self.assertEqual(m.group(1), "Barǁvalidate")

    def test_finds_the_def_mutmut_names(self):
        cases = {"Barǁvalidate": 8, "Fooǁvalidate": 2, "validate": 10, "Bazǁvalidate": None}
        for func, line in cases.items():
            with self.subTest(func):
                self.assertEqual(survivors.def_line(self.LINES, func), line)


class SurvivorsInputTest(unittest.TestCase):
    def test_bad_input_stops_with_a_message_not_a_traceback(self):
        repo = Repo(self, GO_BASE)
        scope = repo.scope()
        bad_json = repo.save("bad.json", "{not json")
        rep = ["--gremlins", f"svc/auth={repo.save('g.json', fixture('gremlins-report.json'))}"]
        cases = {
            "no report": (scope, []),
            "missing file": (scope, ["--gremlins", "svc/auth=/no/such/report.json"]),
            "invalid JSON": (scope, ["--stryker", f"web={bad_json}"]),
            "no ROOT=": (scope, ["--gremlins", bad_json]),
            "not a scope file": (fixture("stryker-report.json"), rep),
            "another repo's scope": (dict(scope, repo="/elsewhere"), rep),
        }
        for name, (scope_in, args) in cases.items():
            with self.subTest(name):
                out = repo.survivors(scope_in, *args, check=False)
                self.assertEqual((out.returncode, "Traceback" in out.stderr), (1, False), out)


GO_MODULES = {
    "lib/go.mod": "module example.com/lib\n\ngo 1.22\n",
    "lib/lib.go": "package lib\n\nfunc One() int { return 1 }\n",
    "svc/third_party/other/go.mod": "module example.com/other\n\ngo 1.22\n",
    "svc/go.mod": ("module example.com/svc\n\ngo 1.22\n\n"
                   "require example.com/lib v0.0.0\n\n"
                   "replace example.com/lib => ../lib\n\n"
                   "replace (\n\texample.com/other => \"./third_party/other\"\n)\n"),
    "svc/calc/calc.go": ("package calc\n\nimport \"example.com/lib\"\n\n"
                         "func Over(n int) bool { return n > lib.One() }\n"),
    "svc/calc/a.go": "package calc\n\nfunc a() int { return 1 }\n",
    "svc/calc/data.go": "package calc\n\nfunc data() int { return 2 }\n",
    "svc/calc/util.go": "package calc\n\nfunc util() int { return 3 }\n",
    "svc/calc/sub/util.go": "package sub\n\nfunc Util() int { return 4 }\n",
    "svc/calc/calc_test.go": ("package calc\n\nimport \"testing\"\n\n"
                              "func TestOver(t *testing.T) {\n"
                              "\tif !Over(5) || Over(0) { t.Fatal() }\n}\n"),
    "svc/untested/u.go": "package untested\n\nfunc U() int { return 1 }\n",
}


def go_mutate(repo_dir, out, *args, env=None):
    return run(repo_dir, "bash", os.path.join(SCRIPTS, "go_mutate.sh"), "svc",
               "--out", out, *args, check=False, env=env)


class GoMutateTest(unittest.TestCase):
    """go_mutate.sh against fixtures/fake-gremlins, which logs each call. The
    repo path has a space in it, as some home folders do."""

    def setUp(self):
        self.repo = Repo(self, GO_MODULES, prefix="mgt test-")
        os.makedirs(self.repo.scratch("bin"))
        self.gremlins = self.repo.scratch("bin/gremlins")
        shutil.copy(os.path.join(FIXTURES, "fake-gremlins"), self.gremlins)
        os.chmod(self.gremlins, 0o755)
        self.log = self.repo.scratch("gremlins.log")
        self.out = self.repo.scratch("out")

    def go_mutate(self, *args, report=None, env=None):
        report = report or os.path.join(FIXTURES, "gremlins-report.json")
        return go_mutate(self.repo.dir, self.out, *args,
                         env={"GREMLINS": self.gremlins, "FAKE_LOG": self.log,
                              "FAKE_REPORT": report, **(env or {})})

    def calls(self, *args, env=None):
        self.go_mutate(*args, env=env)
        with open(self.log) as f:
            return [json.loads(line) for line in f]

    def test_relative_replace_paths_are_absolute_in_the_copy_gremlins_builds(self):
        gomod = self.calls("./calc")[0]["gomod"]
        cases = {"replace line": f'=> "{self.repo.dir}/lib"\n',
                 "replace block": f'=> "{self.repo.dir}/svc/third_party/other"\n'}
        for name, wanted in cases.items():
            with self.subTest(name):
                self.assertIn(wanted, gomod)

    def test_passes_the_trap_workarounds_to_gremlins(self):
        call = self.calls("./calc", env={"GOFLAGS": "-mod=mod"})[0]
        argv = " ".join(call["argv"])
        cases = {
            "no cached test results": "-count=1" in call["goflags"].split(),
            "user's GOFLAGS kept": "-mod=mod" in call["goflags"].split(),
            "no go.work": call["gowork"] == "off",
            "wide timeout": "--timeout-coefficient 10" in argv,
            "logical mutator on": "--invert-logical" in call["argv"],
        }
        for name, ok in cases.items():
            with self.subTest(name):
                self.assertTrue(ok, call)

    def test_package_without_tests_runs_with_integration(self):
        self.assertIn("--integration", self.calls("./untested")[0]["argv"])

    def test_only_unchanged_files_are_excluded(self):
        """Gremlins matches the patterns against paths relative to the package it mutates."""
        cases = [
            ("calc/data.go calc/sub/util.go", "./calc",
             {"a.go": True, "calc.go": True, "util.go": True, "data.go": False,
              "sub/util.go": False}),
            ("calc/sub/util.go", ".", {"calc/util.go": True, "calc/sub/util.go": False}),
        ]
        for files, pkg, paths in cases:
            os.path.exists(self.log) and os.remove(self.log)
            argv = self.calls("--files", files, pkg)[0]["argv"]
            patterns = [argv[i + 1] for i, a in enumerate(argv) if a == "--exclude-files"]
            for path, excluded in paths.items():
                with self.subTest(pkg=pkg, path=path):
                    self.assertEqual(any(re.search(p, path) for p in patterns), excluded, patterns)

    def test_prints_one_survivors_argument_per_package(self):
        out = self.go_mutate("./calc", "./untested").stdout
        self.assertEqual([shlex.split(line) for line in out.splitlines()],
                         [["--gremlins", f"svc/calc={self.out}/1-calc.json"],
                          ["--gremlins", f"svc/untested={self.out}/2-untested.json"]])

    def test_a_run_that_does_not_count_fails(self):
        none_ran = gremlins_report(*(dict(m, status="NOT COVERED") for m in
                                     gremlins_report()["files"][0]["mutations"]))
        cases = {"no mutant ran": (none_ran, "Runnable: 0"),
                 "unreadable report": ("{not json", "cannot read the report")}
        for name, (report, message) in cases.items():
            with self.subTest(name):
                out = self.go_mutate("./calc", report=self.repo.save(f"{name}.json", report))
                self.assertEqual((out.returncode, message in out.stderr), (1, True), out.stderr)


@unittest.skipUnless(os.environ.get("GREMLINS") and shutil.which("go"),
                     "set GREMLINS to a gremlins binary (and install go) to run real Gremlins")
class RealGremlinsTest(unittest.TestCase):
    def test_a_real_survivor_reaches_the_triage_list(self):
        base = {k: v for k, v in GO_MODULES.items()
                if not k.startswith("svc/third_party") and k != "svc/calc/calc.go"}
        base["svc/go.mod"] = GO_MODULES["svc/go.mod"].split("\nreplace (")[0]
        repo = Repo(self, base)
        repo.commit({"svc/calc/calc.go": GO_MODULES["svc/calc/calc.go"]})
        out_dir = repo.scratch("out")
        proc = go_mutate(repo.dir, out_dir, "--files", "calc/calc.go", "./calc")
        arg = proc.stdout.split()[-1]
        t, _ = repo.triage(repo.scope(), "--gremlins", arg)
        # `n > 1` -> `n >= 1` survives (no test at n == 1); a build failure would kill it,
        # and a file name survivors.py can't map would drop it.
        self.assertIn(("svc/calc/calc.go", 5), [(m["file"], m["line"]) for m in t["shown"]],
                      proc.stderr)


if __name__ == "__main__":
    unittest.main()
