"""Hardening rules for this repo's GitHub Actions workflows.

validate-plugins.py runs them on every file in .github/workflows/. The rules,
and why each exists, are in docs/agents/ci.md.

The check is line-based, because the standard library has no YAML parser. It
is strict on purpose: a form it cannot read fails rather than passes. Inline
comments are kept when a line is checked, so a banned word in a comment fails
too.
"""

from __future__ import annotations

import re
from typing import List, Optional, Tuple

# Owners whose actions a workflow may use: GitHub's own. Add an owner here only
# on purpose, after review.
ALLOWED_ACTION_OWNERS = {"actions", "github"}
# Triggers that run with the base repo's rights on events an outsider can start.
BANNED_TRIGGERS = ("pull_request_target", "workflow_run", "issue_comment")

# USES parses the one form we accept; ANY_USES spots any other way to write a
# `uses` key. Keep both: "ANY_USES matched, USES did not" is the fail-closed
# "form this check cannot read" error.
USES = re.compile(r"^\s*(?:-\s*)?uses:\s*['\"]?([^\s'\"#]+)['\"]?(?:\s+(#.*))?\s*$")
ANY_USES = re.compile(r"\buses\b")
PINNED_ACTION = re.compile(r"^([A-Za-z0-9_.-]+)/[A-Za-z0-9_./-]+@[0-9a-f]{40}$")
VERSION_COMMENT = re.compile(r"^#\s*v\d")
WRITE = re.compile(
    r"(?:^|[\s{,])[\w-]+\s*:\s*['\"]?write['\"]?\s*(?:[,}#]|$)|:\s*['\"]?write-all['\"]?\s*(?:#|$)"
)
SECRETS = re.compile(r"\bsecrets\b")
# Data an outsider controls; read inside `${{ }}` it can inject into a step.
UNTRUSTED = re.compile(r"\bgithub\s*(?:\.\s*event\b(?!_)|\[\s*['\"]event)|\bgithub\.head_ref\b|\binputs\.")
# YAML escapes and line joins that could spell a banned word the checks cannot see.
ESCAPE = re.compile(r"\\[xuU]|\\$")
PERSIST_FALSE = re.compile(r"^\s*persist-credentials:\s*['\"]?false['\"]?\s*(?:#.*)?$")
WITH = re.compile(r"^\s*with\s*:\s*(?:#.*)?$")
STEP_START = re.compile(r"^(\s*)-\s")

# (line number, or None for the whole file; message). typing.Tuple, because
# this alias runs at import time and `int | None` fails there on Python 3.9.
Problem = Tuple[Optional[int], str]


def code_lines(text: str) -> List[str]:
    """The workflow's lines with whole-line comments blanked (line numbers kept)."""
    return ["" if line.lstrip().startswith("#") else line.rstrip() for line in text.splitlines()]


def drop_comment(line: str) -> str:
    return line.split(" #", 1)[0].rstrip()


def unquote(s: str) -> str:
    return re.sub(r"\s+", " ", drop_comment(s).replace("'", "").replace('"', "").strip())


def indent(line: str) -> int:
    return len(line) - len(line.lstrip())


def nested(lines: List[str], start: int, depth: Optional[int] = None) -> List[int]:
    """Indexes of the non-blank lines after `start` nested deeper than `depth`
    (default: the indent of lines[start])."""
    depth = indent(lines[start]) if depth is None else depth
    out = []
    for j in range(start + 1, len(lines)):
        if not lines[j].strip():
            continue
        if indent(lines[j]) <= depth:
            break
        out.append(j)
    return out


def children(lines: List[str], start: int) -> List[int]:
    """Indexes of the direct children of the key at lines[start]."""
    below = nested(lines, start)
    return [j for j in below if indent(lines[j]) == indent(lines[below[0]])] if below else []


def top_level(lines: List[str], key: str) -> List[int]:
    return [i for i, line in enumerate(lines) if re.match(rf"^{key}\s*:", line)]


def steps(lines: List[str]) -> List[List[int]]:
    """Each list item (`- ...`) with the lines nested under it."""
    return [[i, *nested(lines, i, len(m.group(1)))]
            for i, line in enumerate(lines) if (m := STEP_START.match(line))]


def permissions_problems(lines: List[str]) -> List[Problem]:
    """Top-level `permissions:` is exactly `contents: read`."""
    top = top_level(lines, "permissions")
    if not top:
        return [(None, "no top-level `permissions:` block; add `permissions:` with `contents: read`")]
    i = top[0]
    inline = unquote(lines[i].split(":", 1)[1])
    body = [unquote(lines[j]) for j in nested(lines, i)]
    if (not inline and body == ["contents: read"]) or (
        re.fullmatch(r"\{ ?contents ?: ?read ?\}", inline) and not body
    ):
        return []
    found = inline or "; ".join(body) or "nothing"
    return [(i + 1, f"top-level permissions must be exactly `contents: read`, found `{found}`")]


def uses_problems(number: int, line: str) -> List[Problem]:
    """A `uses` line names an allowed owner's action, pinned to a SHA, with a version comment."""
    match = USES.match(line)
    if not match:
        return [(number, "`uses` is written in a form this check cannot read; "
                         "write it as `uses: owner/name@<sha> # vX.Y.Z`")]
    ref, comment = match.group(1), match.group(2) or ""
    if ref.startswith("./"):
        return [(number, f"{ref} is a local action, and this check cannot see inside it; "
                         "write its steps in the workflow")]
    pinned = PINNED_ACTION.match(ref)
    if not pinned:
        return [(number, f"{ref} is not pinned to a full 40-hex commit SHA; "
                         "pin the tag's commit (see docs/agents/ci.md)")]
    found: List[Problem] = []
    if pinned.group(1) not in ALLOWED_ACTION_OWNERS:
        found.append((number, f"{ref} is not from an allowed owner "
                              f"({', '.join(sorted(ALLOWED_ACTION_OWNERS))}); use one of theirs, "
                              "or add the owner to ALLOWED_ACTION_OWNERS in "
                              "scripts/workflow_rules.py on purpose"))
    if "/.github/workflows/" in ref:
        found.append((number, f"{ref} calls a reusable workflow; write the steps in this workflow"))
    if not VERSION_COMMENT.match(comment):
        found.append((number, f"{ref} has no `# vX.Y.Z` comment naming the pinned version"))
    return found


def line_problems(lines: List[str]) -> List[Problem]:
    """Per-line rules: no privileged trigger, write access, secrets, untrusted
    data, escapes or job-level permissions; every `uses` pinned."""
    found: List[Problem] = []
    for number, line in enumerate(lines, 1):
        def flag(msg: str) -> None:
            found.append((number, msg))

        for trigger in BANNED_TRIGGERS:
            if re.search(rf"\b{trigger}\b", line):
                flag(f"uses the `{trigger}` trigger, which runs with the base repo's rights; "
                     "use `pull_request`")
        if WRITE.search(line):
            flag("asks for write access; CI may only have `contents: read`")
        if SECRETS.search(line):
            flag("mentions `secrets`; CI uses no secrets, so remove it")
        if UNTRUSTED.search(line):
            flag("reads `github.event`, `github.head_ref` or `inputs`, which an outsider can "
                 "set; CI does not use them")
        if ESCAPE.search(line):
            flag("has a `\\x`, `\\u` or `\\U` escape or a trailing `\\`; write the text out plainly")
        if line[:1].isspace() and re.search(r"\bpermissions\b", line):
            flag("sets permissions below the top level; set them only in the top-level block")
        if ANY_USES.search(line):
            found.extend(uses_problems(number, line))
    return found


def checkout_problems(lines: List[str]) -> List[Problem]:
    """Every actions/checkout step sets `persist-credentials: false` under `with:`."""
    found: List[Problem] = []
    for step in steps(lines):
        uses = [j for j in step if (m := USES.match(lines[j])) and m.group(1).startswith("actions/checkout@")]
        if not uses:
            continue
        withs = [j for j in step if WITH.match(lines[j])]
        if not any(PERSIST_FALSE.match(lines[k]) for w in withs for k in nested(lines, w)):
            found.append((uses[0] + 1, "actions/checkout without `persist-credentials: false` under "
                                       "`with:`; add it, so later steps cannot read the token"))
    return found


def workflow_problems(text: str) -> List[Problem]:
    """Every hardening problem in one workflow."""
    lines = code_lines(text)
    return [*permissions_problems(lines), *line_problems(lines), *checkout_problems(lines)]


def ci_job_problems(text: str) -> List[Problem]:
    """ci.yml has a job `validate` named `validate`: the check that must pass before merge."""
    lines = code_lines(text)
    for i in top_level(lines, "jobs")[:1]:
        for job in children(lines, i):
            if not re.fullmatch(r"['\"]?validate['\"]?\s*:", drop_comment(lines[job]).strip()):
                continue
            if any(re.fullmatch(r"name\s*:\s*['\"]?validate['\"]?", drop_comment(lines[k]).strip())
                   for k in children(lines, job)):
                return []
    return [(None, "no job `validate` with `name: validate`; it is the check that must pass "
                   "before a PR merges")]
