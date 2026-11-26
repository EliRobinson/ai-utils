# ai-utils

Claude Code plugins by Eli Robinson: `agent-roster` and `asks-board`.

## Layout

```
plugins/
  agent-roster/                  shared job -> agent map for coordinator chats
    agents/                        subagents (implementers, critics, pr-finisher, …)
    coordinator/                   coordinator prompt template
    skills/                        route-work (routing table + coordinator rules),
                                   setup-agentic-workflow (installs the workflow into a repo),
                                   thermo-nuclear-code-quality-review (Cursor's, vendored)
  asks-board/                    Asks board: one artifact for the asks chats need you to click
    skills/                        asks-board (daily rules), asks-board-setup (+ board page template)
.claude-plugin/marketplace.json  marketplace index, lists everything in plugins/
.claude/agents/                  this repo's reviewer agents (symlinks into agent-roster)
.claude/settings.json            wires the guard and review-gate hooks
docs/agents/                     agent rules: git workflow, review gate, coordinator prompt, ...
.github/workflows/ci.yml         CI: the `validate` job (see docs/agents/ci.md)
.github/dependabot.yml           weekly bumps of the pinned actions
AGENTS.md                        agent rules for this repo (CLAUDE.md links to it)
LICENSE, SECURITY.md             MIT license, how to report a security problem
scripts/                         validate-plugins.py (the test gate), workflow_rules.py,
                                 test_validate_plugins.py, build-skill-bundles.py,
                                 hook scripts (symlinks into agent-roster)
```

## Contributing

`AGENTS.md` is the maintainer's agent workflow: one worktree and PR per item, the review gate, and no merge unless the merge policy allows it (here `ask`: Eli says "merge N").

Outside contributors: fork the repo, use any branch name, run `python3 scripts/validate-plugins.py`, and open a PR. The maintainer runs the review gate. If you use Claude Code in a clone, note that `.claude/settings.json` loads two hooks: one refuses tree-changing git in the main checkout, so work in a worktree (`git worktree add ../ai-utils-<task> -b <branch> origin/main`), and one refuses `gh pr create` unless the PR body has a `## Review` record. Open the PR from the GitHub web page instead; do not write a record for reviews that did not run.

## Install

```
/plugin marketplace add EliRobinson/ai-utils
```

```
/plugin install asks-board@ai-utils
```

Before you install agent-roster, install Community Access's `accessibility-agents@community-access` plugin, which it needs (see `plugins/agent-roster/README.md`, "Install"):

```
claude plugin marketplace add Community-Access/accessibility-agents#a538edc9edfb98cdd8bae96d6b79542874b478f7
claude plugin install accessibility-agents@community-access
```

```
/plugin install agent-roster@ai-utils
```

## Recommended skills from others

For copywriting, install Corey Haines' `marketing-skills` plugin from his own
marketplace, [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills).
agent-roster's `copy-writer` and `copy-critic` use its `copywriting` and
`copy-editing` skills.

```
claude plugin marketplace add coreyhaines31/marketingskills
claude plugin install marketing-skills@marketingskills
```

In a Claude Code session, the same is `/plugin marketplace add coreyhaines31/marketingskills`, then `/plugin install marketing-skills@marketingskills`.

## Third-party plugins

`accessibility-agents` is not ours. It comes from
[Community-Access/accessibility-agents](https://github.com/Community-Access/accessibility-agents)
and is installed from its own marketplace.

## Validation

CI (`.github/workflows/ci.yml`, job `validate`) runs `scripts/validate-plugins.py`
on every pull request and push to `main`. That one command is the whole test
gate, so the same command passes locally and in CI; see
[docs/agents/ci.md](docs/agents/ci.md). Run it yourself before pushing:

```bash
python3 scripts/validate-plugins.py
```

It catches the failures that are silent at load time: mangled skill
frontmatter, a `SKILL.md` whose `name:` drifted from its folder, a manifest
version or description out of step with its marketplace entry, a duplicate
skill name across plugins, and any `${CLAUDE_PLUGIN_ROOT}` path left dangling
by a move. It also checks that `accessibility-critic` and `implementer-ui`
list exactly the read-only `accessibility-agents` MCP tools, that every agent
that edits files can open that plugin's edit gate, that agent-roster declares
the plugin at its pinned version, that every install command adds its
marketplace at the pinned commit, and that no doc outside a changelog still
mentions the accessibility plugin it replaced. It also runs the unit tests,
the skill self-checks and the CI workflow rules
([docs/agents/ci.md](docs/agents/ci.md)).

## Using these skills in the Claude apps

The chat side of Claude has no marketplace. Skills go up one at a time as
`.skill` files — zip archives holding a single top-level folder. Build them
from the same source as the plugins:

```bash
python3 scripts/build-skill-bundles.py
```

Bundles land in `dist/`, which is not tracked. Upload them individually under
the app's skills settings.

A skill that needs a shared plugin file lists it in a `bundle-extras.txt` in
its folder (`<source> => <dest>`, relative to the skill folder), and the
bundle gets its own copy. `setup-agentic-workflow` uses this for the
reviewer agents and the coordinator prompt.

A skill that reads `${CLAUDE_PLUGIN_ROOT}` is skipped on purpose. That
variable is set only inside an installed plugin, so a standalone bundle would
load and then fail on its first shared file. Naming one explicitly is an
error rather than a silent skip.

## Adding a plugin

A plugin needs two things:

1. A folder under `plugins/` containing `.claude-plugin/plugin.json` and a
   `skills/` directory, one folder per skill.
2. An entry in `.claude-plugin/marketplace.json` pointing at that folder.

Shared files a group of skills all read belong under the plugin root in their
own folder, reached via `${CLAUDE_PLUGIN_ROOT}/<folder>/…`. That variable only resolves inside an
installed plugin, so a skill using it cannot be shipped loose.

## License

MIT, see [LICENSE](LICENSE). The vendored `thermo-nuclear-code-quality-review`
skill keeps its own MIT license from Cursor, in
[its folder](plugins/agent-roster/skills/thermo-nuclear-code-quality-review/LICENSE).

## Security

See [SECURITY.md](SECURITY.md).
