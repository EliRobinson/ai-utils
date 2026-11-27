#!/usr/bin/env python3
"""Turn mutation-tool reports into a short, ranked triage list for the diff.

Usage:
    python3 survivors.py --scope scope.json \
        [--gremlins PKGDIR=report.json ...] \
        [--stryker PROJECTROOT=mutation.json ...] \
        [--mutmut PROJECTROOT=show.txt ...] [--json OUT]

PKGDIR and PROJECTROOT are repo-relative: Gremlins reports file names
relative to the mutated package, Stryker and mutmut relative to the project
root they ran in. Pass --stryker twice for the same files (for example unit
tests and Storybook play tests) to count a mutant killed if either run killed
it. For mutmut, pass the output of `mutmut show` for every non-killed mutant,
concatenated (see reference/python.md).

Keeps only mutants on changed lines (from diff_scope.py --json), drops
Tailwind/CSS class-string mutants as visual-only noise, ranks the rest by
risk, and prints at most `survivor_cap` of them (7 per changed source file)
as a table to fill in. The diff mutation score is printed for information
only; it is not a gate.

Stdlib only, Python 3.9+.
"""
import argparse
import json
import os
import re
import sys

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
# Mutants the tool never ran: they count neither as killed nor as survived.
GREMLINS_NOT_RUN = {"NOT VIABLE", "SKIPPED", "RUNNABLE"}
STRYKER_NOT_RUN = {"Ignored", "CompileError", "RuntimeError", "Pending"}
FAST_KILL_SECONDS = 0.1
RISK_WORDS = re.compile(
    r"err|auth|tenant|org|owner|role|scope|permission|admin|token|secret|password|"
    r"expir|deadline|ttl|until|lock|mutex|env|fallback|default|limit|max|min|"
    r"disabled|aria|controlled|checked|value",
    re.I)
# A string literal made of CSS utility classes, e.g. "h-8 px-2 text-sm".
CLASS_STRING = re.compile(r"^[\w:\[\]/.%#()&>=!*,+-]+(\s+[\w:\[\]/.%#()&>=!*,+-]+)*$")
MUTMUT_HEADER = re.compile(r"^# (\S+): (.+)$")
MUTMUT_HUNK = re.compile(r"^@@ -(\d+)")
MUTMUT_NAME = re.compile(r"\.x[_ǁ](.+?)__mutmut_\d+$")


def warn(msg):
    print(f"WARNING {msg}", file=sys.stderr)


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


def norm(repo, root, path):
    """Repo-relative path of a report's file name."""
    if os.path.isabs(path):
        return os.path.relpath(path, repo)
    return os.path.normpath(os.path.join(root, path))


def from_gremlins(pkgdir, path, repo):
    rep = read_report(path, as_json=True)
    out = []
    for fi in rep.get("files") or []:
        for m in fi.get("mutations") or []:
            if m["status"] in GREMLINS_NOT_RUN:
                continue
            out.append({
                "file": norm(repo, pkgdir, fi["file_name"]), "line": m["line"],
                "tool": "gremlins", "mutator": m["type"], "change": m["type"].lower(),
                "status": {"LIVED": "survived", "NOT COVERED": "no coverage"}.get(
                    m["status"], "killed"),
            })
    killed = rep.get("mutants_killed", 0)
    elapsed = rep.get("elapsed_time")
    if killed and not rep.get("mutants_lived") and elapsed is not None \
            and elapsed / killed < FAST_KILL_SECONDS:
        warn(f"{path}: {killed} kills in {elapsed:.1f}s and no survivors. Kills this fast "
             "are usually build failures (relative replace paths?). Use go_mutate.sh.")
    return out


def source_text(source, loc):
    """The original code a Stryker mutant replaced (1-based lines and columns)."""
    lines = source.splitlines()
    s, e = loc["start"], loc["end"]
    if s["line"] == e["line"]:
        return lines[s["line"] - 1][s["column"] - 1:e["column"] - 1]
    return "\n".join([lines[s["line"] - 1][s["column"] - 1:]]
                     + lines[s["line"]:e["line"] - 1]
                     + [lines[e["line"] - 1][:e["column"] - 1]])


def from_stryker(root, path, repo):
    rep = read_report(path, as_json=True)
    out = []
    for rel, fi in (rep.get("files") or {}).items():
        for m in fi.get("mutants") or []:
            if m["status"] in STRYKER_NOT_RUN:
                continue
            original = source_text(fi.get("source", ""), m["location"])
            noise = (m["mutatorName"] == "StringLiteral"
                     and CLASS_STRING.match(original.strip("\"'`")) is not None
                     and "-" in original)
            out.append({
                "file": norm(repo, root, rel), "line": m["location"]["start"]["line"],
                "tool": "stryker", "mutator": m["mutatorName"],
                "change": f"{original.strip()[:40]} → {m.get('replacement', '')[:40]}",
                "status": {"Survived": "survived", "NoCoverage": "no coverage"}.get(
                    m["status"], "killed"),
                "noise": noise,
            })
    return out


def def_line(file_path, func):
    """1-based line of `def <func>` (last segment after ǁ for methods), or None."""
    name = func.split("ǁ")[-1]
    pat = re.compile(rf"^\s*(async\s+)?def\s+{re.escape(name)}\s*\(")
    try:
        with open(file_path, encoding="utf-8") as f:
            for i, text in enumerate(f, 1):
                if pat.match(text):
                    return i
    except OSError:
        return None
    return None


def mutmut_status(status):
    if "no tests" in status:
        return "no coverage"
    return "survived" if "survived" in status else "killed"


def from_mutmut(root, path, repo):
    """Parse concatenated `mutmut show` output. Hunk lines count from the `def`."""
    out, cur = [], None
    for text in read_report(path, as_json=False).splitlines():
        h = MUTMUT_HEADER.match(text)
        if h:
            cur = {"name": h.group(1), "status": h.group(2).strip(), "file": None,
                   "hunk": None, "offset": 0}
            continue
        if cur is None:
            continue
        if text.startswith("--- ") and cur["file"] is None:
            cur["file"] = text[4:].strip()
        elif MUTMUT_HUNK.match(text):
            cur["hunk"], cur["offset"] = int(MUTMUT_HUNK.match(text).group(1)), 0
        elif cur["hunk"] is not None and text[:1] in (" ", "-"):
            if not text.startswith("-"):
                cur["offset"] += 1
                continue
            file_rel = norm(repo, root, cur["file"])
            m = MUTMUT_NAME.search(cur["name"])
            start = def_line(os.path.join(repo, file_rel), m.group(1)) if m else None
            hunk, cur["hunk"] = cur["hunk"], None  # one entry per mutant
            if start is None:
                warn(f"{path}: cannot find the function of {cur['name']} in {file_rel}; "
                     "left out. Run survivors.py before you edit that file again.")
                continue
            out.append({
                "file": file_rel, "line": start + hunk - 1 + cur["offset"],
                "tool": "mutmut", "mutator": "mutmut", "change": text[1:].strip()[:80],
                "status": mutmut_status(cur["status"]),
            })
    return out


def union(mutants):
    """Merge runs of one tool over the same code with different test sets
    (for example unit tests and Storybook play tests): a mutant is killed if
    any run killed it, so it counts once."""
    rank = {"killed": 0, "survived": 1, "no coverage": 2}
    merged = {}
    for m in mutants:
        key = (m["tool"], m["file"], m["line"], m["mutator"], m["change"])
        if key not in merged or rank[m["status"]] < rank[merged[key]["status"]]:
            merged[key] = m
    return list(merged.values())


def on_changed_line(m, scope_lines):
    return any(a <= m["line"] <= b for a, b in scope_lines.get(m["file"], []))


def line_text(repo, m):
    try:
        with open(os.path.join(repo, m["file"]), encoding="utf-8", errors="replace") as f:
            return f.read().splitlines()[m["line"] - 1]
    except (OSError, IndexError):
        return ""


def score(m, repo):
    s = MUTATOR_WEIGHT.get(m["mutator"], DEFAULT_WEIGHT)
    if RISK_WORDS.search(line_text(repo, m)):
        s += 3
    if m["status"] == "no coverage":
        s += 1
    return s


def triage(scope, mutants):
    repo = scope["repo"]
    lines = {f["path"]: f["lines"] for f in scope["files"]}
    on_diff = [m for m in mutants if on_changed_line(m, lines)]
    noise = [m for m in on_diff if m.get("noise")]
    real = [m for m in on_diff if not m.get("noise")]
    alive = [m for m in real if m["status"] != "killed"]
    alive.sort(key=lambda m: (-score(m, repo), m["file"], m["line"]))
    return {
        "on_diff": len(real),
        "killed": len(real) - len(alive),
        "alive": alive,
        "noise": len(noise),
        "cap": scope["survivor_cap"],
    }


def render(t, repo):
    out = []
    if t["on_diff"]:
        pct = 100.0 * t["killed"] / t["on_diff"]
        out.append(f"Diff mutation score (information, not a gate): {t['killed']}/"
                   f"{t['on_diff']} = {pct:.0f}%")
    else:
        out.append("No mutants on changed lines. Check that the tool ran on the right "
                   "files before you call the result clean.")
    out.append(f"Visual-only class-string mutants left out: {t['noise']}")
    shown = t["alive"][: t["cap"]]
    out.append(f"Surviving: {len(t['alive'])}; showing {len(shown)} (cap {t['cap']})\n")
    if shown:
        out.append("| # | where | mutation | status | code | verdict |")
        out.append("|---|---|---|---|---|---|")
        for i, m in enumerate(shown, 1):
            code = line_text(repo, m).strip().replace("|", "\\|")[:60]
            change = m["change"].replace("|", "\\|")
            out.append(f"| {i} | {m['file']}:{m['line']} | {m['tool']} {change} | "
                       f"{m['status']} | `{code}` | killed by … / equivalent: … / not worth it: … |")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--scope", required=True)
    ap.add_argument("--gremlins", action="append", default=[])
    ap.add_argument("--stryker", action="append", default=[])
    ap.add_argument("--mutmut", action="append", default=[])
    ap.add_argument("--json", dest="json_out")
    a = ap.parse_args()
    if not (a.gremlins or a.stryker or a.mutmut):
        sys.exit("survivors: pass at least one --gremlins, --stryker or --mutmut report")
    scope = read_report(a.scope, as_json=True)
    repo = scope["repo"]
    mutants = []
    for v in a.gremlins:
        mutants += from_gremlins(*split_arg(v), repo)
    for v in a.stryker:
        mutants += from_stryker(*split_arg(v), repo)
    for v in a.mutmut:
        mutants += from_mutmut(*split_arg(v), repo)
    t = triage(scope, union(mutants))
    if a.json_out:
        with open(a.json_out, "w") as f:
            json.dump({**t, "alive": t["alive"][: t["cap"]]}, f, indent=2)
    print(render(t, repo))


if __name__ == "__main__":
    main()
