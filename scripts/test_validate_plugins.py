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


A11Y_TOOL = vp.A11Y_PREFIX + "get_specialist"
WORK_TOOLS = "Read, Edit, Write, Grep, Glob, Bash, Skill"
READ_TOOLS = "Read, Grep, Glob, Bash"


def frontmatter(tools_line: str, extra: str = "") -> str:
    """A raw frontmatter block, as agent_tool_problems reads it."""
    return f"name: x\ndescription: d\n{tools_line}\n{extra}model: sonnet"


class AgentToolProblems(unittest.TestCase):
    """agent_tool_problems keeps every agent on one plain tools: allow-list with no tracker named."""

    PASSING = [
        ("work agent with file tools", "implementer-engine", frontmatter(f"tools: {WORK_TOOLS}")),
        ("read-only agent without file tools", "correctness-critic", frontmatter(f"tools: {READ_TOOLS}")),
        ("read-only agent with accessibility tools", "accessibility-critic",
         frontmatter(f"tools: {READ_TOOLS}, {A11Y_TOOL}")),
        ("work agent that starts agents", "pr-finisher", frontmatter(f"tools: {WORK_TOOLS}, Agent")),
    ]
    FAILING = [
        ("no tools line", "lookup", frontmatter(""), "exactly one `tools:` line"),
        ("blank tools line", "lookup", frontmatter("tools: "), "exactly one `tools:` line"),
        ("tools line followed by another key", "lookup", frontmatter("tools:"), "exactly one `tools:` line"),
        ("two tools lines", "lookup", frontmatter(f"tools: {READ_TOOLS}", "tools: Edit\n"),
         "exactly one `tools:` line"),
        ("block list", "lookup", frontmatter("tools:\n  - Read\n  - Edit"), "exactly one `tools:` line"),
        ("flow list", "lookup", frontmatter("tools: [Read, Edit]"), "'[Read' is not one"),
        ("quoted list", "lookup", frontmatter('tools: "Read, Edit"'), "'\"Read' is not one"),
        ("comment after a tool", "lookup", frontmatter("tools: Read # Edit"), "'Read # Edit' is not one"),
        ("tools continued on the next line", "spec-critic", frontmatter(f"tools: {READ_TOOLS}", "  , Edit\n"),
         "not another key"),
        ("deny-list instead of allow-list", "implementer-engine",
         frontmatter(f"tools: {WORK_TOOLS}", "disallowedTools: NotebookEdit\n"), "disallowedTools"),
        ("tracker tool named", "ticket-writer",
         frontmatter(f"tools: {READ_TOOLS}, mcp__tracker__get_ticket"), "mcp__tracker__get_ticket"),
        ("whole MCP server named", "implementer-engine", frontmatter(f"tools: {WORK_TOOLS}, mcp__tracker__*"),
         "'mcp__tracker__*' is not one"),
        *[(f"read-only agent with {tool}", "spec-critic", frontmatter(f"tools: {READ_TOOLS}, {tool}"),
           f"holds {tool}") for tool in vp.READ_ONLY_FORBIDDEN],
    ]

    def test_allowed_tool_sets_pass(self):
        for label, name, block in self.PASSING:
            with self.subTest(label):
                self.assertEqual(vp.agent_tool_problems(name, block), [])

    def test_each_problem_is_named(self):
        for label, name, block, needle in self.FAILING:
            with self.subTest(label):
                found = vp.agent_tool_problems(name, block)
                self.assertTrue(any(needle in p for p in found), found)


class RepoChecks(unittest.TestCase):
    """Each repo-wide check passes on this repo as it is."""

    CHECKS = [
        ("unit-test rule", vp.check_unit_test_rule),
        ("agent tool policy", lambda: vp.check_agent_tool_policy(vp.load_agents())),
        ("agent rule lines", lambda: vp.check_agent_rule_lines(vp.load_agents())),
        ("ticketing tool setting", vp.check_tracker_setting),
        ("merge policy", vp.check_merge_policy),
        ("rule for asks a board click cannot resolve", vp.check_chat_asks),
    ]

    def test_repo_passes(self):
        for label, check in self.CHECKS:
            with self.subTest(label), mock.patch.object(vp, "problems", []):
                check()
                self.assertEqual(vp.problems, [])


ROSTER_AGENT_NAMES = {p.stem for p in (vp.AGENT_ROSTER / "agents").glob("*.md")}


class TrackerSetting(unittest.TestCase):
    def test_every_read_only_agent_exists(self):
        self.assertEqual(vp.READ_ONLY_AGENTS - ROSTER_AGENT_NAMES, set())

    def test_every_critic_is_read_only(self):
        critics = {name for name in ROSTER_AGENT_NAMES if name.endswith(("-critic", "-reviewer"))}
        self.assertEqual(critics - vp.READ_ONLY_AGENTS, set())

    def test_agent_without_a_rule_line_fails(self):
        for rule, (line, _) in vp.AGENT_RULE_LINES.items():
            with self.subTest(rule), mock.patch.object(vp, "problems", []):
                others = "\n".join(other for other, _ in vp.AGENT_RULE_LINES.values() if other != line)
                path = vp.AGENT_ROSTER / "agents" / "lookup.md"
                vp.check_agent_rule_lines([vp.Agent(path, f"No {rule} here.\n{others}\n", "", [])])
                self.assertEqual([rule in p for p in vp.problems], [True], vp.problems)

    def test_repo_issue_tracker_that_drifts_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            drifted = Path(tmp) / "issue-tracker.md"
            drifted.write_text(vp.ISSUE_TRACKER_TEMPLATE.read_text() + "\nAn extra line.\n")
            with mock.patch.multiple(vp, ROOT=Path(tmp), REPO_ISSUE_TRACKER=drifted, TRACKER_POINTERS={},
                                     ISSUE_TRACKER_TEMPLATE=vp.ISSUE_TRACKER_TEMPLATE, problems=[]), \
                    mock.patch.object(vp, "rel", lambda p: p):
                vp.check_tracker_setting()
                self.assertTrue(any("must equal" in p for p in vp.problems), vp.problems)


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


def scan(check, agents_text: str, docs: dict[str, str] | None = None) -> list[str]:
    """Run `check` with a temp AGENTS.md and `docs` (name -> text) as the only rule docs.
    Returns the problems the check reported."""
    with tempfile.TemporaryDirectory() as tmp:
        agents = Path(tmp) / "AGENTS.md"
        agents.write_text(agents_text + "\n", encoding="utf-8")
        paths = []
        for name, text in (docs or {}).items():
            paths.append(Path(tmp) / name)
            paths[-1].write_text(text + "\n", encoding="utf-8")
        with mock.patch.multiple(vp, problems=[], REPO_AGENTS_MD=agents, repo_docs=lambda suffixes: paths,
                                 rel=lambda path: path.name):
            check()
            return list(vp.problems)


def scan_chat_asks(agents_text: str, docs: dict[str, str] | None = None) -> list[str]:
    """check_chat_asks on temp docs only: no file is held to the rule's terms."""
    return scan(lambda: vp.check_chat_asks(terms={}), agents_text, docs)


class MergeOnBoardScan(unittest.TestCase):
    def test_doc_with_a_merge_row_is_reported(self):
        self.assertIn(f"doc.md:1: {vp.MERGE_ON_BOARD_MESSAGE}", scan_chat_asks(ASK_AGENTS, {"doc.md": MERGE_ROW}))


OLD_RULE_LINE = "- **Every ask for Eli goes on the Asks board, except a merge.**"


class OldBoardRule(unittest.TestCase):
    # (line, whether it states the rule before #33: every ask on the board)
    CASES = [
        (OLD_RULE_LINE, True),
        ("Every question to the owner goes on the Asks board (use the `asks-board` skill)", True),
        ("every ask for the owner goes on the owner's Asks board, except \"merge N\"", True),
        ('The one exception is "merge N": ask for it in chat only', True),
        ("- Every other step only the user can do in chat gets its own `open` row.", True),
        ("put every ask for the owner on the Asks board, pass on results", True),
        ("add every question for the owner to the Asks board first, then ask it in chat.", True),
        ("- From here on, add every question for the owner to the board first, under this project.", True),
        ("Every question, decision, approval, review request or task for the user gets a row, not only a line", True),
        ("1. Asks Eli on the Asks board for a yes, then files a ticket for the bump.", True),
        ("any open security-critic finding goes to the owner as a `decide` ask on the Asks board, and the PR waits.",
         True),
        ("Every ask for the owner goes on the board, except a merge.", True),
        ("asking the owner (every ask on the Asks board except \"merge N\", which goes in chat)", True),
        ("holds every open ask, one tab per project.", True),
        ("Every question, decision, approval, review request or task gets a row, such as a merge.", True),
        ("Put an ask for Eli on the Asks board only when a board click can resolve it.", False),
        ("Put every ask a board click can resolve on the Asks board.", False),
        ("Add every question a board click can resolve to the board first.", False),
        ("Every ask a board click can resolve goes on the Asks board.", False),
        ("put each ask for the owner on the Asks board or in chat as rule 2 says", False),
        ("Every such question, decision, approval, review request or task gets a row", False),
        ("send it to the owner as a `decide` ask on the Asks board with options A and B", False),
        ("the coordinator puts it on the Asks board, and any other agent reports it", False),
        ("Every ask on the list. It goes on the Asks board later.", False),
    ]

    def test_old_board_rule_pattern(self):
        for line, flagged in self.CASES:
            with self.subTest(line):
                self.assertEqual(bool(vp.OLD_BOARD_RULE.search(line)), flagged)


class ChatAskScan(unittest.TestCase):
    def test_the_old_rule_is_reported(self):
        self.assertIn(f"AGENTS.md:1: {vp.OLD_BOARD_RULE_MESSAGE}", scan_chat_asks(OLD_RULE_LINE))

    def test_the_rule_files_are_all_checked(self):
        # Pins the files that state the rule in full, on purpose: a file dropped
        # from CHAT_ASK_RULE_TERMS by mistake would otherwise go unchecked.
        files_that_state_the_rule = {
            vp.GUARDRAILS, vp.REPO_AGENTS_MD, vp.COORDINATOR_PROMPT, vp.REPO_COORDINATOR_PROMPT, vp.ROUTE_WORK,
            vp.MULTI_AGENT, vp.REPO_MULTI_AGENT, vp.SETUP_SKILL_MD, vp.AGENT_ROSTER_README,
            vp.ASKS_BOARD_SKILL, vp.ASKS_BOARD_README}
        self.assertEqual({path for path, terms in vp.CHAT_ASK_RULE_TERMS.items()
                          if set(vp.CHAT_ASK_TERMS) <= set(terms)}, files_that_state_the_rule)


OLD_TICKET_WRITER_YES = ("Creating or editing a ticket needs the owner's yes first. File or edit only what the brief "
                         "says the owner said yes to. If it does not say so, report the drafts and file nothing.")


class TicketWriterYes(unittest.TestCase):
    """ticket-writer states the ticket yes rule in the rule sources' words (#41)."""

    def test_ticket_writer_is_held_to_the_ticket_yes_rule(self):
        self.assertLessEqual(set(vp.TICKET_YES_TERMS), set(vp.CHAT_ASK_RULE_TERMS[vp.TICKET_WRITER]))

    def test_the_old_paragraph_misses_each_added_term(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ticket-writer.md"
            path.write_text(OLD_TICKET_WRITER_YES)
            with mock.patch.multiple(vp, ROOT=Path(tmp), problems=[]):
                vp.check_terms({path: vp.TICKET_WRITER_YES_TERMS}, "ticket yes rule")
                self.assertEqual(len(vp.problems), len(vp.TICKET_WRITER_YES_TERMS))


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
