#!/usr/bin/env python3
"""Package skills as .skill bundles for upload to the Claude apps.

The chat side of Claude has no marketplace. Skills go up one at a time as
.skill files, which are zip archives holding a single top-level folder. This
builds those bundles from the plugins in this repo, so there is one source of
truth and no second copy to keep in step.

    python3 scripts/build-skill-bundles.py              # every portable skill
    python3 scripts/build-skill-bundles.py route-work   # just these

Skills that read ${CLAUDE_PLUGIN_ROOT} are skipped. That variable is set only
for an installed plugin, so those skills would upload cleanly and then fail
the moment they reached for a shared file. Naming one explicitly is an error
rather than a silent skip.

A skill can pull shared plugin files into its bundle with bundle-extras.txt;
see extras() below.

Bundles land in dist/, which is not tracked.
"""

from __future__ import annotations

import re
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGINS = ROOT / "plugins"
DIST = ROOT / "dist"

PLUGIN_ROOT_REF = re.compile(r"\$\{CLAUDE_PLUGIN_ROOT\}")
FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.S)


def find_skills() -> dict[str, Path]:
    """Map every skill name in the repo to its folder."""
    skills: dict[str, Path] = {}
    for skill_dir in sorted(PLUGINS.glob("*/skills/*")):
        if skill_dir.is_dir():
            skills[skill_dir.name] = skill_dir
    return skills


def portability_problem(skill_dir: Path) -> str | None:
    """Why this skill cannot be uploaded standalone, or None if it can."""
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.is_file():
        return "no SKILL.md"
    text = skill_md.read_text()
    if not FRONTMATTER.match(text):
        return "no parseable frontmatter block"
    if PLUGIN_ROOT_REF.search(text):
        return (
            "reads ${CLAUDE_PLUGIN_ROOT}, which is set only inside an installed "
            "plugin — its shared files would be missing"
        )
    return None


EXTRAS = "bundle-extras.txt"


def extras(skill_dir: Path) -> list[tuple[Path, Path]]:
    """Files from outside the skill folder that its bundle must carry.

    A skill that installs a shared plugin file (for example the agent-roster
    agents) lists it in bundle-extras.txt as `<source> => <dest>`, both
    relative to the skill folder. The plugin keeps one copy; the bundle gets
    its own. Blank lines and lines starting with # are ignored. Raises
    ValueError on a bad line, before any bundle is written.
    """
    listing = skill_dir / EXTRAS
    if not listing.is_file():
        return []
    pairs = []
    for number, raw in enumerate(listing.read_text().splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        where = f"{skill_dir.name}/{EXTRAS}:{number}"
        source, arrow, dest_text = (part.strip() for part in line.partition("=>"))
        if not arrow or not source or not dest_text:
            raise ValueError(f"{where}: expected `<source> => <dest>`")
        src = (skill_dir / source).resolve()
        if not src.is_file():
            raise ValueError(f"{where}: source {source} does not exist")
        dest = Path(dest_text)
        if dest.is_absolute() or ".." in dest.parts:
            raise ValueError(f"{where}: dest {dest_text} must stay inside the skill folder")
        if (skill_dir / dest).exists():
            raise ValueError(f"{where}: dest {dest_text} already exists in the skill folder")
        if dest in (d for _, d in pairs):
            raise ValueError(f"{where}: dest {dest_text} is listed twice")
        pairs.append((src, dest))
    return pairs


def build(skill_dir: Path) -> Path:
    """Zip one skill folder into dist/<name>.skill."""
    name = skill_dir.name
    bundle = DIST / f"{name}.skill"

    files = sorted(p for p in skill_dir.rglob("*") if p.is_file() and p.name != EXTRAS)
    shared = extras(skill_dir)
    with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as z:
        for path in files:
            # Every entry sits under a single top-level folder named for the
            # skill, which is the layout the apps expect.
            z.write(path, Path(name) / path.relative_to(skill_dir))
        for src, dest in shared:
            z.write(src, Path(name) / dest)

    return bundle


def main(argv: list[str]) -> int:
    skills = find_skills()
    if not skills:
        print("No skills found under plugins/*/skills/", file=sys.stderr)
        return 1

    requested = argv[1:]
    unknown = [n for n in requested if n not in skills]
    if unknown:
        print(f"Unknown skill(s): {', '.join(unknown)}", file=sys.stderr)
        print(f"Available: {', '.join(sorted(skills))}", file=sys.stderr)
        return 1

    targets = requested or sorted(skills)

    # Naming a non-portable skill is a mistake worth stopping for; sweeping
    # past one during a full build is just how a full build works.
    if requested:
        blocked = [(n, p) for n in targets if (p := portability_problem(skills[n]))]
        if blocked:
            print("Cannot bundle:\n", file=sys.stderr)
            for name, why in blocked:
                print(f"  {name} — {why}", file=sys.stderr)
            return 1

    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir()

    built, skipped = [], []
    for name in targets:
        why = portability_problem(skills[name])
        if why:
            skipped.append((name, why))
            continue
        try:
            bundle = build(skills[name])
        except ValueError as exc:
            print(f"Cannot bundle {name}: {exc}", file=sys.stderr)
            return 1
        built.append((name, bundle.stat().st_size))

    for name, size in built:
        print(f"  built    dist/{name}.skill  ({size:,} bytes)")
    for name, why in skipped:
        print(f"  skipped  {name} — {why}")

    print(f"\n{len(built)} bundle(s) in dist/. Upload them one at a time in the Claude apps.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
