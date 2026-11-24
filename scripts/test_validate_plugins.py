"""Tests for the workflow checks in validate-plugins.py.

validate-plugins.py runs these itself. To run only them, from the repo root:

    python3 -m unittest discover -s scripts -p 'test_*.py'
"""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("validate_plugins", HERE / "validate-plugins.py")
vp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vp)

SHA = "a" * 40  # any 40-hex value; not tied to the real pin in ci.yml
CHECKOUT = f"actions/checkout@{SHA} # v7.0.1"

GOOD = f"""\
name: ci
on:
  pull_request:
    branches: [main]
permissions:
  contents: read
jobs:
  validate:
    name: validate
    runs-on: ubuntu-latest
    steps:
      - uses: {CHECKOUT}
        with:
          persist-credentials: false
      - run: python3 scripts/validate-plugins.py
"""


def swap(old: str, new: str, text: str = GOOD) -> str:
    """GOOD with `old` replaced; fails loudly if `old` is not there."""
    assert old in text, f"{old!r} not in the base workflow"
    return text.replace(old, new)


def messages(found) -> list[str]:
    return [msg for _, msg in found]


class WorkflowChecks(unittest.TestCase):
    def assertFlags(self, text: str, needle: str):
        out = messages(vp.workflow_problems(text))
        self.assertTrue(any(needle in m for m in out), out)

    def assertClean(self, text: str):
        self.assertEqual(vp.workflow_problems(text), [])

    def test_good_workflow_passes(self):
        self.assertClean(GOOD)
        self.assertEqual(vp.ci_job_problems(GOOD), [])

    def test_repo_ci_workflow_passes(self):
        text = (HERE.parent / ".github" / "workflows" / "ci.yml").read_text()
        self.assertEqual(vp.workflow_problems(text), [])
        self.assertEqual(vp.ci_job_problems(text), [])

    # pinning
    def test_tag_ref_fails(self):
        self.assertFlags(swap(f"@{SHA} # v7.0.1", "@v7"), "not pinned")

    def test_short_sha_fails(self):
        self.assertFlags(swap(SHA, SHA[:12]), "not pinned")

    def test_quoted_tag_ref_fails(self):
        self.assertFlags(swap(CHECKOUT, "'actions/checkout@main'"), "not pinned")

    def test_double_quoted_pinned_ref_passes(self):
        self.assertClean(swap(CHECKOUT, f'"actions/checkout@{SHA}" # v7.0.1'))

    def test_missing_version_comment_fails(self):
        self.assertFlags(swap(" # v7.0.1", ""), "comment")

    def test_third_party_owner_fails(self):
        self.assertFlags(swap("actions/checkout@", "someone/checkout@"), "allowed owner")

    def test_github_owner_allowed(self):
        self.assertClean(GOOD + f"      - uses: github/codeql-action/init@{SHA} # v3.0.0\n")

    def test_docker_action_fails(self):
        self.assertFlags(swap(CHECKOUT, "docker://alpine:3"), "not pinned")

    def test_local_action_allowed(self):
        self.assertClean(GOOD + "      - uses: ./.github/actions/x\n")

    def test_reusable_workflow_fails(self):
        self.assertFlags(GOOD + f"  other:\n    uses: actions/x/.github/workflows/y.yml@{SHA} # v1\n",
                         "reusable workflow")

    def test_flow_style_uses_fails(self):
        self.assertFlags(GOOD + "      - {uses: someone/evil@v1}\n", "cannot read")

    def test_quoted_uses_key_fails(self):
        self.assertFlags(GOOD + '      - "uses": someone/evil@v1\n', "cannot read")

    # triggers
    def test_pull_request_target_fails(self):
        self.assertFlags(swap("  pull_request:", "  pull_request_target:"), "pull_request_target")

    def test_workflow_run_fails(self):
        self.assertFlags(swap("  pull_request:", "  workflow_run:"), "workflow_run")

    def test_commented_pull_request_target_ignored(self):
        self.assertClean("# pull_request_target is banned\n" + GOOD)

    # permissions
    def test_missing_permissions_fails(self):
        self.assertFlags(swap("permissions:\n  contents: read\n", ""), "no top-level")

    def test_commented_out_workflow_fails(self):
        text = "\n".join("# " + line for line in GOOD.splitlines())
        self.assertFlags(text, "no top-level")
        self.assertTrue(vp.ci_job_problems(text))

    def test_extra_permission_fails(self):
        self.assertFlags(swap("  contents: read\n", "  contents: read\n  pull-requests: read\n"), "exactly")

    def test_read_all_fails(self):
        out = messages(vp.workflow_problems(swap("permissions:\n  contents: read", "permissions: read-all")))
        self.assertTrue(any("exactly" in m and "read-all" in m for m in out), out)

    def test_equivalent_permissions_pass(self):
        self.assertClean(swap("  contents: read\n", "  contents: 'read'  # least privilege\n"))
        self.assertClean(swap("permissions:\n  contents: read", "permissions: { contents: read }"))

    def test_job_write_permission_fails(self):
        self.assertFlags(swap("    runs-on:", "    permissions:\n      contents: write\n    runs-on:"),
                         "write access")

    def test_quoted_write_permission_fails(self):
        self.assertFlags(swap("    runs-on:", "    permissions:\n      contents: 'write'\n    runs-on:"),
                         "write access")

    def test_write_all_fails(self):
        self.assertFlags(swap("    runs-on:", "    permissions: write-all\n    runs-on:"), "write access")

    def test_write_in_a_step_name_passes(self):
        self.assertClean(GOOD + "      - name: write the bundle\n        run: write-docs\n")

    # secrets
    def test_secret_fails(self):
        self.assertFlags(GOOD + "        env:\n          T: ${{ secrets.TOKEN }}\n", "secrets")

    def test_tojson_secrets_fails(self):
        self.assertFlags(GOOD + "      - run: echo '${{ toJSON(secrets) }}'\n", "secrets")

    def test_secrets_inherit_fails(self):
        self.assertFlags(GOOD + "  other:\n    secrets: inherit\n", "secrets")

    def test_secrets_in_a_script_name_passes(self):
        self.assertClean(GOOD + "      - run: python3 scripts/check-secrets.py\n")

    # checkout
    def test_checkout_without_persist_credentials_fails(self):
        self.assertFlags(swap("        with:\n          persist-credentials: false\n", ""),
                         "persist-credentials")

    def test_persist_credentials_in_a_later_step_does_not_count(self):
        text = swap("        with:\n          persist-credentials: false\n",
                    "      - uses: ./x\n        with:\n          persist-credentials: false\n")
        self.assertFlags(text, "persist-credentials")

    def test_named_checkout_step_passes(self):
        self.assertClean(swap(f"      - uses: {CHECKOUT}", f"      - name: checkout\n        uses: {CHECKOUT}"))

    # the validate job
    def test_missing_validate_job_fails(self):
        self.assertTrue(vp.ci_job_problems(swap("  validate:\n    name: validate",
                                                "  plugins:\n    name: plugins")))

    def test_validate_outside_jobs_fails(self):
        text = swap("  validate:\n    name: validate", "  plugins:\n    name: plugins")
        text = text.replace("on:\n", "on:\n  validate:\n    name: validate\n", 1)
        self.assertTrue(vp.ci_job_problems(text))

    def test_validate_job_any_indent_and_quotes_passes(self):
        text = GOOD.replace("\n  ", "\n    ").replace("name: validate", 'name: "validate"')
        self.assertEqual(vp.ci_job_problems(text), [])


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
        out = self.run_check({"ci.yml": GOOD, "x.yaml": swap(" # v7.0.1", "")})
        self.assertTrue(any(p.startswith(".github/workflows/x.yaml:12: ") for p in out), out)

    def test_validate_job_required_only_in_ci(self):
        self.assertEqual(self.run_check({"ci.yml": GOOD, "x.yml": swap("validate", "other")}), [])


if __name__ == "__main__":
    unittest.main()
