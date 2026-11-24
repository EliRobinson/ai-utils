# Source

This skill is a vendored copy of Cursor's `thermo-nuclear-code-quality-review` skill. It ships inside agent-roster so the `thermonuclear-reviewer` agent can load it with the `Skill` tool, as `agent-roster:thermo-nuclear-code-quality-review`. Nothing has to be installed by hand.

- Repo: https://github.com/cursor/plugins
- Path: `cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md`
- Commit: `35a90942a7f02e1ebbc2443643179815f2147954`
- Licence: MIT, copyright (c) 2026 Cursor. The full text is in `LICENSE` next to this file, copied from `cursor-team-kit/LICENSE` at the same commit.
- Upstream SKILL.md SHA-256: `7faca08b51b643b2ddd0836f92af15574444024685dcc1e677dbbb39ae8c9e8f`
- Vendored SKILL.md SHA-256: `3fe9fb20c10a3aeffc059c4c9e0624e2cc5972b02811ded56334daedec4186b2`

## The one change

The frontmatter line `disable-model-invocation: true` is removed. Upstream sets it, and it makes the `Skill` tool refuse every model and subagent call, so the reviewer could never load the skill. Nothing else differs from the upstream file.

## Updating

Do not edit `SKILL.md` here. `scripts/validate-plugins.py` checks its SHA-256 against the value above. The hashes catch accidental edits only, because they live in the same repo as the file. When you update, download the upstream file at the new commit yourself and confirm its SHA-256 matches the "Upstream" value. To move to a newer upstream commit:

1. Read the upstream diff between the commit above and the new one for this path.
2. Copy the new `SKILL.md` here and remove only the `disable-model-invocation: true` line. The validator puts that line back at the end of the frontmatter to rebuild the upstream hash, so if upstream moves it, update the check in `scripts/validate-plugins.py` too.
3. Copy `cursor-team-kit/LICENSE` from the new commit to `LICENSE`.
4. Update the commit and both SHA-256 values above (`shasum -a 256`). If the new `LICENSE` has a different copyright line, update the licence check in `scripts/validate-plugins.py` too. Add a CHANGELOG entry.
