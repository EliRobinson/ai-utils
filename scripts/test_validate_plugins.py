"""Tests for the workflow checks in validate-plugins.py.

Run from the repo root:

    python3 -m unittest discover -s scripts -p 'test_*.py'
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("validate_plugins", HERE / "validate-plugins.py")
vp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vp)

SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1"

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
      - uses: actions/checkout@{SHA} # v7.0.1
        with:
          persist-credentials: false
      - run: python3 scripts/validate-plugins.py
"""


def problems(text: str, **kw) -> list[str]:
    return vp.workflow_problems(text, **kw)


class WorkflowChecks(unittest.TestCase):
    def test_good_workflow_passes(self):
        self.assertEqual(problems(GOOD, require_validate_job=True), [])

    def test_repo_ci_workflow_passes(self):
        text = (HERE.parent / ".github" / "workflows" / "ci.yml").read_text()
        self.assertEqual(problems(text, require_validate_job=True), [])

    def test_tag_ref_fails(self):
        out = problems(GOOD.replace(f"@{SHA} # v7.0.1", "@v7"))
        self.assertTrue(any("not pinned" in p for p in out), out)

    def test_short_sha_fails(self):
        out = problems(GOOD.replace(SHA, SHA[:12]))
        self.assertTrue(any("not pinned" in p for p in out), out)

    def test_quoted_tag_ref_fails(self):
        out = problems(GOOD.replace(f"actions/checkout@{SHA} # v7.0.1", "'actions/checkout@main'"))
        self.assertTrue(any("not pinned" in p for p in out), out)

    def test_missing_version_comment_fails(self):
        out = problems(GOOD.replace(" # v7.0.1", ""))
        self.assertTrue(any("comment" in p for p in out), out)

    def test_third_party_owner_fails(self):
        out = problems(GOOD.replace("actions/checkout", "someone/checkout"))
        self.assertTrue(any("allowed owner" in p for p in out), out)

    def test_docker_action_fails(self):
        out = problems(GOOD.replace(f"actions/checkout@{SHA} # v7.0.1", "docker://alpine:3"))
        self.assertTrue(any("not pinned" in p for p in out), out)

    def test_local_action_allowed(self):
        self.assertEqual(problems(GOOD.replace(f"actions/checkout@{SHA} # v7.0.1", "./.github/actions/x")), [])

    def test_pull_request_target_fails(self):
        out = problems(GOOD.replace("  pull_request:", "  pull_request_target:"))
        self.assertTrue(any("pull_request_target" in p for p in out), out)

    def test_commented_pull_request_target_ignored(self):
        self.assertEqual(problems("# pull_request_target is banned\n" + GOOD), [])

    def test_missing_permissions_fails(self):
        out = problems(GOOD.replace("permissions:\n  contents: read\n", ""))
        self.assertTrue(any("no top-level" in p for p in out), out)

    def test_commented_out_workflow_fails(self):
        text = "\n".join("# " + line for line in GOOD.splitlines())
        out = problems(text, require_validate_job=True)
        self.assertTrue(any("no top-level" in p for p in out), out)
        self.assertTrue(any("validate" in p for p in out), out)

    def test_extra_permission_fails(self):
        out = problems(GOOD.replace("  contents: read\n", "  contents: read\n  pull-requests: read\n"))
        self.assertTrue(any("exactly" in p for p in out), out)

    def test_read_all_fails(self):
        out = problems(GOOD.replace("permissions:\n  contents: read", "permissions: read-all"))
        self.assertTrue(any("exactly" in p for p in out), out)

    def test_job_write_permission_fails(self):
        out = problems(GOOD.replace("    runs-on:", "    permissions:\n      contents: write\n    runs-on:"))
        self.assertTrue(any("write access" in p for p in out), out)

    def test_secret_fails(self):
        out = problems(GOOD + "        env:\n          T: ${{ secrets.TOKEN }}\n")
        self.assertTrue(any("secret" in p for p in out), out)

    def test_missing_validate_job_fails(self):
        out = problems(GOOD.replace("  validate:\n    name: validate", "  plugins:\n    name: plugins"),
                       require_validate_job=True)
        self.assertTrue(any("validate" in p for p in out), out)


if __name__ == "__main__":
    unittest.main()
