#!/usr/bin/env python3
"""Validate this repo's plugin marketplace.

Checks the things that silently stop a plugin or skill from loading — a
mangled frontmatter block, a manifest name, version or description that
drifted from its marketplace entry, a ${CLAUDE_PLUGIN_ROOT} path left behind
by a move. It also runs each skill's scripts/check-*.mjs self-check when node
is installed, runs the unit tests in scripts/test_*.py, and checks the GitHub
Actions workflows (rules in docs/agents/ci.md). It is the whole test gate,
locally and in CI.

Run from the repo root:

    python3 scripts/validate-plugins.py

Exits non-zero on the first category that fails, after reporting every
problem it found.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from typing import NamedTuple

import workflow_rules  # scripts/workflow_rules.py, next to this file

ROOT = Path(__file__).resolve().parent.parent
MARKETPLACE = ROOT / ".claude-plugin" / "marketplace.json"

FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.S)
FIELD = re.compile(r"^([A-Za-z_-]+):\s*(.*)$", re.M)
PLUGIN_ROOT_REF = re.compile(r"\$\{CLAUDE_PLUGIN_ROOT\}/([A-Za-z0-9_./-]+)")

problems: list[str] = []


def fail(msg: str) -> None:
    problems.append(msg)


def load_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        fail(f"{path.relative_to(ROOT)}: missing")
    except json.JSONDecodeError as exc:
        fail(f"{path.relative_to(ROOT)}: invalid JSON — {exc}")
    return None


NO_FRONTMATTER = "no parseable frontmatter block at the top"


def frontmatter_fields(text: str) -> dict | None:
    """The fields of a file's leading frontmatter block, or None if it has none."""
    match = FRONTMATTER.match(text)
    return dict(FIELD.findall(match.group(1))) if match else None


def check_skill(skill_dir: Path) -> str | None:
    """Validate one skill folder. Returns its declared name, or None."""
    rel = skill_dir.relative_to(ROOT)
    skill_md = skill_dir / "SKILL.md"

    if not skill_md.is_file():
        fail(f"{rel}: no SKILL.md")
        return None

    fields = frontmatter_fields(skill_md.read_text())
    if fields is None:
        # The usual cause is a markdown formatter turning --- into -----
        # or folding `name:` into a heading.
        fail(f"{rel}/SKILL.md: {NO_FRONTMATTER}")
        return None

    name = fields.get("name", "").strip()
    if not name:
        fail(f"{rel}/SKILL.md: frontmatter has no name")
    elif name != skill_dir.name:
        fail(f"{rel}/SKILL.md: name {name!r} does not match its folder")

    if not fields.get("description", "").strip():
        fail(f"{rel}/SKILL.md: frontmatter has no description")

    return name or None


def check_plugin_root_refs(plugin_dir: Path) -> None:
    """Every ${CLAUDE_PLUGIN_ROOT}/... path must exist under the plugin root."""
    for skill_md in sorted(plugin_dir.glob("skills/*/SKILL.md")):
        for ref in PLUGIN_ROOT_REF.findall(skill_md.read_text()):
            target = plugin_dir / ref.rstrip(".,)")
            if not target.is_file():
                rel = skill_md.relative_to(ROOT)
                fail(f"{rel}: ${{CLAUDE_PLUGIN_ROOT}}/{ref} does not exist")


AGENT_ROSTER = ROOT / "plugins" / "agent-roster"
SETUP_SKILL = AGENT_ROSTER / "skills" / "setup-agentic-workflow"
COORDINATOR_PROMPT = AGENT_ROSTER / "coordinator" / "coordinator-prompt.md"
ROUTE_WORK = AGENT_ROSTER / "skills" / "route-work" / "SKILL.md"
GUARDRAILS = SETUP_SKILL / "templates" / "agents-guardrails.md"
MULTI_AGENT = SETUP_SKILL / "templates" / "docs-agents" / "multi-agent.md"
GIT_WORKFLOW = SETUP_SKILL / "templates" / "docs-agents" / "git-workflow.md"
REVIEW_GATE = SETUP_SKILL / "templates" / "docs-agents" / "review-gate.md"
RULESET = SETUP_SKILL / "templates" / "github-main-ruleset.json"
SETUP_SKILL_MD = SETUP_SKILL / "SKILL.md"
PR_FINISHER = AGENT_ROSTER / "agents" / "pr-finisher.md"
REPO_AGENTS_MD = ROOT / "AGENTS.md"
REPO_COORDINATOR_PROMPT = ROOT / "docs" / "agents" / "coordinator-prompt.md"
ASKS_BOARD_SKILL = ROOT / "plugins" / "asks-board" / "skills" / "asks-board" / "SKILL.md"
PLACEHOLDER = re.compile(r"\{\{([A-Z_]+)\}\}")
LEADING_COMMENT = re.compile(r"\A<!--(.*?)-->", re.S)
# Files the setup installs that must name no ticketing tool: the tool is a
# setting in each repo's docs/agents/issue-tracker.md, which is left out here
# because its template holds the GitHub Issues default.
TOOL_NEUTRAL = [
    COORDINATOR_PROMPT,
    GUARDRAILS,
    GIT_WORKFLOW,
    REVIEW_GATE,
    MULTI_AGENT,
]
HARD_CODED_TRACKER = re.compile(r"gh issue|github issue", re.I)
# Ping steps that belong only in the asks-board skill. A pointer that copies
# them drifts: "close it with `ackAt`" is the wording that hid answered asks.
COPIED_BOARD_STEPS = ["close it with `ackat`", "the row is the truth"]


class RuleHome(NamedTuple):
    """A rule's one home, and the files that must point to it.

    A pointer states the rule in a phrase and names the skill (and, when
    `section` is set, the home's section); it never copies the home's steps.
    """

    home: Path
    heading: str  # the home's heading line
    skill: str  # the skill name the pointers must give, in backticks
    pointers: dict  # pointer file -> the phrase it must say (lowercase)
    section: str | None = None  # the heading text every pointer must quote
    never_copied: tuple = ()


RULE_HOMES = [
    RuleHome(ROUTE_WORK, "## Hand off every task", "`route-work`",
             {COORDINATOR_PROMPT: "hand off every task", GUARDRAILS: "hands off every task",
              MULTI_AGENT: "hands off every task"}),
    RuleHome(ASKS_BOARD_SKILL, "### If you are a project coordinator (not the router)", "`asks-board`",
             {path: "only the board router watches"
              for path in (COORDINATOR_PROMPT, ROUTE_WORK, GUARDRAILS, MULTI_AGENT,
                           SETUP_SKILL / "SKILL.md", AGENT_ROSTER / "README.md")},
             section="If you are a project coordinator",
             never_copied=tuple(COPIED_BOARD_STEPS)),
]


def rel(path: Path) -> Path:
    return path.relative_to(ROOT)


def read_or_fail(path: Path):
    if not path.is_file():
        fail(f"{rel(path)}: missing")
        return None
    return path.read_text(encoding="utf-8")


def fail_matching_lines(path: Path, text: str, pattern: re.Pattern, message: str) -> None:
    for number, line in enumerate(text.splitlines(), 1):
        if pattern.search(line):
            fail(f"{rel(path)}:{number}: {message}")


def check_agent_roster_templates() -> None:
    """The coordinator prompt and the setup templates stay fillable and tool-neutral."""
    if not COORDINATOR_PROMPT.is_file():
        fail(f"{rel(COORDINATOR_PROMPT)}: missing; the template checks cannot run")
        return

    # The coordinator prompt lists its placeholders in its leading comment.
    prompt = COORDINATOR_PROMPT.read_text()
    comment = LEADING_COMMENT.match(prompt)
    if not comment:
        fail(f"{rel(COORDINATOR_PROMPT)}: no leading comment with a placeholder list")
    else:
        listed = set(PLACEHOLDER.findall(comment.group(1)))
        used = set(PLACEHOLDER.findall(prompt[comment.end():]))
        for name in sorted(used - listed):
            fail(f"{rel(COORDINATOR_PROMPT)}: uses {{{{{name}}}}} but its placeholder list does not")
        for name in sorted(listed - used):
            fail(f"{rel(COORDINATOR_PROMPT)}: lists {{{{{name}}}}} but never uses it")

    # The setup skill fills every placeholder its templates use.
    skill_text = read_or_fail(SETUP_SKILL / "SKILL.md") or ""
    templates = [COORDINATOR_PROMPT, *sorted((SETUP_SKILL / "templates").rglob("*.md"))]
    for template in templates:
        body = template.read_text()
        if template == COORDINATOR_PROMPT and comment:
            body = body[comment.end():]
        for name in sorted(set(PLACEHOLDER.findall(body))):
            if f"{{{{{name}}}}}" not in skill_text:
                fail(f"{rel(template)}: uses {{{{{name}}}}}, which setup-agentic-workflow never fills")

    for path in TOOL_NEUTRAL:
        text = read_or_fail(path)
        if text is None:
            continue
        # The setup drops the coordinator prompt's leading comment; blank it,
        # keeping its lines so the numbers still match the file.
        if path == COORDINATOR_PROMPT and comment:
            text = re.sub(r"[^\n]", "", text[: comment.end()]) + text[comment.end():]
        fail_matching_lines(path, text, HARD_CODED_TRACKER,
                            "names a ticketing tool; point to docs/agents/issue-tracker.md instead")

    for rule in RULE_HOMES:
        if rule.heading not in (read_or_fail(rule.home) or ""):
            fail(f"{rel(rule.home)}: no {rule.heading!r} section, the home of the rule {rule.skill} points to")
        if rule.section and rule.section not in rule.heading:
            fail(f"validate-plugins.py: {rule.section!r} is not part of the heading {rule.heading!r}")
        for path, phrase in rule.pointers.items():
            text = read_or_fail(path)
            if text is None:
                continue
            if phrase not in text.lower() or rule.skill not in text:
                fail(f"{rel(path)}: must say {phrase!r} and point to {rule.skill}")
            if rule.section and rule.section not in text:
                fail(f"{rel(path)}: must name the {rule.section!r} section of {rule.skill}")
            for step in rule.never_copied:
                if step in text.lower():
                    fail(f"{rel(path)}: copies the step {step!r}; point to {rule.skill} instead")


A11Y_NAME = "accessibility-agents"
A11Y_MARKETPLACE = "community-access"
A11Y_PLUGIN = f"{A11Y_NAME}@{A11Y_MARKETPLACE}"
# The reviewed upstream commit and the version it declares (upstream tag v7.1.0
# is an older commit with the same version). The install command adds the
# marketplace at this commit, which is the pin; plugin.json asks for the version.
A11Y_PIN_SHA = "a538edc9edfb98cdd8bae96d6b79542874b478f7"
A11Y_PIN_VERSION = "=7.1.0"
A11Y_MARKETPLACE_ADD = "claude plugin marketplace add Community-Access/accessibility-agents"
A11Y_PINNED_ADD = f"{A11Y_MARKETPLACE_ADD}#{A11Y_PIN_SHA}"
# The docs that give the install command.
A11Y_INSTALL_DOCS = [ROOT / "README.md", AGENT_ROSTER / "README.md", SETUP_SKILL / "SKILL.md"]
A11Y_PREFIX = "mcp__plugin_accessibility-agents_accessibility-agents__"
# The accessibility-agents MCP tools the agents hold: scans, checks and
# get_specialist. None writes files or audit history. Kept by hand against the
# plugin's mcp-server/tool-metadata.js; the two agents below must list exactly these.
A11Y_READ_ONLY_TOOLS = {
    "get_specialist", "run_axe_scan", "run_playwright_a11y_tree",
    "run_playwright_keyboard_scan", "run_playwright_contrast_scan",
    "run_playwright_viewport_scan", "check_contrast", "check_form_labels",
    "check_heading_structure", "check_link_text",
}
ACCESSIBILITY_CRITIC = AGENT_ROSTER / "agents" / "accessibility-critic.md"
IMPLEMENTER_UI = AGENT_ROSTER / "agents" / "implementer-ui.md"
A11Y_GATE_SKILL = "accessibility-agents:accessibility-lead"
# Every agent that edits files carries this sentence word for word: it keeps
# the third-party skill from widening what the agent does.
A11Y_GATE_RULE = ("The skill is a gate to open, and its checklists are reference only: never follow its steps "
                  "that dispatch agents, write files (such as `.a11y-history`), run commands or touch the network.")
# What the critic must say when the plugin or a scan is missing.
CRITIC_PHRASES = ("BLOCKED:", "If you cannot scan", "not scanned:")
# The accessibility plugin accessibility-agents replaced. Only changelog
# history may name it. "Deque" is matched capitalised, so Python's deque passes.
RETIRED_A11Y_NAMES = re.compile(r"axe-accessibility|axe-mcp-server|\bDeque\b")


def agent_tools(path: Path) -> list[str]:
    fields = frontmatter_fields(read_or_fail(path) or "")
    if fields is None:
        fail(f"{rel(path)}: {NO_FRONTMATTER}")
        return []
    return [t.strip() for t in fields.get("tools", "").split(",") if t.strip()]


def check_a11y_tools(agents: dict) -> None:
    """Agents hold only the read-only accessibility-agents tools; the two that scan hold all of them."""
    wanted = {A11Y_PREFIX + t for t in A11Y_READ_ONLY_TOOLS}
    for path, tools in agents.items():
        held = {t for t in tools if t.startswith(A11Y_PREFIX)}
        for tool in sorted(held - wanted):
            fail(f"{rel(path)}: {tool} is not one of the read-only accessibility-agents tools")
        if path in (ACCESSIBILITY_CRITIC, IMPLEMENTER_UI):
            for tool in sorted(wanted - held):
                fail(f"{rel(path)}: tools must list {tool}; its steps call it")
    if "Skill" in agents.get(ACCESSIBILITY_CRITIC, []):
        fail(f"{rel(ACCESSIBILITY_CRITIC)}: the critic loads no skill, so it must not have the Skill tool")


def check_a11y_gate(agents: dict) -> None:
    """Every agent that edits files can open the plugin's UI edit gate."""
    for path, tools in agents.items():
        if not {"Edit", "Write"} & set(tools):
            continue
        text = read_or_fail(path) or ""
        if "Skill" not in tools or A11Y_GATE_SKILL not in text:
            fail(f"{rel(path)}: edits files, so it needs the Skill tool and the step that loads "
                 f"{A11Y_GATE_SKILL} when the plugin's hook refuses a UI edit")
        if A11Y_GATE_RULE not in text:
            fail(f"{rel(path)}: must carry the gate rule word for word: {A11Y_GATE_RULE!r}")


def check_a11y_critic_contract() -> None:
    text = read_or_fail(ACCESSIBILITY_CRITIC) or ""
    for phrase in CRITIC_PHRASES:
        if phrase not in text:
            fail(f"{rel(ACCESSIBILITY_CRITIC)}: must contain \"{phrase}\", "
                 "so a missing plugin or scan is reported")


def check_a11y_dependency() -> None:
    """agent-roster declares the plugin, and the marketplace lets it come from community-access."""
    manifest = load_json(AGENT_ROSTER / ".claude-plugin" / "plugin.json") or {}
    wanted = {"name": A11Y_NAME, "marketplace": A11Y_MARKETPLACE, "version": A11Y_PIN_VERSION}
    if wanted not in manifest.get("optionalDependencies", []):
        fail(f"{rel(AGENT_ROSTER)}/.claude-plugin/plugin.json: optionalDependencies must list {json.dumps(wanted)}")
    marketplace = load_json(MARKETPLACE) or {}
    if A11Y_MARKETPLACE not in marketplace.get("allowCrossMarketplaceDependenciesOn", []):
        fail(f"{rel(MARKETPLACE)}: allowCrossMarketplaceDependenciesOn must list {A11Y_MARKETPLACE}")


def check_a11y_pin() -> None:
    """Every install command adds the marketplace at the reviewed commit, and setup checks it."""
    for path in A11Y_INSTALL_DOCS:
        if A11Y_PINNED_ADD not in (read_or_fail(path) or ""):
            fail(f"{rel(path)}: must give the pinned install command `{A11Y_PINNED_ADD}`")
    # Any spelling of the add command (CLI or /plugin, owner/repo or URL, # or @ ref) without the pin.
    unpinned = re.compile(r"marketplace add\s+(?:https://github\.com/)?Community-Access/accessibility-agents"
                          r"(?:\.git)?(?![#@]" + A11Y_PIN_SHA + ")", re.I)
    for path in repo_docs({".md"}):
        fail_matching_lines(path, path.read_text(encoding="utf-8"), unpinned,
                            f"adds the community-access marketplace without the pin; use `{A11Y_PINNED_ADD}`")
    setup = read_or_fail(SETUP_SKILL / "SKILL.md") or ""
    for phrase in ("`source.ref`", "`gitCommitSha`"):
        if phrase not in setup:
            fail(f"{rel(SETUP_SKILL)}/SKILL.md: step 1.12 must check {phrase} against {A11Y_PIN_SHA}")


def check_a11y_setup_probe() -> None:
    """The setup skill looks for the tool by the name the agents hold."""
    if A11Y_PREFIX + "get_specialist" not in (read_or_fail(SETUP_SKILL / "SKILL.md") or ""):
        fail(f"{rel(SETUP_SKILL)}/SKILL.md: must name {A11Y_PREFIX}get_specialist, the tool it checks for")


def repo_docs(suffixes: set) -> list[Path]:
    """The root README and the docs under plugins/ and docs/, without changelogs, which keep history."""
    paths = [ROOT / "README.md", *ROOT.glob("plugins/**/*"), *ROOT.glob("docs/**/*")]
    return sorted(p for p in paths if p.is_file() and p.suffix in suffixes and p.name != "CHANGELOG.md")


def check_retired_a11y_names() -> None:
    for path in repo_docs({".md", ".json"}):
        fail_matching_lines(path, path.read_text(encoding="utf-8"), RETIRED_A11Y_NAMES,
                            "mentions the removed axe-accessibility plugin; delete the mention "
                            "(only a CHANGELOG.md may keep it)")


def check_accessibility_agents() -> None:
    agents = {path: agent_tools(path) for path in sorted(ROOT.glob("plugins/*/agents/*.md"))}
    check_a11y_tools(agents)
    check_a11y_gate(agents)
    check_a11y_critic_contract()
    check_a11y_dependency()
    check_a11y_pin()
    check_a11y_setup_probe()
    check_retired_a11y_names()


# The dropped branch rule (#2): a new `-r2` branch and PR when main moves,
# and "rebase, never merge main in". It must not come back in any doc.
OLD_BRANCH_RULE = re.compile(
    r"-r2\b|never merge `?main`? into|rebase, never merge|clean replay|rebase-only|rebase merges only", re.I
)
# Every agent prompt carries the rule that replaced it, word for word.
BRANCH_RULE_LINE = ("- Never force push. Keep one branch and one PR. Catch up with the base branch by merging it in "
                    "(`git merge origin/<base>`) and push normally; before your first push you may rebase your own "
                    "commits instead.")
# The key terms each rule file must keep (lowercase). A template and its
# filled copy share one list.
GUARDRAIL_TERMS = ["keep one branch and one pr", "never force push", "git merge origin/main"]
CLEAN_MERGE_CHECK = "git show --remerge-diff --format= <merge>"
COORDINATOR_TERMS = ["catch up on the same branch", "git log --merges --format=%h origin/main..origin/<branch>",
                     "merges reviewed:"]
BRANCH_RULE_TERMS = {
    GUARDRAILS: GUARDRAIL_TERMS,
    REPO_AGENTS_MD: GUARDRAIL_TERMS,
    GIT_WORKFLOW: ["keep the same branch and the same pr", "never force push", "git merge origin/main"],
    REVIEW_GATE: [CLEAN_MERGE_CHECK, "merges reviewed:"],
    PR_FINISHER: [CLEAN_MERGE_CHECK],
    COORDINATOR_PROMPT: COORDINATOR_TERMS,
    REPO_COORDINATOR_PROMPT: COORDINATOR_TERMS,
}
MERGE_STYLES = ("merge", "squash", "rebase")
MERGE_STYLE_LINE = re.compile(r"^- \*\*Merge style:\*\* `([a-z]+)`$", re.M)
# The repo merge flag that turns on each style.
MERGE_FLAGS = {"merge": "allow_merge_commit", "squash": "allow_squash_merge", "rebase": "allow_rebase_merge"}


def check_old_branch_rule_gone() -> None:
    paths = {p.resolve(): p for p in [REPO_AGENTS_MD, *repo_docs({".md"})]}  # docs/agents has symlinks
    for path in paths.values():
        fail_matching_lines(path, path.read_text(encoding="utf-8"), OLD_BRANCH_RULE,
                            "brings back the dropped -r2 / rebase-only branch rule; state the same-branch "
                            "rule in templates/docs-agents/git-workflow.md instead")


def check_branch_rule_stated() -> None:
    for path, terms in BRANCH_RULE_TERMS.items():
        text = (read_or_fail(path) or "").lower()
        for term in terms:
            if term not in text:
                fail(f"{rel(path)}: must contain {term!r} (any case), part of the same-branch rule")
    for agent in sorted((AGENT_ROSTER / "agents").glob("*.md")):
        if BRANCH_RULE_LINE not in (read_or_fail(agent) or ""):
            fail(f"{rel(agent)}: must carry the branch rule word for word: {BRANCH_RULE_LINE!r}")


def default_merge_style() -> str | None:
    """The one style the ruleset template allows: the default setup ships."""
    ruleset = load_json(RULESET) or {}
    methods = [rule.get("parameters", {}).get("allowed_merge_methods")
               for rule in ruleset.get("rules", []) if rule.get("type") == "pull_request"]
    if len(methods) != 1 or not isinstance(methods[0], list) or len(methods[0]) != 1 \
            or methods[0][0] not in MERGE_STYLES:
        fail(f"{rel(RULESET)}: the pull_request rule must allow exactly one of {MERGE_STYLES}")
        return None
    return methods[0][0]


def check_setup_patch(default: str) -> None:
    """The setup's PATCH command turns on the default style, and only it."""
    patch = [line for line in (read_or_fail(SETUP_SKILL_MD) or "").splitlines()
             if line.startswith("gh api -X PATCH repos/{owner}/{repo} ")]
    wanted = {f"-F {flag}={'true' if style == default else 'false'}" for style, flag in MERGE_FLAGS.items()}
    if len(patch) != 1 or not all(part in patch[0] for part in wanted):
        fail(f"{rel(SETUP_SKILL_MD)}: needs one PATCH command that sets {sorted(wanted)}")


def check_merge_style(default: str) -> None:
    """The coordinator template uses the placeholder; this repo's filled copies name its own style.

    docs/agents/git-workflow.md is a symlink to the template, so its Merge style
    line is both this repo's style and the shipped default: it must match the ruleset.
    """
    if "--{{MERGE_STYLE}} --match-head-commit" not in (read_or_fail(COORDINATOR_PROMPT) or ""):
        fail(f"{rel(COORDINATOR_PROMPT)}: merge step must use `gh pr merge N --{{{{MERGE_STYLE}}}}`")
    if "merge style: {{MERGE_STYLE}}." not in (read_or_fail(GUARDRAILS) or ""):
        fail(f"{rel(GUARDRAILS)}: must say \"merge style: {{{{MERGE_STYLE}}}}.\"")
    found = MERGE_STYLE_LINE.findall(read_or_fail(GIT_WORKFLOW) or "")
    if len(found) != 1 or found[0] not in MERGE_STYLES:
        fail(f"{rel(GIT_WORKFLOW)}: needs one '- **Merge style:** `merge|squash|rebase`' line")
        return
    style = found[0]
    if style != default:
        fail(f"{rel(GIT_WORKFLOW)}: the Merge style line says {style!r}, but the ruleset template "
             f"allows {default!r}; they must match")
    if f"--{style} --match-head-commit" not in (read_or_fail(REPO_COORDINATOR_PROMPT) or ""):
        fail(f"{rel(REPO_COORDINATOR_PROMPT)}: merge step must use --{style}, the style git-workflow.md sets")
    if f"merge style: {style}." not in (read_or_fail(REPO_AGENTS_MD) or ""):
        fail(f"{rel(REPO_AGENTS_MD)}: must say \"merge style: {style}.\", the style git-workflow.md sets")


def check_branch_rule() -> None:
    """The -r2 rule stays gone; the same-branch rule and the merge style are stated."""
    check_old_branch_rule_gone()
    check_branch_rule_stated()
    default = default_merge_style()
    if default:
        check_setup_patch(default)
        check_merge_style(default)


VENDORED_SKILL = AGENT_ROSTER / "skills" / "thermo-nuclear-code-quality-review"
REMOVED_LINE = "disable-model-invocation: true"  # the last frontmatter key upstream
PINNED_COMMIT = re.compile(r"^- Commit: `([0-9a-f]{40})`$", re.M)
UPSTREAM_SHA = re.compile(r"^- Upstream SKILL\.md SHA-256: `([0-9a-f]{64})`$", re.M)
VENDORED_SHA = re.compile(r"^- Vendored SKILL\.md SHA-256: `([0-9a-f]{64})`$", re.M)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def check_vendored_thermonuclear() -> None:
    """The vendored Cursor skill is the pinned upstream file minus one line.

    SOURCE.md records the pinned commit and the SHA-256 of both the upstream
    and the vendored SKILL.md. Putting the removed line back at the end of the
    frontmatter must give the upstream hash, so any other edit fails here.
    """
    skill_path = VENDORED_SKILL / "SKILL.md"
    skill_raw = read_or_fail(skill_path)
    source = read_or_fail(VENDORED_SKILL / "SOURCE.md")
    licence = read_or_fail(VENDORED_SKILL / "LICENSE")
    if licence is not None and not (
        licence.startswith("MIT License") and "Cursor" in licence
    ):
        fail(f"{rel(VENDORED_SKILL / 'LICENSE')}: not Cursor's MIT licence text")
    if skill_raw is None or source is None:
        return

    if REMOVED_LINE in skill_raw:
        fail(f"{rel(skill_path)}: still has {REMOVED_LINE!r}, so the Skill tool refuses it")

    fields = {}
    for label, pattern in (
        ("commit", PINNED_COMMIT),
        ("upstream SHA-256", UPSTREAM_SHA),
        ("vendored SHA-256", VENDORED_SHA),
    ):
        found = pattern.search(source)
        if found is None:
            fail(f"{rel(VENDORED_SKILL / 'SOURCE.md')}: no {label} line")
        else:
            fields[label] = found.group(1)
    if len(fields) < 3:
        return

    if sha256(skill_raw.encode()) != fields["vendored SHA-256"]:
        fail(
            f"{rel(skill_path)}: SHA-256 does not match SOURCE.md; "
            "do not edit the vendored skill (see SOURCE.md, Updating)"
        )

    frontmatter = FRONTMATTER.match(skill_raw)
    if frontmatter is None:
        return  # check_skill already reported it
    end = frontmatter.end(1) + 1  # just after the last frontmatter line
    restored = skill_raw[:end] + REMOVED_LINE + "\n" + skill_raw[end:]
    if sha256(restored.encode()) != fields["upstream SHA-256"]:
        fail(
            f"{rel(skill_path)}: differs from upstream by more than the removed "
            f"{REMOVED_LINE!r} line (SHA-256 with that line restored does not match SOURCE.md)"
        )


WORKFLOWS = ROOT / ".github" / "workflows"
CI_WORKFLOW = WORKFLOWS / "ci.yml"
TESTS_DIR = ROOT / "scripts"
TEST_PATTERN = "test_*.py"


def check_workflows() -> None:
    """The CI workflow exists, and every workflow keeps the hardening rules."""
    if not CI_WORKFLOW.is_file():
        fail(f"{rel(CI_WORKFLOW)}: missing; it runs these checks on every PR")
    for path in sorted([*WORKFLOWS.glob("*.yml"), *WORKFLOWS.glob("*.yaml")]):
        text = path.read_text(encoding="utf-8")
        found = workflow_rules.workflow_problems(text)
        if path == CI_WORKFLOW:
            found += workflow_rules.ci_job_problems(text)
        for number, msg in found:
            fail(f"{rel(path)}:{number}: {msg}" if number else f"{rel(path)}: {msg}")


def run_unit_tests() -> None:
    """Run scripts/test_*.py, so this one command is the whole gate."""
    where = f"{rel(TESTS_DIR)}/{TEST_PATTERN}"
    suite = unittest.defaultTestLoader.discover(str(TESTS_DIR), pattern=TEST_PATTERN)
    result = unittest.TextTestRunner(stream=io.StringIO(), verbosity=0).run(suite)
    if result.testsRun == 0:
        fail(f"{where}: found no unit tests; the gate must run them")
    elif not result.wasSuccessful():
        failed = [test.id() for test, _ in (*result.failures, *result.errors)]
        fail(f"{where}: {len(failed)} unit test(s) failed: {', '.join(failed)}; see the output with "
             f"`python3 -m unittest discover -s {rel(TESTS_DIR)} -p '{TEST_PATTERN}'`")


def run_self_checks() -> None:
    """Run every skill's scripts/check-*.mjs, so a hook regression fails here.

    Skipped, with a note, when node is not installed; in CI (`CI` set) a
    missing node fails instead, so CI never skips them.
    """
    checks = sorted(ROOT.glob("plugins/*/skills/*/scripts/check-*.mjs"))
    if not checks:
        return
    if shutil.which("node") is None:
        if os.environ.get("CI"):
            fail(f"node not found; CI must run the {len(checks)} self-check(s), "
                 "so add an `actions/setup-node` step to ci.yml")
            return
        print(f"note: node not found, skipped {len(checks)} self-check(s)", file=sys.stderr)
        return
    for check in checks:
        try:
            run = subprocess.run(["node", str(check)], capture_output=True, text=True, timeout=300)
        except subprocess.TimeoutExpired:
            fail(f"{check.relative_to(ROOT)}: self-check did not finish in 300 seconds")
            continue
        if run.returncode != 0:
            tail = "\n".join((run.stdout + run.stderr).strip().splitlines()[-15:])
            fail(f"{check.relative_to(ROOT)}: self-check failed\n{tail}")


def check_manifest(source: str, entry: dict, manifest: dict) -> None:
    """A plugin.json must have a description, and must agree with its
    marketplace entry on name and on any version or description the entry sets."""
    entry_name = entry.get("name", "<unnamed>")
    if manifest.get("name") != entry_name:
        fail(
            f"{source}: plugin.json name {manifest.get('name')!r} "
            f"does not match marketplace entry {entry_name!r}"
        )
    description = manifest.get("description")
    has_description = isinstance(description, str) and bool(description.strip())
    if not has_description:
        fail(f"{source}: plugin.json has no description")
    # A missing description is reported once, above, not again as a mismatch.
    for field in ("version", "description") if has_description else ("version",):
        if field in entry and manifest.get(field) != entry[field]:
            fail(
                f"{source}: plugin.json {field} {manifest.get(field)!r} "
                f"does not match marketplace entry {entry[field]!r}; "
                "decide which is current and copy it to the other file"
            )


def main() -> int:
    marketplace = load_json(MARKETPLACE)
    if marketplace is None:
        report()
        return 1

    for field in ("name", "owner", "plugins"):
        if field not in marketplace:
            fail(f"marketplace.json: missing {field!r}")

    entries = marketplace.get("plugins", [])
    if not entries:
        fail("marketplace.json: lists no plugins")

    seen_skills: dict[str, str] = {}
    skill_count = 0

    for entry in entries:
        entry_name = entry.get("name", "<unnamed>")
        source = entry.get("source")
        if not source:
            fail(f"marketplace.json: entry {entry_name!r} has no source")
            continue

        plugin_dir = (ROOT / source).resolve()
        if not plugin_dir.is_dir():
            fail(f"marketplace.json: entry {entry_name!r} points at {source}, which does not exist")
            continue

        manifest = load_json(plugin_dir / ".claude-plugin" / "plugin.json")
        if manifest is None:
            continue

        check_manifest(source, entry, manifest)

        skills_dir = plugin_dir / "skills"
        if not skills_dir.is_dir():
            fail(f"{source}: no skills/ directory")
            continue

        for skill_dir in sorted(p for p in skills_dir.iterdir() if p.is_dir()):
            skill_count += 1
            name = check_skill(skill_dir)
            if name:
                if name in seen_skills:
                    fail(
                        f"skill name {name!r} is defined twice: "
                        f"{seen_skills[name]} and {entry_name}"
                    )
                seen_skills[name] = entry_name

        check_plugin_root_refs(plugin_dir)

    check_agent_roster_templates()
    check_branch_rule()
    check_vendored_thermonuclear()
    check_accessibility_agents()
    check_workflows()
    run_unit_tests()
    run_self_checks()
    report(skill_count, len(entries))
    return 1 if problems else 0


def report(skill_count: int = 0, plugin_count: int = 0) -> None:
    if problems:
        print(f"FAIL — {len(problems)} problem(s):\n", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return
    print(f"OK — {plugin_count} plugin(s), {skill_count} skill(s), no problems found.")


if __name__ == "__main__":
    os.chdir(ROOT)
    sys.exit(main())
