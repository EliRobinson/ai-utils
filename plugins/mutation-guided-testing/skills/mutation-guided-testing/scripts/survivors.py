#!/usr/bin/env python3
"""Turn mutation-tool reports into a short, ranked triage list for the diff.

Usage:
    python3 survivors.py --scope scope.json \
        [--gremlins PKGDIR=report.json ...] \
        [--stryker PROJECTROOT=mutation.json ...] \
        [--mutmut PROJECTROOT=show.txt ...] [--cap N] [--json OUT]

PKGDIR and PROJECTROOT are repo-relative: Gremlins reports file names
relative to the mutated package, Stryker and mutmut relative to the project
root they ran in. Pass --stryker twice for the same files (for example unit
tests and Storybook play tests) to count a mutant killed if either run killed
it. For mutmut, pass the output of `mutmut show` for every non-killed mutant,
concatenated (see reference/python.md).

Keeps only mutants on changed lines (from diff_scope.py --json), drops
Tailwind/CSS class-string mutants as visual-only noise, ranks the rest by
risk, and prints at most SURVIVOR_CAP_PER_FILE per changed source file
(or --cap) as a table to fill in. Changed lines no test runs are listed in
full. The diff mutation score is printed for information only; it is not a
gate.

Stdlib only, Python 3.9+.
"""
import argparse
import dataclasses
import functools
import json
import os
import re
import subprocess
import sys
from typing import Optional

SURVIVOR_CAP_PER_FILE = 7

KILLED, SURVIVED, NO_COVERAGE = "killed", "survived", "no coverage"
STATUS_RANK = {KILLED: 0, SURVIVED: 1, NO_COVERAGE: 2}  # union keeps the lowest
# Each tool's status -> our outcome. A status in *_NOT_RUN never ran: it counts
# neither as killed nor as survived.
GREMLINS_STATUS = {"KILLED": KILLED, "TIMED OUT": KILLED, "LIVED": SURVIVED,
                   "NOT COVERED": NO_COVERAGE}
GREMLINS_NOT_RUN = {"NOT VIABLE", "SKIPPED", "RUNNABLE"}
STRYKER_STATUS = {"Killed": KILLED, "Timeout": KILLED, "Survived": SURVIVED,
                  "NoCoverage": NO_COVERAGE}
STRYKER_NOT_RUN = {"Ignored", "CompileError", "RuntimeError", "Pending"}
MUTMUT_STATUS = {"killed": KILLED, "timeout": KILLED, "segfault": KILLED,
                 "caught by type check": KILLED, "survived": SURVIVED,
                 "suspicious": SURVIVED, "no tests": NO_COVERAGE}
MUTMUT_NOT_RUN = {"not checked", "skipped", "check was interrupted by user"}

# Base weight per mutator: how likely a survivor is a real, uncaught bug.
MUTATOR_WEIGHT = {
    # Gremlins
    "CONDITIONALS_NEGATION": 5, "INVERT_LOGICAL": 5, "CONDITIONALS_BOUNDARY": 4,
    "INVERT_NEGATIVES": 2, "ARITHMETIC_BASE": 3, "INCREMENT_DECREMENT": 3,
    "INVERT_LOOPCTRL": 3, "INVERT_ASSIGNMENTS": 3, "REMOVE_SELF_ASSIGNMENTS": 3,
    # Stryker
    "ConditionalExpression": 5, "EqualityOperator": 5, "LogicalOperator": 5,
    "BooleanLiteral": 4, "BlockStatement": 4, "OptionalChaining": 3,
    "ArithmeticOperator": 3, "UpdateOperator": 3, "AssignmentOperator": 3,
    "MethodExpression": 3, "ObjectLiteral": 3, "UnaryOperator": 3,
    "ArrayDeclaration": 2, "ArrowFunction": 3, "Regex": 3, "StringLiteral": 1,
}
DEFAULT_WEIGHT = 3
FAST_KILL_SECONDS = 0.1
RISK_WORDS = re.compile(
    r"err|auth|tenant|org|owner|role|scope|permission|admin|token|secret|password|"
    r"expir|deadline|ttl|until|lock|mutex|env|fallback|default|limit|max|min|"
    r"disabled|aria|controlled|checked|value",
    re.I)
# A string literal of two or more CSS utility classes with a hyphen somewhere,
# e.g. "h-8 px-2 text-sm". One token ("org-admin", "aria-disabled", "2024-01-01")
# is a value, not a class list.
CLASS_TOKEN = r"[\w:\[\]/.%#()&>=!*,+-]+"
CLASS_STRING = re.compile(rf"^{CLASS_TOKEN}(\s+{CLASS_TOKEN})+$")
MUTMUT_HEADER = re.compile(r"^# (\S+): (.+)$")
MUTMUT_HUNK = re.compile(r"^@@ -(\d+)")
MUTMUT_NAME = re.compile(r"\.x[_ǁ](.+?)__mutmut_\d+$")


@dataclasses.dataclass(frozen=True)
class Mutant:
    file: str
    line: int
    column: Optional[int]
    tool: str
    mutator: str
    change: str
    status: str
    noise: bool = False


def warn(msg):
    print(f"survivors: warning: {msg}", file=sys.stderr)


def split_arg(value):
    root, sep, path = value.partition("=")
    if not sep or not path:
        sys.exit(f"survivors: expected ROOT=FILE, got {value!r}")
    return root.strip("/") or ".", path


def read_report(path, as_json):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f) if as_json else f.read()
    except OSError as exc:
        sys.exit(f"survivors: cannot read report {path}: {exc.strerror}")
    except ValueError as exc:
        sys.exit(f"survivors: report {path} is not valid JSON: {exc}")


def read_scope(path):
    scope = read_report(path, as_json=True)
    if not (isinstance(scope, dict) and isinstance(scope.get("repo"), str)
            and isinstance(scope.get("files"), list)):
        sys.exit(f"survivors: {path} is not a diff_scope.py --json file")
    here = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                          capture_output=True, text=True)
    if here.returncode == 0 and os.path.realpath(here.stdout.strip()) != os.path.realpath(scope["repo"]):
        sys.exit(f"survivors: {path} is the scope of {scope['repo']}, not of this repo "
                 f"({here.stdout.strip()}). Run diff_scope.py here first.")
    return scope


def norm(repo, root, path):
    """Repo-relative path of a report's file name, or None when it points
    outside the repo."""
    full = path if os.path.isabs(path) else os.path.join(repo, root, path)
    rel = os.path.relpath(os.path.normpath(full), repo)
    return None if rel == ".." or rel.startswith("../") else rel


def outcome(table, not_run, raw, where):
    """Our outcome for a tool's raw status, or None when the mutant never ran."""
    if raw in table:
        return table[raw]
    if raw not in not_run:
        warn(f"{where}: unknown status {raw!r}; left out")
    return None


def build(report_path, mutants):
    """Keep the mutants whose file is inside the repo."""
    kept = [m for m in mutants if m.file is not None]
    if len(kept) < len(mutants):
        warn(f"{report_path}: {len(mutants) - len(kept)} mutant(s) name a file outside "
             "the repo; left out")
    return kept


def gremlins_ran(rep):
    """How many mutants Gremlins actually ran (killed or lived). go_mutate.sh
    treats 0 as a failure ("Runnable: 0")."""
    return sum(GREMLINS_STATUS.get(m.get("status")) in (KILLED, SURVIVED)
               for f in rep.get("files") or [] for m in f.get("mutations") or [])


def gremlins_suspect(rep):
    """True when every kill came too fast to be a test run: a broken build."""
    killed, elapsed = rep.get("mutants_killed", 0), rep.get("elapsed_time")
    return bool(killed and not rep.get("mutants_lived") and elapsed is not None
                and elapsed / killed < FAST_KILL_SECONDS)


def from_gremlins(pkgdir, path, repo):
    rep = read_report(path, as_json=True)
    out = []
    for fi in rep.get("files") or []:
        for m in fi.get("mutations") or []:
            status = outcome(GREMLINS_STATUS, GREMLINS_NOT_RUN, m["status"], path)
            if status:
                out.append(Mutant(norm(repo, pkgdir, fi["file_name"]), m["line"],
                                  m.get("column"), "gremlins", m["type"], m["type"].lower(),
                                  status))
    return build(path, out), gremlins_suspect(rep)


def source_text(source, loc):
    """The original code a Stryker mutant replaced (1-based lines and columns)."""
    lines = source.splitlines()
    s, e = loc["start"], loc["end"]
    if s["line"] == e["line"]:
        return lines[s["line"] - 1][s["column"] - 1:e["column"] - 1]
    return "\n".join([lines[s["line"] - 1][s["column"] - 1:]]
                     + lines[s["line"]:e["line"] - 1]
                     + [lines[e["line"] - 1][:e["column"] - 1]])


def is_class_string(mutator, original):
    return (mutator == "StringLiteral" and "-" in original
            and CLASS_STRING.match(original.strip("\"'`")) is not None)


def from_stryker(root, path, repo):
    rep = read_report(path, as_json=True)
    out = []
    for rel, fi in (rep.get("files") or {}).items():
        for m in fi.get("mutants") or []:
            status = outcome(STRYKER_STATUS, STRYKER_NOT_RUN, m["status"], path)
            if not status:
                continue
            original = source_text(fi.get("source", ""), m["location"])
            start = m["location"]["start"]
            out.append(Mutant(
                norm(repo, root, rel), start["line"], start["column"], "stryker",
                m["mutatorName"],
                f"{original.strip()[:40]} → {m.get('replacement', '')[:40]}", status,
                noise=is_class_string(m["mutatorName"], original)))
    return build(path, out), False


@functools.lru_cache(maxsize=None)
def file_lines(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return tuple(f.read().splitlines())
    except OSError:
        return ()


def indent(text):
    return len(text) - len(text.lstrip())


def def_line(lines, func):
    """1-based line of the `def` that mutmut's `func` names, or None.
    `Classǁmethod` is looked up inside `class Class`; a plain name only at top level."""
    *cls, name = func.split("ǁ")
    def_re = re.compile(rf"^(\s*)(async\s+)?def\s+{re.escape(name)}\s*\(")
    if not cls:
        return next((i for i, t in enumerate(lines, 1)
                     if def_re.match(t) and indent(t) == 0), None)
    class_re = re.compile(rf"^(\s*)class\s+{re.escape(cls[-1])}\b")
    for i, t in enumerate(lines):
        if class_re.match(t):
            for j in range(i + 1, len(lines)):
                body = lines[j]
                if body.strip() and indent(body) <= indent(t):
                    break
                if def_re.match(body) and indent(body) > indent(t):
                    return j + 1
    return None


def mutmut_blocks(text):
    """Split concatenated `mutmut show` output into (name, status, lines)."""
    block = None
    for line in text.splitlines():
        h = MUTMUT_HEADER.match(line)
        if h:
            if block:
                yield block
            block = (h.group(1), h.group(2).strip(), [])
        elif block:
            block[2].append(line)
    if block:
        yield block


def parse_mutmut_block(lines):
    """(file, line within the function, removed code) of a mutant's diff, or None.
    Hunk line numbers in `mutmut show` count from the function's `def`."""
    file = hunk = None
    for text in lines:
        if text.startswith("--- ") and file is None:
            file = text[4:].strip()
        elif MUTMUT_HUNK.match(text):
            hunk = int(MUTMUT_HUNK.match(text).group(1))
        elif hunk is not None and text.startswith(" "):
            hunk += 1
        elif hunk is not None and text.startswith("-"):
            return file, hunk, text[1:]
    return None


def from_mutmut(root, path, repo):
    out = []
    for name, raw, lines in mutmut_blocks(read_report(path, as_json=False)):
        status = outcome(MUTMUT_STATUS, MUTMUT_NOT_RUN, raw, path)
        parsed = parse_mutmut_block(lines)
        if not status or not parsed:
            continue
        file, offset, removed = parsed
        file_rel = norm(repo, root, file)
        m = MUTMUT_NAME.search(name)
        start = def_line(file_lines(os.path.join(repo, file_rel)), m.group(1)) \
            if m and file_rel else None
        if start is None:
            warn(f"{path}: cannot find the function of {name} in {file_rel or file}; left out. "
                 "Run survivors.py before you edit that file again.")
            continue
        out.append(Mutant(file_rel, start + offset - 1, None, "mutmut", "mutmut",
                          removed.strip()[:80], status))
    return out, False


def union(mutants):
    """Merge runs of one tool over the same code with different test sets
    (for example unit tests and Storybook play tests): a mutant is killed if
    any run killed it, so it counts once."""
    merged = {}
    for m in mutants:
        key = (m.tool, m.file, m.line, m.column, m.mutator, m.change)
        if key not in merged or STATUS_RANK[m.status] < STATUS_RANK[merged[key].status]:
            merged[key] = m
    return list(merged.values())


def on_changed_line(m, scope_lines):
    return any(a <= m.line <= b for a, b in scope_lines.get(m.file, []))


def line_text(repo, m):
    lines = file_lines(os.path.join(repo, m.file))
    return lines[m.line - 1] if 0 < m.line <= len(lines) else ""


def score(m, repo):
    s = MUTATOR_WEIGHT.get(m.mutator, DEFAULT_WEIGHT)
    if RISK_WORDS.search(line_text(repo, m)):
        s += 3
    if m.status == NO_COVERAGE:
        s += 1
    return s


def spans(lines):
    """[3, 4, 5, 9] -> "3-5, 9"."""
    out, start = [], None
    for i, n in enumerate(lines):
        if start is None:
            start = n
        if i + 1 == len(lines) or lines[i + 1] != n + 1:
            out.append(f"{start}-{n}" if n != start else str(n))
            start = None
    return ", ".join(out)


def triage(scope, mutants, cap):
    repo = scope["repo"]
    lines = {f["path"]: f["lines"] for f in scope["files"]}
    on_diff = [m for m in mutants if on_changed_line(m, lines)]
    real = [m for m in on_diff if not m.noise]
    # mutmut's report lists only the mutants it did not kill, so it has no score.
    scored = [m for m in real if m.tool != "mutmut"]
    alive = sorted((m for m in real if m.status != KILLED),
                   key=lambda m: (-score(m, repo), m.file, m.line))
    uncovered = {}
    for m in real:
        if m.status == NO_COVERAGE:
            uncovered.setdefault(m.file, set()).add(m.line)
    return {
        "on_diff": len(real),
        "scored": len(scored),
        "killed": sum(m.status == KILLED for m in scored),
        "unscored_tools": sorted({m.tool for m in real} - {m.tool for m in scored}),
        "alive": alive,
        "noise": len(on_diff) - len(real),
        "cap": cap,
        "no_coverage": [f"{f}:{spans(sorted(ls))}" for f, ls in sorted(uncovered.items())],
    }


def render(t, repo, suspect):
    out = []
    if t["scored"]:
        pct = 100.0 * t["killed"] / t["scored"]
        note = (f" (suspect: kills in {', '.join(suspect)} look like build failures; "
                "rerun with go_mutate.sh)") if suspect else ""
        out.append(f"Diff mutation score (information, not a gate): {t['killed']}/"
                   f"{t['scored']} = {pct:.0f}%{note}")
    for tool in t["unscored_tools"]:
        out.append(f"Diff mutation score for {tool}: n/a (its report lists only the "
                   "mutants it did not kill)")
    if not t["on_diff"]:
        out.append("No mutants on changed lines. Check that the tool ran on the right "
                   "files before you call the result clean.")
    out.append(f"Visual-only class-string mutants left out: {t['noise']}")
    out.append("No coverage (changed lines no test runs): "
               + ("; ".join(t["no_coverage"]) or "none"))
    shown = t["alive"][: t["cap"]]
    out.append(f"Surviving: {len(t['alive'])}; showing {len(shown)} (cap {t['cap']})\n")
    if shown:
        out.append("| # | where | mutation | status | code | verdict |")
        out.append("|---|---|---|---|---|---|")
        for i, m in enumerate(shown, 1):
            code = line_text(repo, m).strip().replace("|", "\\|")[:60]
            change = m.change.replace("|", "\\|")
            out.append(f"| {i} | {m.file}:{m.line} | {m.tool} {change} | {m.status} | "
                       f"`{code}` | killed by: … / equivalent: … / not worth testing: … |")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--scope", required=True)
    ap.add_argument("--gremlins", action="append", default=[])
    ap.add_argument("--stryker", action="append", default=[])
    ap.add_argument("--mutmut", action="append", default=[])
    ap.add_argument("--cap", type=int, help=f"default: {SURVIVOR_CAP_PER_FILE} per changed file")
    ap.add_argument("--json", dest="json_out")
    a = ap.parse_args()
    if not (a.gremlins or a.stryker or a.mutmut):
        sys.exit("survivors: pass at least one --gremlins, --stryker or --mutmut report")
    scope = read_scope(a.scope)
    repo = scope["repo"]
    mutants, suspect = [], []
    for parse, values in ((from_gremlins, a.gremlins), (from_stryker, a.stryker),
                          (from_mutmut, a.mutmut)):
        for v in values:
            root, path = split_arg(v)
            found, is_suspect = parse(root, path, repo)
            mutants += found
            if is_suspect:
                suspect.append(path)
                warn(f"{path}: every kill took under {FAST_KILL_SECONDS}s and none lived. "
                     "Kills this fast usually mean the build is failing, often from relative "
                     "`replace` paths in go.mod. Rerun with go_mutate.sh, which makes them "
                     "absolute.")
    cap = a.cap if a.cap is not None else SURVIVOR_CAP_PER_FILE * len(scope["files"])
    t = triage(scope, union(mutants), cap)
    if a.json_out:
        with open(a.json_out, "w") as f:
            json.dump({**t, "alive": [dataclasses.asdict(m) for m in t["alive"][:cap]],
                       "suspect": suspect}, f, indent=2)
    print(render(t, repo, suspect))


if __name__ == "__main__":
    main()
