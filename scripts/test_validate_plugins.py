"""Tests for the workflow rules (workflow_rules.py) and the gate steps in
validate-plugins.py.

validate-plugins.py runs these itself. To run only them, from the repo root:

    python3 -m unittest discover -s scripts -p 'test_*.py'
"""

from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import workflow_rules as wr

HERE = Path(__file__).resolve().parent
# validate-plugins.py has a hyphen in its name, so it cannot be imported by name.
_spec = importlib.util.spec_from_file_location("validate_plugins", HERE / "validate-plugins.py")
vp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vp)

SHA = "a" * 40  # any 40-hex value; not tied to the real pin in ci.yml
VERSION = " # v7.0.1"
CHECKOUT = f"actions/checkout@{SHA}{VERSION}"
PERSIST = "        with:\n          persist-credentials: false\n"
VALIDATE_JOB = "  validate:\n    name: validate"

GOOD = f"""\
name: ci
on:
  pull_request:
    branches: [main]
permissions:
  contents: read
jobs:
{VALIDATE_JOB}
    runs-on: ubuntu-latest
    steps:
      - uses: {CHECKOUT}
{PERSIST}      - run: python3 scripts/validate-plugins.py
"""
CHECKOUT_LINE = GOOD.splitlines().index(f"      - uses: {CHECKOUT}") + 1
NO_VALIDATE = GOOD.replace(VALIDATE_JOB, "  plugins:\n    name: plugins")


def swap(old: str, new: str, text: str = GOOD) -> str:
    """`text` with `old` replaced; fails loudly if `old` is not there."""
    assert old in text, f"{old!r} not in the base workflow"
    return text.replace(old, new)


def job_setting(line: str) -> str:
    """GOOD with `line` added to the validate job, before runs-on."""
    return swap("    runs-on:", f"{line}\n    runs-on:")


class WorkflowRules(unittest.TestCase):
    def assertFlags(self, text: str, needle: str):
        out = [msg for _, msg in wr.workflow_problems(text)]
        self.assertTrue(any(needle in m for m in out), out)

    def assertClean(self, text: str):
        self.assertEqual(wr.workflow_problems(text), [])

    def assertHasValidateJob(self, text: str):
        self.assertEqual(wr.ci_job_problems(text), [])

    def assertNoValidateJob(self, text: str):
        self.assertTrue(wr.ci_job_problems(text))

    def test_good_workflow_passes(self):
        self.assertClean(GOOD)
        self.assertHasValidateJob(GOOD)

    def test_repo_ci_workflow_passes(self):
        text = (HERE.parent / ".github" / "workflows" / "ci.yml").read_text()
        self.assertClean(text)
        self.assertHasValidateJob(text)

    # pinning
    def test_tag_ref_fails(self):
        self.assertFlags(swap(f"@{SHA}{VERSION}", "@v7"), "not pinned")

    def test_short_sha_fails(self):
        self.assertFlags(swap(SHA, SHA[:12]), "not pinned")

    def test_quoted_tag_ref_fails(self):
        self.assertFlags(swap(CHECKOUT, "'actions/checkout@main'"), "not pinned")

    def test_double_quoted_pinned_ref_passes(self):
        self.assertClean(swap(CHECKOUT, f'"actions/checkout@{SHA}"{VERSION}'))

    def test_missing_version_comment_fails(self):
        self.assertFlags(swap(VERSION, ""), "comment")

    def test_comment_without_space_fails(self):
        self.assertFlags(swap(VERSION, "# v7.0.1"), "cannot read")

    def test_third_party_owner_fails(self):
        self.assertFlags(swap("actions/checkout@", "someone/checkout@"), "allowed owner")

    def test_github_owner_allowed(self):
        self.assertClean(GOOD + f"      - uses: github/codeql-action/init@{SHA} # v3.0.0\n")

    def test_docker_action_fails(self):
        self.assertFlags(swap(CHECKOUT, "docker://alpine:3"), "not pinned")

    def test_local_action_fails(self):
        self.assertFlags(GOOD + "      - uses: ./.github/actions/x\n", "local action")

    def test_reusable_workflow_fails(self):
        self.assertFlags(GOOD + f"  other:\n    uses: actions/x/.github/workflows/y.yml@{SHA} # v1\n",
                         "reusable workflow")

    def test_flow_style_uses_fails(self):
        self.assertFlags(GOOD + "      - {uses: someone/evil@v1}\n", "cannot read")
        self.assertFlags(GOOD + '      - {name: "a #", uses: someone/evil@main}\n', "cannot read")

    def test_quoted_uses_key_fails(self):
        self.assertFlags(GOOD + '      - "uses": someone/evil@v1\n', "cannot read")

    # triggers
    def test_pull_request_target_fails(self):
        self.assertFlags(swap("  pull_request:", "  pull_request_target:"), "pull_request_target")

    def test_flow_trigger_after_hash_in_string_fails(self):
        self.assertFlags(swap("on:\n  pull_request:\n    branches: [main]\n",
                              'on: {push: {branches: ["a #"]}, pull_request_target: {}}\n'),
                         "pull_request_target")

    def test_workflow_run_fails(self):
        self.assertFlags(swap("  pull_request:", "  workflow_run:"), "workflow_run")

    def test_commented_pull_request_target_ignored(self):
        self.assertClean("# pull_request_target is banned\n" + GOOD)

    # escapes
    def test_hex_escape_fails(self):
        self.assertFlags(swap("  pull_request:", '  "pull_request_t\\x61rget":'), "escape")

    def test_line_join_fails(self):
        self.assertFlags(GOOD + '      - run: "echo a\\\n          b"\n', "escape")

    # permissions
    def test_missing_permissions_fails(self):
        self.assertFlags(swap("permissions:\n  contents: read\n", ""), "no top-level")

    def test_commented_out_workflow_fails(self):
        text = "\n".join("# " + line for line in GOOD.splitlines())
        self.assertFlags(text, "no top-level")
        self.assertNoValidateJob(text)

    def test_extra_permission_fails(self):
        self.assertFlags(swap("  contents: read\n", "  contents: read\n  pull-requests: read\n"), "exactly")

    def test_read_all_fails(self):
        out = [m for _, m in wr.workflow_problems(swap("permissions:\n  contents: read", "permissions: read-all"))]
        self.assertTrue(any("exactly" in m and "read-all" in m for m in out), out)

    def test_equivalent_permissions_pass(self):
        self.assertClean(swap("  contents: read\n", "  contents: 'read'  # least privilege\n"))
        self.assertClean(swap("permissions:\n  contents: read", "permissions: { contents: read }"))

    def test_job_permissions_fail(self):
        self.assertFlags(job_setting("    permissions: read-all"), "below the top level")
        self.assertFlags(job_setting("    permissions:\n      contents: >-\n        write"), "below the top level")

    def test_job_write_permission_fails(self):
        self.assertFlags(job_setting("    permissions:\n      contents: write"), "write access")
        self.assertFlags(job_setting("    permissions:\n      contents: 'write' # x"), "write access")
        self.assertFlags(job_setting("    permissions: write-all"), "write access")

    def test_write_in_a_step_name_passes(self):
        self.assertClean(GOOD + "      - name: write the bundle\n        run: write-docs\n")

    # secrets and untrusted data
    def test_secret_fails(self):
        self.assertFlags(GOOD + "        env:\n          T: ${{ secrets.TOKEN }}\n", "secrets")

    def test_tojson_secrets_fails(self):
        self.assertFlags(GOOD + "      - run: echo '${{ toJSON(secrets) }}'\n", "secrets")

    def test_secret_after_brace_fails(self):
        self.assertFlags(GOOD + "        env:\n          T: ${{ format('{0}', secrets.X) }}\n", "secrets")

    def test_secrets_inherit_fails(self):
        self.assertFlags(GOOD + "  other:\n    secrets: inherit\n", "secrets")

    def test_event_data_fails(self):
        self.assertFlags(GOOD + '      - run: echo "${{ github.event.pull_request.title }}"\n', "github.event")
        self.assertFlags(GOOD + '      - run: echo "${{ github.head_ref }}"\n', "github.event")

    def test_event_name_passes(self):
        self.assertClean(GOOD + "        if: ${{ github.event_name == 'push' }}\n")

    # checkout
    def test_checkout_without_persist_credentials_fails(self):
        self.assertFlags(swap(PERSIST, ""), "persist-credentials")

    def test_persist_credentials_in_a_later_step_does_not_count(self):
        self.assertFlags(swap(PERSIST, f"      - run: echo\n{PERSIST}"), "persist-credentials")

    def test_persist_credentials_outside_with_does_not_count(self):
        self.assertFlags(swap(PERSIST, PERSIST.replace("with:", "env:")), "persist-credentials")

    def test_named_checkout_step_passes(self):
        self.assertClean(swap(f"      - uses: {CHECKOUT}", f"      - name: checkout\n        uses: {CHECKOUT}"))

    # the validate job
    def test_missing_validate_job_fails(self):
        self.assertNoValidateJob(NO_VALIDATE)

    def test_validate_outside_jobs_fails(self):
        self.assertNoValidateJob(swap("on:\n", f"on:\n{VALIDATE_JOB}\n", NO_VALIDATE))

    def test_validate_job_any_indent_and_quotes_passes(self):
        self.assertHasValidateJob(GOOD.replace("\n  ", "\n    ").replace("name: validate", 'name: "validate"'))


class CheckWorkflows(unittest.TestCase):
    def run_check(self, files: dict[str, str]) -> list[str]:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            wf = root / ".github" / "workflows"
            wf.mkdir(parents=True)
            for name, text in files.items():
                (wf / name).write_text(text)
            with mock.patch.multiple(vp, ROOT=root, WORKFLOWS=wf, CI_WORKFLOW=wf / "ci.yml",
                                     problems=[]):
                vp.check_workflows()
                return list(vp.problems)

    def test_good_repo_passes(self):
        self.assertEqual(self.run_check({"ci.yml": GOOD}), [])

    def test_missing_ci_fails(self):
        out = self.run_check({"other.yml": GOOD})
        self.assertTrue(any("ci.yml: missing" in p for p in out), out)

    def test_yaml_extension_scanned(self):
        out = self.run_check({"ci.yml": GOOD, "x.yaml": swap(VERSION, "")})
        self.assertTrue(any(p.startswith(f".github/workflows/x.yaml:{CHECKOUT_LINE}: ") for p in out), out)

    def test_validate_job_required_only_in_ci(self):
        self.assertEqual(self.run_check({"ci.yml": GOOD, "x.yml": NO_VALIDATE}), [])


class CheckManifest(unittest.TestCase):
    ENTRY = {"name": "p", "version": "1.0.0", "description": "Does a thing."}
    ENTRY_NO_DESCRIPTION = {"name": "p", "version": "1.0.0"}
    NO_DESCRIPTION = ["./plugins/p: plugin.json has no description (it must be a non-empty string)"]

    def run_check(self, entry: dict, manifest: dict) -> list[str]:
        with mock.patch.object(vp, "problems", []):
            vp.check_manifest("./plugins/p", entry, manifest)
            return list(vp.problems)

    def test_matching_manifest_passes(self):
        self.assertEqual(self.run_check(self.ENTRY, dict(self.ENTRY)), [])

    def test_different_description_fails_and_points_at_the_difference(self):
        out = self.run_check(self.ENTRY, {**self.ENTRY, "description": "Does another thing."})
        self.assertEqual(len(out), 1, out)
        self.assertIn("description does not match its .claude-plugin/marketplace.json entry", out[0])
        self.assertIn("first differ at character 7", out[0])
        self.assertIn("plugin.json:      'Does another thing.'", out[0])
        self.assertIn("marketplace.json: 'Does a thing.'", out[0])

    def test_whitespace_difference_fails_and_shows_it(self):
        out = self.run_check(self.ENTRY, {**self.ENTRY, "description": "Does a thing. "})
        self.assertEqual(len(out), 1, out)
        self.assertIn("first differ at character 14", out[0])
        self.assertIn("'Does a thing. '", out[0])

    def test_long_description_is_cut_around_the_difference(self):
        long = "x" * 200 + "a" + "y" * 200
        out = self.run_check({**self.ENTRY, "description": long},
                             {**self.ENTRY, "description": long.replace("a", "b")})
        self.assertEqual(len(out), 1, out)
        self.assertIn("first differ at character 201", out[0])
        self.assertIn("...'" + "x" * 30 + "b" + "y" * 29 + "'...", out[0])
        self.assertLess(len(out[0]), 400)

    def test_missing_manifest_description_reported_once(self):
        self.assertEqual(self.run_check(self.ENTRY, self.ENTRY_NO_DESCRIPTION), self.NO_DESCRIPTION)

    def test_blank_manifest_description_reported_once(self):
        out = self.run_check(self.ENTRY, {**self.ENTRY, "description": "  "})
        self.assertEqual(out, self.NO_DESCRIPTION)

    def test_non_string_description_reported_not_crashed(self):
        for value in (None, 42, ["Does a thing."]):
            out = self.run_check(self.ENTRY, {**self.ENTRY, "description": value})
            self.assertEqual(out, self.NO_DESCRIPTION, value)

    def test_non_string_entry_description_fails(self):
        out = self.run_check({**self.ENTRY, "description": None}, dict(self.ENTRY))
        self.assertEqual(len(out), 1, out)
        self.assertIn("entry None, which is not a string", out[0])

    def test_entry_without_description_skips_the_match(self):
        self.assertEqual(self.run_check(self.ENTRY_NO_DESCRIPTION, dict(self.ENTRY)), [])

    def test_different_version_fails(self):
        out = self.run_check(self.ENTRY, {**self.ENTRY, "version": "1.0.1"})
        self.assertEqual(out, [
            "./plugins/p: plugin.json version '1.0.1' does not match its "
            ".claude-plugin/marketplace.json entry '1.0.0'; "
            "decide which is current and copy it to the other file"
        ])

    def test_different_name_fails(self):
        out = self.run_check(self.ENTRY, {**self.ENTRY, "name": "q"})
        self.assertEqual(out, [
            "./plugins/p: plugin.json name 'q' does not match its "
            ".claude-plugin/marketplace.json entry 'p'; rename one so they match"
        ])


class CheckTerms(unittest.TestCase):
    TERM = "One Behaviour"

    def run_check(self, text: str | None, terms: tuple[str, ...] = (TERM,)) -> list[str]:
        """check_terms on one file holding `text` (None: no file) that must contain `terms`."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "rules.md"
            if text is not None:
                path.write_text(text)
            with mock.patch.multiple(vp, ROOT=root, problems=[]):
                vp.check_terms({path: list(terms)}, "test rule")
                return list(vp.problems)

    def test_term_present_in_any_case_passes(self):
        for text in ("one behaviour", "ONE BEHAVIOUR", "x One Behaviour y"):
            with self.subTest(text=text):
                self.assertEqual(self.run_check(text), [])

    def test_missing_term_names_file_term_and_rule(self):
        self.assertEqual(self.run_check("two behaviours"),
                         ["rules.md: must contain 'One Behaviour' (any case), part of the test rule"])

    def test_only_the_missing_term_is_reported(self):
        self.assertEqual(self.run_check("alpha only", ("alpha", "beta")),
                         ["rules.md: must contain 'beta' (any case), part of the test rule"])

    def test_missing_file_fails(self):
        self.assertEqual(self.run_check(None), ["rules.md: missing"])


class RepoRules(unittest.TestCase):
    # (rule, its check); each must pass on the repo's own files
    CASES = [
        ("unit-test rule", vp.check_unit_test_rule),
        ("merge policy", vp.check_merge_policy),
    ]

    def test_repo_files_carry_the_rule(self):
        for rule, check in self.CASES:
            with self.subTest(rule), mock.patch.object(vp, "problems", []):
                check()
                self.assertEqual(vp.problems, [])


ASK_LINE = "- **Merge policy:** `ask`"
ASK_AGENTS = "- **Merge policy: ask.** It is set in git-workflow.md."
SQUASH_LINE = "- **Merge style:** `squash`"
SQUASH_AGENTS = "- **PRs merge in the repo's merge style: squash.**"
BAD_POLICY = [(vp.GIT_WORKFLOW, "needs exactly one '- **Merge policy:** `ask|auto`' line")]
BAD_POLICY_AGENTS = [(vp.REPO_AGENTS_MD, 'must say "Merge policy: ask." exactly once, the value git-workflow.md sets')]
POLICY = ("Merge policy", vp.MERGE_POLICIES, "ask", "the safe default")
STYLE = ("Merge style", vp.MERGE_STYLES, "squash", "the style the ruleset template allows")
MERGE_ROW = 'Add a board row: type "merge N" once the PR is ready'


class WorkflowSetting(unittest.TestCase):
    # (case, setting, git-workflow.md text, AGENTS.md text, expected problems)
    CASES = [
        ("policy line and matching AGENTS.md pass", POLICY, f"x\n{ASK_LINE}\ny", ASK_AGENTS, []),
        ("missing policy line fails", POLICY, "no policy here", ASK_AGENTS, BAD_POLICY),
        ("two policy lines fail", POLICY, f"{ASK_LINE}\n{ASK_LINE}", ASK_AGENTS, BAD_POLICY),
        ("unknown policy fails", POLICY, "- **Merge policy:** `sometimes`", ASK_AGENTS, BAD_POLICY),
        ("a line with trailing text is not a policy line", POLICY, f"{ASK_LINE}\n{ASK_LINE} or auto", ASK_AGENTS, []),
        ("auto as the shipped default fails", POLICY, "- **Merge policy:** `auto`", "- **Merge policy: auto.**",
         [(vp.GIT_WORKFLOW, "the Merge policy line says 'auto'. This file is the shipped template, "
                            "which must say 'ask' (the safe default). Set it back to 'ask'.")]),
        ("AGENTS.md naming another policy fails", POLICY, ASK_LINE, "- **Merge policy: auto.**", BAD_POLICY_AGENTS),
        ("AGENTS.md naming two policies fails", POLICY, ASK_LINE, ASK_AGENTS + "\n- **Merge policy: auto.**",
         BAD_POLICY_AGENTS),
        ("empty AGENTS.md fails", POLICY, ASK_LINE, "", BAD_POLICY_AGENTS),
        ("style line and matching AGENTS.md pass", STYLE, SQUASH_LINE, SQUASH_AGENTS, []),
        ("style other than the ruleset's fails", STYLE, "- **Merge style:** `rebase`",
         "- **PRs merge in the repo's merge style: rebase.**",
         [(vp.GIT_WORKFLOW, "the Merge style line says 'rebase'. This file is the shipped template, "
                            "which must say 'squash' (the style the ruleset template allows). Set it back to 'squash'.")]),
    ]

    def test_setting_problems(self):
        for case, (name, allowed, default, source), workflow, agents_md, expected in self.CASES:
            with self.subTest(case):
                self.assertEqual(vp.setting_problems(name, allowed, default, source, workflow, agents_md), expected)


class MergeOnBoard(unittest.TestCase):
    # (line, whether it puts a merge ask on the board)
    CASES = [
        ('every task, including "merge N" requests and hosting choices', True),
        ('"Type `merge 42` in chat to merge PR 42"', True),
        (MERGE_ROW, True),
        ('The one exception is "merge N": ask for it in chat only', False),
        ('"PR 42 is ready. Type `merge 42` to merge it."', False),
        ('ask for "merge N" in this chat only, never on the board', False),
        # a known limit: a line with never, except or not is let through
        ('Add a board row for merge 42; do not skip it', False),
    ]

    def test_merge_on_board_pattern(self):
        for line, flagged in self.CASES:
            with self.subTest(line):
                self.assertEqual(bool(vp.MERGE_ON_BOARD.search(line)), flagged)


class MergeOnBoardScan(unittest.TestCase):
    def test_doc_with_a_merge_row_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            doc = Path(tmp) / "doc.md"
            doc.write_text(MERGE_ROW + "\n", encoding="utf-8")
            agents = Path(tmp) / "AGENTS.md"
            agents.write_text(ASK_AGENTS + "\n", encoding="utf-8")
            with mock.patch.object(vp, "problems", []), mock.patch.object(vp, "REPO_AGENTS_MD", agents), \
                    mock.patch.object(vp, "repo_docs", lambda suffixes: [doc]), \
                    mock.patch.object(vp, "rel", lambda path: path.name):
                vp.check_merge_policy()
                self.assertIn("doc.md:1: puts a merge ask on the Asks board; merge asks go in the coordinator chat",
                              vp.problems)


class RepoDocs(unittest.TestCase):
    def test_a_symlink_and_its_target_count_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            docs = Path(tmp) / "docs"
            docs.mkdir()
            (docs / "a.md").write_text("x\n", encoding="utf-8")
            (docs / "b.md").symlink_to("a.md")
            with mock.patch.object(vp, "ROOT", Path(tmp)):
                self.assertEqual(vp.repo_docs({".md"}), [docs / "a.md"])


class SelfChecks(unittest.TestCase):
    def run_without_node(self, env: dict) -> list[str]:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            check = root / "plugins" / "p" / "skills" / "s" / "scripts" / "check-x.mjs"
            check.parent.mkdir(parents=True)
            check.write_text("")
            with mock.patch.multiple(vp, ROOT=root, problems=[]), \
                    mock.patch.object(vp.shutil, "which", return_value=None), \
                    mock.patch.dict(os.environ, env, clear=True), \
                    mock.patch("sys.stderr"):
                vp.run_self_checks()
                return list(vp.problems)

    def test_missing_node_fails_in_ci(self):
        out = self.run_without_node({"CI": "true"})
        self.assertTrue(any("node not found" in p for p in out), out)

    def test_missing_node_skips_locally(self):
        self.assertEqual(self.run_without_node({}), [])


if __name__ == "__main__":
    unittest.main()
