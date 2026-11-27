#!/usr/bin/env node
// Self-check for the agent hooks. Builds a throwaway repo with a linked
// worktree, copies the hooks into it, pipes sample tool calls through them
// and checks each one is refused or allowed as it should be.
//
//   node scripts/check-agent-hooks.mjs            # hooks next to this file
//   node scripts/check-agent-hooks.mjs <dir>      # hooks in <dir>
//
// Exit 0 when every case passes. Touches nothing outside a temp folder.
// No dependencies. Installed by the setup-agentic-workflow skill.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS } from "./review-gate-hook.mjs";

const FILES = { guard: "guard-main-checkout-hook.mjs", review: "review-gate-hook.mjs", shell: "agent-hook-shell.mjs" };
const source = path.resolve(process.argv[2] ?? path.dirname(fileURLToPath(import.meta.url)));

// Strip GIT_* so a run from inside a git hook cannot touch the real repo.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=check", "-c", "user.email=check@example.invalid", ...args], {
    cwd,
    env,
    stdio: "pipe",
  });

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-hooks-")));
const main = path.join(tmp, "repo");
const tree = path.join(tmp, "repo-task");
const bin = path.join(tmp, "bin");
const lone = path.join(tmp, "lone");
const named = path.join(tmp, "named");
try {
  fs.mkdirSync(path.join(main, "scripts"), { recursive: true });
  for (const file of Object.values(FILES)) fs.copyFileSync(path.join(source, file), path.join(main, "scripts", file));
  git(main, "init", "-q", "-b", "main");
  git(main, "add", "-A");
  git(main, "commit", "-qm", "init");
  git(main, "worktree", "add", "-q", tree, "-b", "task");
  // A repo whose origin is on GitHub, for the cases that name a repo.
  fs.mkdirSync(named);
  git(named, "init", "-q", "-b", "main");
  git(named, "remote", "add", "origin", "git@github.com:Owner/Name.git");

  // A review gate without its shell module, and a guard outside any repo.
  fs.mkdirSync(lone);
  fs.copyFileSync(path.join(source, FILES.review), path.join(lone, FILES.review));
  fs.mkdirSync(path.join(tmp, "nogit"));
  fs.copyFileSync(path.join(source, FILES.guard), path.join(tmp, "nogit", FILES.guard));
  fs.copyFileSync(path.join(source, FILES.shell), path.join(tmp, "nogit", FILES.shell));

  // A fake gh that answers `gh pr view <n>` with $FAKE_PR_BODY, or with
  // $FAKE_PR_BODY_<n> when that is set.
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "gh"),
    '#!/bin/sh\nb=$FAKE_PR_BODY\ncase "$3" in [0-9]*) eval "b=\\${FAKE_PR_BODY_$3:-\\$FAKE_PR_BODY}" ;; esac\nprintf "%s" "$b"\n',
    { mode: 0o755 }
  );

  // Rows come from the hook's own reviewer list; these two carry findings.
  const FOUND = { Thermonuclear: ["1", "1 fixed"], "Copy critic": ["1", "1 declined"] };
  const good = [
    "## Review",
    "",
    "Rounds: 1",
    "",
    "| Reviewer | Model | Findings | Disposition |",
    "| --- | --- | --- | --- |",
    ...Object.keys(AGENTS).map((name) => `| ${name} | ${name === "Copy critic" ? "Sonnet" : "Opus"} | ${FOUND[name]?.[0] ?? "0"} | ${FOUND[name]?.[1] ?? "none"} |`),
    "",
    "- Thermonuclear: a long function [fixed]",
    "- Copy critic: wording (it's fine) [declined: matches the existing docs]",
    "",
  ].join("\n");
  const fable = good.replace("| DRY critic | Opus |", "| DRY critic | Fable |");
  const agentNames = good.replace("| DRY critic |", "| dry-critic |");
  const missingRow = good.replace("| DRY critic | Opus | 0 | none |\n", "");
  // The old combined reviewer, before it was split into spec, security and copy.
  const oldCombined = good.replaceAll("Copy critic", "Spec/security/copy critic");
  const newAgentNames = good
    .replace("| Spec critic |", "| spec-critic |")
    .replace("| Security critic |", "| `security-critic` |")
    .replaceAll("Copy critic", "copy-critic");
  const unknownFinding = good.replace("[fixed]\n", "[fixed]\n- Securty critic: a typo in the name [fixed]\n");
  const countOff = good.replace("| Thermonuclear | Opus | 1 | 1 fixed |", "| Thermonuclear | Opus | 2 | 2 fixed |");
  const noSeparator = good.replace("| --- | --- | --- | --- |\n", "");
  // A filed finding names its ticket in whatever tool docs/agents/issue-tracker.md sets.
  const filedAs = (id) =>
    good
      .replace("| DRY critic | Opus | 0 | none |", "| DRY critic | Opus | 1 | 1 filed |")
      .replace("[fixed]\n", `[fixed]\n- DRY critic: names spelled twice [filed ${id}]\n`);
  fs.writeFileSync(path.join(tree, "good.md"), good);
  fs.writeFileSync(path.join(tree, "fable.md"), fable);

  const W = "ALLOW_MAIN_CHECKOUT_WRITE";
  const guard = (cwd, command, expect, hookDir = path.join(main, "scripts")) => ({ hook: "guard", hookDir, cwd, command, expect });
  const review = (command, expect, extra = {}) => ({ hook: "review", hookDir: path.join(tree, "scripts"), cwd: tree, command, expect, extra });
  const reviewIn = (cwd, command, expect, extra = {}) => ({ ...review(command, expect, extra), cwd });
  // In the repo whose origin is Owner/Name; the PR body has no record unless given.
  const inNamed = (command, expect, body = "no record") => reviewIn(named, command, expect, { FAKE_PR_BODY: body });
  // A PR whose body is empty, so a checked merge is refused.
  const noBody = (command, expect) => review(command, expect, { FAKE_PR_BODY: "" });
  // Refused, and the refusal says `phrase`: the record is complete, so only the form can refuse.
  const says = (c, phrase) => ({ ...c, says: phrase });
  const refuseSays = (command, phrase) => says(review(command, "refuse", { FAKE_PR_BODY: good }), phrase);
  const ASK_OWNER = "stop and ask the owner";
  // Refused as a branch, protection, ruleset or settings write, and no other way.
  const BRANCH_SAYS = "are the owner's";
  const refuseBranch = (command) => refuseSays(command, BRANCH_SAYS);
  // Asks the user first (permissionDecision "ask"), and the reason says `phrase`.
  const asks = (command, phrase = "asks you first") => says(review(command, "ask", { FAKE_PR_BODY: good }), phrase);
  const mcp = (tool, input, expect) => ({ hook: "review", hookDir: path.join(tree, "scripts"), cwd: tree, tool, input, expect });
  const fromTree = path.join(tree, "scripts");
  // The commands of "Cleanup after a merge" in the coordinator prompt, in order.
  const CLEANUP = [
    "gh pr view 5 -R o/r --json state,mergedAt,headRefName,headRefOid",
    `git -C ${tree} branch --show-current`,
    `git -C ${tree} status --porcelain`,
    `git -C ${tree} fetch --prune origin`,
    `git -C ${tree} fetch origin pull/5/head`,
    `git -C ${tree} rev-list --count abc123..HEAD`,
    `git -C ${tree} ls-remote --heads origin task`,
    `git -C ${tree} push origin --delete task`,
    `git -C ${tree} switch --detach abc123`,
    `git -C ${tree} branch -d task`,
    `git -C ${tree} worktree prune`,
    `git -C ${tree} worktree remove ${tree}`,
  ];

  const cases = [
    // The guard refuses writes in the main checkout.
    guard(main, "git commit -m x", "refuse"),
    guard(main, "bash -euo pipefail -c 'git commit -m x'", "refuse"),
    // Catching up a pushed branch merges main in; that is a tree change, so main refuses it.
    guard(main, "git fetch origin && git merge origin/main", "refuse"),
    guard(main, "git add -A && git status", "refuse"),
    guard(main, "git checkout -- README.md", "refuse"),
    guard(main, "git worktree remove ../repo-task", "refuse"),
    guard(tmp, `git -C ${main} reset --hard`, "refuse"),
    guard(tree, `git --git-dir=${main}/.git --work-tree=${tree} commit -m x`, "refuse"),
    guard(main, "git config core.hooksPath .husky", "refuse"),
    guard(main, "nice -n 5 git commit -m x", "refuse"),
    guard(main, "timeout 60 git commit -m x", "refuse"),
    guard(main, "bash -lc 'git add -A'", "refuse"),
    guard(main, "eval 'git add -A'", "refuse"),
    guard(main, "echo `git add -A`", "refuse"),
    guard(main, "cat <<< \"$p\"\ngit commit -m y", "refuse"),
    guard(main, `(cd ${tree} && git commit -m x); git commit -m y`, "refuse"),
    guard(main, `x=$(cd ${tree} && pwd); git commit -m y`, "refuse"),
    guard(main, `echo ${W}=1; git commit -m x`, "refuse"),
    guard(main, "git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\"", "refuse"),
    guard(main, "git commit -m x", "refuse", fromTree),
    guard(main, "git \\\n  commit -m x", "refuse"),
    guard(main, "git status && \\\n  git commit -m x", "refuse"),
    guard(main, "FOO=$BAR git commit -m x", "refuse"),
    guard(main, "x=$((1<<2))\ngit commit -m x", "refuse"),
    // The guard allows worktrees, reads, the escape and what it cannot know.
    guard(tree, "git commit -m x", "allow"),
    guard(tree, "git commit -m x", "allow", fromTree),
    guard(main, `cd ${tree} && git commit -m x`, "allow"),
    guard(main, `eval "cd ${tree}" && git commit -m x`, "allow"),
    guard(main, `git -C ${tree} rebase origin/main`, "allow"),
    guard(tree, "git fetch origin && git merge origin/main", "allow"),
    guard(main, `git -C ${tree} merge origin/main`, "allow"),
    guard(main, `cd ${tree} && git merge origin/main`, "allow"),
    guard(tree, `(cd ${main} && git log -1); git commit -m x`, "allow"),
    guard(tree, `git --git-dir=${main}/.git/worktrees/repo-task commit -m x`, "allow"),
    guard(main, `${W}=1 git commit -m x`, "allow"),
    guard(main, "git status && git log --oneline -5 && git diff 2>&1 | head", "allow"),
    guard(main, "git fetch origin && git worktree add ../x -b prune origin/main", "allow"),
    guard(main, "git stash list && git submodule status && git bisect log", "allow"),
    guard(main, "git config user.name && git config get user.email && git config --global x.y z", "allow"),
    guard(main, "git clean -n && git checkout", "allow"),
    guard(main, "git clean -nd && git rm -rn x && git commit --help && git reset -h", "allow"),
    guard(main, "git config --get-regexp remote url", "allow"),
    guard(main, `cd \\\n  ${tree} && git commit -m x`, "allow"),
    guard(main, `${W}=1 bash -c 'git add -A'`, "allow"),
    guard(main, "args=(git add -A); diff <(git log) x", "allow"),
    guard(main, "GIT_DIR=$X git commit -m x", "allow"),
    guard(main, "cat > notes.md <<'EOF'\ngit add -A\nEOF", "allow"),
    guard(main, "cd $SOMEWHERE && git commit -m x", "allow"),
    guard(tmp, `git -C ${main} commit -m x`, "allow", path.join(tmp, "nogit")),
    // The review gate.
    review("gh pr create --title t --body hi", "refuse"),
    review("gh pr create --draft=false --title t --body hi", "refuse"),
    review("gh pr create --draft --title t --body hi", "refuse"),
    review("gh pr create -d --draft=true --title t --body hi", "refuse"),
    review("gh pr create --draft --title t --body-file good.md", "allow"),
    review("gh pr create --draft --fill", "refuse"),
    review("gh pr new --draft --title t --body hi", "refuse"),
    review("gh pr new --title t --body-file good.md", "allow"),
    review("gh api repos/o/r/pulls -f title=t -f head=h -f base=main", "refuse"),
    review("gh api -X POST repos/o/r/pulls/ --input pr.json", "refuse"),
    review("gh api repos/o/r/pulls", "allow"),
    review("gh pr create --title t --body-file good.md", "allow"),
    review("cd .. && cd repo-task && gh pr create --title t --body-file good.md", "allow"),
    review("gh pr create --title t --body-file fable.md", "refuse"),
    review(`gh pr create --title t --body "$(cat <<'EOF'\n${good}EOF\n)"`, "allow"),
    review(`gh pr create --title t -b "$(cat <<'EOF'\n${good}EOF\n)"`, "allow"),
    review(`gh pr create --title t --body "$(cat <<EOF\n${good}EOF\n)"`, "refuse"),
    review("gh pr merge 5 --squash --match-head-commit abc123", "allow", { FAKE_PR_BODY: good }),
    review("gh pr merge 5 --squash --match-head-commit abc123", "refuse", { FAKE_PR_BODY: "no record" }),
    review("gh pr merge 5 --rebase 2>&1", "refuse", { FAKE_PR_BODY: "no record", FAKE_PR_BODY_2: good }),
    review("gh pr ready 5", "refuse", { FAKE_PR_BODY: fable }),
    review("gh pr merge -r 7", "refuse", { FAKE_PR_BODY: good, FAKE_PR_BODY_7: "no record" }),
    review("gh pr -R o/r merge 7", "refuse", { FAKE_PR_BODY: good, FAKE_PR_BODY_7: "no record" }),
    review("gh \\\n  pr merge 7", "refuse", { FAKE_PR_BODY: good, FAKE_PR_BODY_7: "no record" }),
    review("git fetch && \\\n  gh pr merge 5 --rebase", "allow", { FAKE_PR_BODY: good }),
    review("GH_TOKEN=$(cat tok) gh pr merge 5 --rebase", "allow", { FAKE_PR_BODY: good }),
    review("gh api -X PUT repos/o/r/pulls/$N/merge", "refuse"),
    review("gh pr ready 5", "allow", { FAKE_PR_BODY: agentNames }),
    review("gh pr ready 5", "refuse", { FAKE_PR_BODY: missingRow }),
    review("gh pr ready 5", "refuse", { FAKE_PR_BODY: oldCombined }),
    review("gh pr ready 5", "allow", { FAKE_PR_BODY: newAgentNames }),
    review("gh pr ready 5", "refuse", { FAKE_PR_BODY: unknownFinding }),
    review("gh pr ready 5", "refuse", { FAKE_PR_BODY: countOff }),
    review("gh pr ready 5", "refuse", { FAKE_PR_BODY: good.replace("Rounds: 1\n", "") }),
    review("gh pr ready 5", "refuse", { FAKE_PR_BODY: good.replace("Rounds: 1", "Rounds: 3") }),
    review("gh pr ready 5", "allow", { FAKE_PR_BODY: good.replace("Rounds: 1", "Rounds: 3\nOwner allowed round 3: in chat on 2026-11-18") }),
    review("gh pr ready 5", "allow", { FAKE_PR_BODY: good.replace("Rounds: 1", "Rounds: 2") }),
    review("gh pr ready 5", "refuse", { FAKE_PR_BODY: good.replace("Rounds: 1", "Rounds: 4\nOwner allowed round 3: in chat") }),
    review("gh pr ready 5", "refuse", { FAKE_PR_BODY: good.replace("Rounds: 1", "Rounds: 1\nRounds: 7") }),
    review("gh pr ready 5", "refuse", { FAKE_PR_BODY: good.replace("Rounds: 1", "Rounds: 0") }),
    review("gh pr ready 5", "allow", { FAKE_PR_BODY: good.replace("Rounds: 1", "**Rounds:** 1") }),
    // Round 2: the table totals both rounds, and the finding lines list both.
    review("gh pr ready 5", "allow", {
      FAKE_PR_BODY: good
        .replace("Rounds: 1", "Rounds: 2")
        .replace("| Thermonuclear | Opus | 1 | 1 fixed |", "| Thermonuclear | Opus | 2 | 2 fixed |")
        .replace("- Thermonuclear: a long function [fixed]", "- Thermonuclear: a long function [fixed]\n- Thermonuclear: round 2, a stale comment [fixed]"),
    }),
    review("gh pr ready 5", "refuse", { FAKE_PR_BODY: noSeparator }),
    // Filed findings: a GitHub issue or a ticket ID from another tool, never no ID.
    review("gh pr ready 5", "allow", { FAKE_PR_BODY: filedAs("#123") }),
    review("gh pr ready 5", "allow", { FAKE_PR_BODY: filedAs("PROJ-42") }),
    review("gh pr ready 5", "allow", { FAKE_PR_BODY: filedAs("ENG-7") }),
    review("gh pr ready 5", "refuse", { FAKE_PR_BODY: filedAs("later") }),
    review("gh pr ready 5", "refuse", { FAKE_PR_BODY: filedAs("") }),
    review("gh pr ready 5", "refuse", { FAKE_PR_BODY: filedAs("#12 and #13") }),
    review("gh pr ready 5", "refuse", { FAKE_PR_BODY: filedAs("#12,#13") }),
    review("gh pr ready 5", "refuse", { FAKE_PR_BODY: filedAs("#12/#13") }),
    review("gh pr ready 5", "refuse", { FAKE_PR_BODY: filedAs("#12;#13") }),
    review("gh pr ready 5", "refuse", { FAKE_PR_BODY: filedAs("#12&#13") }),
    review("gh pr ready 5", "refuse", { FAKE_PR_BODY: "```\n" + good + "```\n" }),
    review("gh pr ready 5 --undo", "allow"),
    noBody("gh api -X PUT repos/o/r/pulls/5/merge", "refuse"),
    review("gh api repos/o/r/pulls/5/merge", "allow"),
    // GraphQL the gate cannot read: a query from a file, stdin or a variable.
    review("gh api graphql -F query=@merge.graphql", "refuse"),
    review("gh api graphql -Fquery=@merge.graphql", "refuse"),
    review("gh api graphql --field=query=@merge.graphql", "refuse"),
    review("gh api graphql --input q.json", "refuse"),
    review("gh api graphql --input=- < q.json", "refuse"),
    review("gh api graphql -f query=\"$Q\"", "refuse"),
    review("gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'", "refuse"),
    review("gh api graphql -f query='query { viewer { login } }'", "allow"),
    review("gh api graphql -F owner=o -F n=5 -f query='query($owner: String!) { viewer { login } }'", "allow"),
    review("gh api graphql -F body=@notes.md -f query='query { viewer { login } }'", "allow"),
    review("gh api graphql -F query=@-", "refuse"),
    review("gh api graphql --field query=@merge.graphql", "refuse"),
    review("gh api graphql --input=q.json", "refuse"),
    review("gh api graphql -f query=\"$(cat q.graphql)\"", "refuse"),
    review("gh api graphql -f query=$(cat q.graphql)", "refuse"),
    review("gh api graphql -f query=\"`cat q.graphql`\"", "refuse"),
    review("gh api graphql -f query=`cat q.graphql`", "refuse"),
    review("gh api graphql --raw-field \"query=$(cat q.graphql)\"", "refuse"),
    review("gh api graphql -f query=\"$(cat <<'EOF'\nquery { viewer { login } }\nEOF\n)\"", "allow"),
    // curl: PR merges and opens, and GitHub GraphQL, are refused; reads pass.
    review("curl -X PUT -H \"Authorization: Bearer $T\" https://api.github.com/repos/o/r/pulls/5/merge", "refuse"),
    review("curl -sXPUT https://api.github.com/repos/o/r/pulls/5/merge", "refuse"),
    review("curl --request PUT \"$API/repos/o/r/pulls/5/merge\"", "refuse"),
    review("curl -d '{\"merge_method\":\"rebase\"}' https://api.github.com/repos/o/r/pulls/5/merge", "refuse"),
    review("curl https://api.github.com/repos/o/r/pulls --data @body.json", "refuse"),
    review("curl -d @q.json https://api.github.com/graphql", "refuse"),
    review("curl --json @- https://github.example.com/api/graphql < q.json", "refuse"),
    review("timeout 30 curl -X PUT https://api.github.com/repos/o/r/pulls/5/merge?x=1", "refuse"),
    review("curl -s -H \"Authorization: Bearer $T\" https://api.github.com/repos/o/r/pulls/5/merge", "allow"),
    review("curl -sI https://api.github.com/repos/o/r/pulls/5/merge", "allow"),
    review("curl -sL https://api.github.com/repos/o/r/pulls?state=open | head", "allow"),
    review("curl -X GET https://api.github.com/repos/o/r/pulls/5/merge", "allow"),
    review("curl -d @q.json https://api.example.com/graphql", "allow"),
    noBody("bash -lc 'gh pr merge 5'", "refuse"),
    // eval and sh -c: a literal script is read like any command; one built at
    // run time, or read from stdin, is refused when the line names a PR write.
    noBody("eval gh pr merge 5", "refuse"),
    noBody("eval \"gh pr merge 5\"", "refuse"),
    noBody("eval 'gh pr merge 5'", "refuse"),
    noBody("eval 'gh pr' merge 5", "refuse"),
    review("eval \"gh pr merge $N\"", "refuse"),
    review("X='gh pr merge 5'; eval \"$X\"", "refuse"),
    review("eval \"gh api -X PUT repos/o/r/pulls/$N/merge\"", "refuse"),
    noBody("bash -c \"gh pr merge 5\"", "refuse"),
    noBody("sh -c 'gh pr merge 5'", "refuse"),
    noBody("zsh -c \"gh pr merge 5\"", "refuse"),
    review("bash -c \"gh pr merge $N\"", "refuse"),
    review("echo 'gh pr merge 5' | bash", "refuse"),
    review("bash <<< 'gh pr merge 5'", "refuse"),
    review("sh -s <<'EOF'\ngh pr merge 5\nEOF", "refuse"),
    review("eval \"gh pr merge 5\"", "allow", { FAKE_PR_BODY: good }),
    review("eval \"echo hi\"", "allow"),
    review("eval \"$(ssh-agent -s)\" && gh pr view 5", "allow"),
    review("bash -c \"echo $HOME\"", "allow"),
    review("bash -c \"gh pr view $N\"", "allow"),
    review("bash build.sh && gh pr merge 5", "allow", { FAKE_PR_BODY: good }),
    // -R and --repo: every spelling of origin (Owner/Name) is checked; another repo is not held.
    inNamed("gh pr merge 5", "refuse"),
    inNamed("gh pr merge 5 -R Owner/Name", "refuse"),
    inNamed("gh pr merge 5 -R owner/name.git", "refuse"),
    inNamed("gh pr merge 5 --repo OWNER/NAME.git/", "refuse"),
    inNamed("gh pr merge 5 --repo=owner/name/", "refuse"),
    inNamed("gh pr merge 5 -R github.com/owner/name", "refuse"),
    inNamed("gh pr merge 5 -R https://github.com/Owner/Name", "refuse"),
    inNamed("gh pr merge 5 -R git@github.com:owner/name.git", "refuse"),
    inNamed("gh pr merge 5 -R ssh://git@github.com/owner/name.git", "refuse"),
    inNamed("gh api -X PUT repos/owner/Name.git/pulls/5/merge", "refuse"),
    inNamed("gh pr merge 5 -R ghe.example.com/other/repo", "refuse"),
    inNamed("gh pr merge 5 -R Owner/Name", "allow", good),
    inNamed("gh pr merge 5 -R other-owner/other-repo", "allow"),
    inNamed("gh pr merge 5 -R owner/name-fork.git", "allow"),
    inNamed("gh pr merge 5 --repo https://github.com/other-owner/name", "allow"),
    // Review gate round 1 (1.10.0): forms reviewers found getting past the gate.
    review("curl -X POST https://api.github.com/repos/o/r/pulls -d @body.json", "refuse"),
    review("curl --json '{\"title\":\"t\"}' https://api.github.com/repos/o/r/pulls", "refuse"),
    review("curl --expand-data '{}' https://api.github.com/repos/o/r/pulls", "refuse"),
    review("echo 'curl -X POST -d @b.json https://api.github.com/repos/o/r/pulls' | bash", "refuse"),
    review("curl -X GET -X PUT https://api.github.com/repos/o/r/pulls/5/merge", "refuse"),
    review("curl https://x.example -X GET --next -X PUT https://api.github.com/repos/o/r/pulls/5/merge", "refuse"),
    review("curl -X PUT https://api.github.com/repos/o/r/pull{s}/5/merge", "refuse"),
    review("curl -X PUT 'https://api.github.com/repos/o/r/pulls/5/merg[e-e]'", "refuse"),
    review("curl -X PUT https://api.github.com/repos/o/r/pulls/5/merg%65", "refuse"),
    review("curl -X PUT https://api.github.com/repos/o/r/pulls/5/x/../merge", "refuse"),
    review("U=https://api.github.com/repos/o/r/pulls/5/merge; curl -X PUT \"$U\"", "refuse"),
    review("curl -d @q.json https://api.github.com/graph{q}l", "refuse"),
    review("G=https://api.github.com/graphql; curl -d @q.json \"$G\"", "refuse"),
    review("curl -X POST https://api.github.com/repos/o/r/merges -d @m.json", "refuse"),
    review("wget --method=PUT https://api.github.com/repos/o/r/pulls/5/merge", "refuse"),
    review("http PUT https://api.github.com/repos/o/r/pulls/5/merge", "refuse"),
    review("xh POST https://api.github.com/repos/o/r/pulls title=t", "refuse"),
    review("curl -XGET https://api.github.com/repos/o/r/pulls/5/merge", "allow"),
    review("curl -G -d state=open https://api.github.com/repos/o/r/pulls", "allow"),
    review("curl -X POST \"$WEBHOOK\" -d @payload.json", "allow"),
    review("http GET https://api.github.com/repos/o/r/pulls/5/merge", "allow"),
    review("echo 'gh pr merge 5' | bash -s -- x", "refuse"),
    review("echo 'gh pr merge 5' | bash -o pipefail", "refuse"),
    review("bash /dev/stdin <<< 'gh pr merge 5'", "refuse"),
    review("source /dev/stdin <<< 'gh pr merge 5'", "refuse"),
    review("bash <(echo 'gh pr merge 5')", "refuse"),
    review(". <(echo 'gh pr merge 5')", "refuse"),
    noBody("busybox sh -c 'gh pr merge 5'", "refuse"),
    noBody("fish -c 'gh pr merge 5'", "refuse"),
    review("sh -c '\"$@\"' _ gh pr merge 5", "refuse"),
    review("echo 5 | xargs -I{} sh -c 'gh pr merge {}'", "refuse"),
    review("printf 'pr merge 5' | xargs gh", "refuse"),
    review("$(echo gh pr merge 5)", "refuse"),
    review("X='gh pr \"merge\" 5'; eval \"$X\"", "refuse"),
    review("P=pr; eval \"gh $P merge 5\"", "refuse"),
    review("python3 -c \"import os; os.system('gh pr merge 5')\"", "refuse"),
    review("alias m='gh pr merge 5'", "refuse"),
    review("gh pr $'merge' 5", "refuse"),
    review("A=merge; gh pr $A 5", "refuse"),
    review("gh $'pr' merge 5", "refuse"),
    review("gh pr {merge,} 5", "refuse"),
    review("E=graphql; gh api \"$E\" -F query=@m.gql", "refuse"),
    review("gh api graphql/ -F query=@m.gql", "refuse"),
    review("gh api -X GET -X PUT repos/o/r/pulls/5/merge", "refuse"),
    review("gh api -X PUT 'repos/o/r/pulls/5/merge?x=1'", "refuse"),
    review("gh api -X POST repos/o/r/merges -f base=main -f head=x", "refuse"),
    review("gh api graphql -F 'items[]=a' -f query='query { viewer { login } }'", "allow"),
    review("gh api repos/{owner}/{repo}/pulls", "allow"),
    review("gh api repos/o/r/issues -f title=\"$T\"", "allow"),
    review("gh issue create --title 'pr merge is broken' --body x", "allow"),
    review("eval \"$(ssh-agent -s)\" && gh pr merge 5", "allow", { FAKE_PR_BODY: good }),
    review("eval \"$(ssh-agent -s)\" && gh pr create --body-file good.md", "allow"),
    review("eval \"$(ssh-agent -s)\"; gh api repos/o/r/pulls/5/comments", "allow"),
    review("eval \"$(fnm env)\" && pnpm graphql:codegen", "allow"),
    review("curl -fsSL https://example.com/install.sh | bash && git log -- docs/graphql.md", "allow"),
    review("bash build.sh", "allow"),
    review(`gh pr view ${"a".repeat(30000)}`, "refuse"),
    inNamed("gh pr merge 5 -R other/repo --repo Owner/Name", "refuse"),
    inNamed("gh pr merge https://github.com/Owner/Name/pull/5 -R other/repo", "refuse"),
    inNamed("GH_REPO=$R gh pr merge 5", "refuse"),
    inNamed("gh pr merge 5 -R Owner/Name --repo other/repo", "allow"),
    inNamed("gh pr merge https://github.com/other/repo/pull/5 -R Owner/Name", "allow"),
    inNamed("GH_REPO=other/repo gh pr merge 5", "allow"),
    inNamed("gh pr merge 5 -R https://github.com/owner/name.git", "allow", good),
    // Review gate round 2 (1.10.0).
    review("X='gh pr -R o/r merge 5'; eval \"$X\"", "refuse"),
    review("echo 'gh pr -R o/r merge 5' | sh", "refuse"),
    review("bash <<'E'\ngh pr -R o/r merge 5\nE", "refuse"),
    review("python3 -c 'import os; os.system(\"gh pr --repo=o/r ready 5\")'", "refuse"),
    review("gh issue list -S pr$(true) merge; X='gh pr merge 5'; eval \"$X\"", "refuse"),
    review("gh issue list -S pr >/dev/null merge; X='gh pr merge 5'; eval \"$X\"", "refuse"),
    review("gh pr list --json number -q '\"gh pr merge 5\"' | sh", "refuse"),
    review("gh api user --jq '\"gh pr merge 5\"' | bash", "refuse"),
    review("X='curl -X PUT https://api.github.com/repos/o/r/pull%73/5/merge'; eval \"$X\"", "refuse"),
    review("http -a u:p PUT https://api.github.com/repos/o/r/pulls/5/merge", "refuse"),
    review("http -a u:p POST https://api.github.com/graphql query=@q.graphql", "refuse"),
    review("curl -X PUT --expand-url https://api.github.com/repos/o/r/pulls/5/merge", "refuse"),
    review("curl --variable p=x -X PUT --expand-url 'https://api.github.com/repos/o/r/{{p}}'", "refuse"),
    review("env -S 'gh pr merge 5'", "refuse"),
    review("env -S'gh pr merge 5'", "refuse"),
    review("env --split-string='gh pr merge 5'", "refuse"),
    review("gh pr create -b -h", "refuse"),
    noBody("bash -euo pipefail -c 'gh pr merge 5'", "refuse"),
    review("bash -euo pipefail -c 'gh pr create --body-file good.md'", "allow"),
    review("curl -X POST \"$SLACK_WEBHOOK\" -d '{\"text\":\"PR 12 is up on github\"}'", "allow"),
    review("http api.github.com/repos/o/r/pulls state==open", "allow"),
    review(`cat > notes.md <<'EOF'\n${"See the github docs. ".repeat(1500)}\nEOF`, "allow"),
    noBody("timeout 60 gh pr merge 5", "refuse"),
    review("echo 5 | xargs gh pr merge", "refuse"),
    review("$GH pr merge 5", "refuse"),
    review("gh pr view 5 && gh pr list", "allow"),
    review("git commit -m 'merge ready create'", "allow"),
    review("echo gh pr merge 5", "allow"),
    review("gh pr merge --help", "allow"),
    // --admin (1.16.0): never bypass branch protection, in any spelling or wrapper, in any repo.
    refuseSays("gh pr merge 5 --admin", ASK_OWNER),
    refuseSays("gh pr merge --admin 5", ASK_OWNER),
    refuseSays("gh pr merge 5 --squash --admin --match-head-commit abc123", ASK_OWNER),
    refuseSays("gh pr merge 5 --admin=true", ASK_OWNER),
    refuseSays("gh pr merge 5 --admin=1", ASK_OWNER),
    refuseSays("gh pr merge 5 --admin=false", ASK_OWNER),
    refuseSays("gh pr merge 5 --admin=$X", ASK_OWNER),
    refuseSays("gh pr --repo o/r merge --admin 5", ASK_OWNER),
    refuseSays("gh pr merge 5 -sd --admin", ASK_OWNER),
    refuseSays("timeout 60 gh pr merge 5 --admin", ASK_OWNER),
    refuseSays("git fetch && \\\n  gh pr merge 5 --rebase --admin", ASK_OWNER),
    refuseSays("eval 'gh pr merge 5 --admin'", ASK_OWNER),
    refuseSays("eval \"gh pr merge 5 --admin\"", ASK_OWNER),
    refuseSays("bash -c 'gh pr merge 5 --admin'", ASK_OWNER),
    refuseSays("sh -euo pipefail -c 'gh pr merge 5 --squash --admin'", ASK_OWNER),
    refuseSays("echo 'gh pr merge 5 --admin' | bash", ASK_OWNER),
    refuseSays("bash <<< 'gh pr merge 5 --admin'", ASK_OWNER),
    refuseSays("X='gh pr merge 5 --admin'; eval \"$X\"", ASK_OWNER),
    refuseSays("python3 -c \"import os; os.system('gh pr merge 5 --admin')\"", ASK_OWNER),
    refuseSays("alias m='gh pr merge 5 --admin'", ASK_OWNER),
    says(inNamed("gh pr merge 5 -R other/repo --admin", "refuse"), ASK_OWNER),
    says(inNamed("gh pr merge https://github.com/other/repo/pull/5 --admin", "refuse"), ASK_OWNER),
    // A merge word the gate cannot read may be --admin.
    refuseSays("gh pr merge 5 $FLAGS", "--admin"),
    refuseSays("gh pr merge 5 --squash \"$F\"", "--admin"),
    says(inNamed("gh pr merge 5 -R other/repo \"$F\"", "refuse"), "--admin"),
    // A REST merge skips gh's branch protection check, so it is refused like --admin.
    refuseSays("gh api -X PUT repos/o/r/pulls/5/merge", ASK_OWNER),
    refuseSays("gh api --method=PUT repos/o/r/pulls/5/merge -f merge_method=squash", ASK_OWNER),
    says(inNamed("gh api -X PUT repos/other/repo/pulls/5/merge", "refuse"), ASK_OWNER),
    refuseSays("curl -X PUT https://api.github.com/repos/o/r/pulls/5/merge", ASK_OWNER),
    // gh finds its subcommand and action past flags, so a flag first must not hide the merge.
    refuseSays("gh --admin=true pr merge 5", "flags come before the subcommand"),
    refuseSays("gh -R o/r pr merge 5 --admin", "flags come before the subcommand"),
    refuseSays("gh --repo=o/r pr merge 5 --admin", "flags come before the subcommand"),
    refuseSays("gh -X PUT api repos/o/r/pulls/5/merge", "flags come before the subcommand"),
    refuseSays("gh -f merge_method=squash api repos/o/r/pulls/5/merge", "flags come before the subcommand"),
    refuseSays("gh pr --body x merge 5 --admin", "right after `gh pr`"),
    refuseSays("gh pr -t x merge 5 --admin", "right after `gh pr`"),
    // An unquoted run-time flag value splits into words, so it may carry --admin.
    refuseSays("gh pr merge 5 --body $B", "--admin"),
    refuseSays("gh pr merge 5 -t $(echo x) --squash", "--admin"),
    refuseSays("gh pr merge 5 --match-head-commit $S", "--admin"),
    refuseSays("gh pr -R $R", "--admin"),
    // python's list form names the merge too.
    refuseSays("python3 -c \"import subprocess; subprocess.run(['gh','pr','merge','5','--admin'])\"", ASK_OWNER),
    refuseSays("python3 -c \"import subprocess; subprocess.run(['gh', 'pr', 'merge', '5'])\"", "another program"),
    // An unreadable step plus a commit message that names --admin gets the way out, not an --admin accusation.
    refuseSays("eval \"$(ssh-agent -s)\"; git commit -m 'refuse gh pr merge --admin'", "in its own Bash call"),
    refuseSays("X=pr; gh -R o/r $X merge 5 --admin", "flags come before the subcommand"),
    refuseSays("gh -R o/r \"$X\" merge 5 --admin", "flags come before the subcommand"),
    refuseSays("gh pr -t x $A 5 --admin", "right after `gh pr`"),
    refuseSays("gh pr -t x \"$A\" 5 --admin", "right after `gh pr`"),
    refuseSays("gh pr merge 5 --body \"$@\"", "--admin"),
    refuseSays("gh pr merge 5 -t \"${a[@]}\"", "--admin"),
    refuseSays("gh api -iXPUT repos/o/r/pulls/5/merge", ASK_OWNER),
    refuseSays("gh api -iX PUT repos/o/r/pulls/5/merge", ASK_OWNER),
    refuseSays("gh api -if merge_method=squash repos/o/r/pulls/5/merge -X PUT", ASK_OWNER),
    refuseSays("gh api -iH a:b repos/o/r/pulls/5/merge -X PUT", ASK_OWNER),
    refuseSays("gh api repos/o/r/pulls/5/merge $X", "gh api call"),
    refuseSays("gh api $E", "gh api call"),
    refuseSays("gh api repos/o/r/pulls/5/merge -H $H", "gh api call"),
    review("gh pr merge 5 -t \"$*\" --squash", "allow", { FAKE_PR_BODY: good }),
    review("gh -R o/r issue list --label pr", "allow"),
    refuseSays("gh api -X=PUT repos/o/r/pulls/5/merge", ASK_OWNER),
    refuseSays("gh api -iX=PUT repos/o/r/pulls/5/merge", ASK_OWNER),
    refuseSays("gh api -f=merge_method=squash repos/o/r/pulls/5/merge", ASK_OWNER),
    refuseSays("gh api -F=merge_method=squash repos/o/r/pulls/5/merge", ASK_OWNER),
    review("gh api -X=POST repos/o/r/merges", "refuse"),
    review("gh api graphql -F=query=@q.graphql", "refuse"),
    refuseSays("gh api \"$E\" repos/o/r/pulls/5/merge", "gh api call"),
    refuseSays("gh api repos/o/r/pulls/5/merge --header=$H", "gh api call"),
    refuseSays("Y='x --admin'; gh pr merge 5 --squash -t \"${=Y}\"", "--admin"),
    refuseSays("gh pr merge 5 -t \"${(f)X}\"", "--admin"),
    refuseSays("gh pr merge 5 -t \"$a[@]\"", "--admin"),
    review("gh api -H\"$H\" repos/o/r", "allow"),
    review("gh -R \"$REPO\" issue list", "allow"),
    review("gh api \"repos/o/r/pulls/$N\"", "allow"),
    review("gh api repos/o/r/pulls/$N", "refuse"),
    // 1.17.0: a GitHub API write that moves, deletes or renames a branch, commits to it
    // directly, or changes branch protection or rulesets is refused, in any repo.
    refuseBranch("gh api -X DELETE repos/o/r/git/refs/heads/main"),
    refuseBranch("gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc -F force=true"),
    refuseBranch("gh api repos/o/r/git/refs -f ref=refs/heads/x -f sha=abc"),
    refuseBranch("gh api --method DELETE /repos/o/r/git/refs/heads/feature/x"),
    refuseBranch("gh api -XDELETE 'repos/{owner}/{repo}/git/refs/heads/main'"),
    refuseBranch("gh api -X delete https://api.github.com/repos/o/r/git/refs/heads/main"),
    refuseBranch("gh api -X DELETE repos/o/r/git%2Frefs/heads%2Fmain"),
    refuseBranch("gh api -X DELETE repos/o/r/branches/main/protection"),
    refuseBranch("gh api -X PUT repos/o/r/branches/main/protection --input p.json"),
    refuseBranch("gh api -X DELETE repos/o/r/branches/main/protection/enforce_admins"),
    refuseBranch("gh api -X PATCH repos/o/r/branches/main/protection/required_status_checks -F strict=false"),
    refuseBranch("gh api -X DELETE repos/o/r/branches/release/1.0/protection/required_pull_request_reviews"),
    refuseBranch("gh api -X PUT repos/o/r/x/../branches/main/protection/"),
    refuseBranch("gh api repos/o/r/branches/main/rename -f new_name=old"),
    refuseBranch("gh api -X DELETE repos/o/r/rulesets/42"),
    refuseBranch("gh api -X PUT repos/o/r/rulesets/42 --input r.json"),
    refuseBranch("gh api repos/o/r/rulesets -f name=x"),
    refuseBranch("gh api -X DELETE orgs/o/rulesets/42"),
    refuseBranch("gh api -X PUT repos/o/r/contents/README.md -f message=x -f content=eA== -f branch=main"),
    refuseBranch("gh api -X DELETE repos/o/r/contents/README.md -f message=x -f sha=abc"),
    refuseBranch("gh api repos/o/r/merge-upstream -f branch=main"),
    refuseBranch("gh api graphql -f query='mutation { deleteRef(input: {refId: \"x\"}) { clientMutationId } }'"),
    refuseBranch("gh api graphql -f query='mutation { updateRef(input: {refId: \"x\", oid: \"y\", force: true}) { clientMutationId } }'"),
    refuseBranch("gh api graphql -f query='mutation { deleteBranchProtectionRule(input: {branchProtectionRuleId: \"x\"}) { clientMutationId } }'"),
    refuseBranch("gh api graphql -f query='mutation { updateRepositoryRuleset(input: {repositoryRulesetId: \"x\", enforcement: DISABLED}) { clientMutationId } }'"),
    refuseBranch("gh api graphql -f query='mutation { createCommitOnBranch(input: {}) { clientMutationId } }'"),
    says(inNamed("gh api -X DELETE repos/other/repo/git/refs/heads/main", "refuse"), BRANCH_SAYS),
    refuseBranch("bash -c 'gh api -X DELETE repos/o/r/branches/main/protection'"),
    refuseBranch("eval 'gh api -X DELETE repos/o/r/git/refs/heads/main'"),
    refuseBranch("timeout 30 gh api -X DELETE repos/o/r/rulesets/42"),
    review("X='gh api -X DELETE repos/o/r/git/refs/heads/main'; eval \"$X\"", "refuse"),
    review("X='gh api -X DELETE repos/o/r/branches/main/protection'; eval \"$X\"", "refuse"),
    review("python3 -c \"import os; os.system('gh api -X DELETE repos/o/r/rulesets/42')\"", "refuse"),
    refuseBranch("curl -X DELETE https://api.github.com/repos/o/r/git/refs/heads/main"),
    refuseBranch("curl -X PUT -d @p.json https://api.github.com/repos/o/r/branches/main/protection"),
    refuseBranch("curl -sXDELETE https://api.github.com/repos/o/r/branches/main/protection/enforce_admins"),
    refuseBranch("curl -d '{\"sha\":\"abc\"}' https://api.github.com/repos/o/r/git/refs"),
    refuseBranch("wget --method=DELETE https://api.github.com/repos/o/r/rulesets/42"),
    refuseBranch("http DELETE https://api.github.com/repos/o/r/git/refs/heads/main"),
    refuseBranch("xh PATCH https://api.github.com/repos/o/r/git/refs/heads/main sha=abc"),
    // A write to the repo itself (default branch, settings) is refused too.
    refuseBranch("gh api -X PATCH repos/o/r -f default_branch=x"),
    refuseBranch("gh api repos/o/r -f default_branch=x"),
    refuseBranch("gh api repos/o/r -F archived=true"),
    refuseBranch("gh api --method=PATCH /repos/o/r --input s.json"),
    refuseBranch("gh api -XPATCH 'repos/{owner}/{repo}' -f default_branch=x"),
    refuseBranch("gh api -X patch https://api.github.com/repos/o/r -f default_branch=x"),
    refuseBranch("gh api -X PATCH repos/o/r/ -f default_branch=x"),
    refuseBranch("gh api -X PATCH repos%2Fo%2Fr -f default_branch=x"),
    refuseBranch("gh api -X PATCH REPOS/O/R -f default_branch=x"),
    refuseBranch("gh api -X PATCH repos/o/r/issues/.. -f default_branch=x"),
    refuseBranch("gh api -X DELETE repos/o/r"),
    refuseBranch("gh api -X PATCH repositories/123 -f default_branch=x"),
    refuseBranch("gh api graphql -f query='mutation { updateRepository(input: {repositoryId: \"x\"}) { clientMutationId } }'"),
    says(inNamed("gh api -X PATCH repos/other/repo -f default_branch=x", "refuse"), BRANCH_SAYS),
    refuseBranch("bash -c 'gh api -X PATCH repos/o/r -f default_branch=x'"),
    review("X='gh api -X PATCH repos/o/r -f default_branch=x'; eval \"$X\"", "refuse"),
    refuseBranch("curl -X PATCH -d '{\"default_branch\":\"x\"}' https://api.github.com/repos/o/r"),
    refuseBranch("curl -d '{\"default_branch\":\"x\"}' https://api.github.com/repos/o/r/"),
    refuseBranch("wget --method=PATCH --body-data='{}' https://api.github.com/repos/o/r"),
    refuseBranch("http PATCH https://api.github.com/repos/o/r default_branch=x"),
    refuseBranch("xh https://api.github.com/repos/o/r default_branch=x"),
    review("gh api repos/o/r", "allow"),
    review("gh api -X GET repos/o/r --jq .default_branch", "allow"),
    review("gh api -X HEAD repos/o/r", "allow"),
    review("curl -s https://api.github.com/repos/o/r", "allow"),
    review("http GET https://api.github.com/repos/o/r", "allow"),
    review("gh api repos/o/r/issues -f title=x", "allow"),
    review("gh api -X PATCH repos/o/r/issues/5 -f state=closed", "allow"),
    review("gh api repos/o/r/labels -f name=bug", "allow"),
    review("gh api repos/o/r/issues/5/comments -f body=x", "allow"),
    review("curl -X POST -d '{}' https://api.github.com/repos/o/r/issues", "allow"),
    refuseBranch("gh api graphql -f query='mutation { archiveRepository(input: {repositoryId: \"x\"}) { clientMutationId } }'"),
    refuseBranch("gh api graphql -f query='mutation { unarchiveRepository(input: {repositoryId: \"x\"}) { clientMutationId } }'"),
    refuseBranch("gh api -X POST repos/o/r/transfer -f new_owner=x"),
    refuseBranch("curl -X POST -d '{}' https://api.github.com/repos/o/r/transfer"),
    review("X='gh api -X PATCH repositories/$ID -f default_branch=x'; eval \"$X\"", "refuse"),
    review("gh api -X HEAD \"repos/o/r/$P\"", "allow"),
    refuseBranch("gh api -X PUT repos/o/r/actions/permissions/workflow -F can_approve_pull_request_reviews=true"),
    review("node -e 'fetch(`https://api.github.com/repos/o/r/git/refs/heads/main`,{method:\"DELETE\"})'", "refuse"),
    review("node -e 'go({url:\"https://api.github.com/repos/o/r/git/refs/heads/main\",method:\"PATCH\"})'", "refuse"),
    review("python3 -c 'import subprocess as s; g=\"gh\"; s.run([g,\"api\",\"-X\",\"DELETE\",\"repos/o/r/git/refs/heads/main\"])'", "refuse"),
    review("X='gh api -X PATCH repos/{owner}/{repo} -f default_branch=x'; eval \"$X\"", "refuse"),
    review("rg repos/o/r/rulesets src/", "allow"),
    review("gh api -X GET search/code -f q=createRef", "allow"),
    // Local paths that look like API paths are not branch writes.
    review("ls .github/rulesets", "allow"),
    review("cp a .github/rulesets/", "allow"),
    review("mkdir -p github/rename", "allow"),
    review("npm test -- tests/protection # gh", "allow"),
    review("npm test -- src/rename && gh pr view", "allow"),
    review("mv lib/protection lib/guard && gh pr list", "allow"),
    review("node build.js repos/a/b && gh issue list", "allow"),
    review("cp -r docs/repos/a/b out/ && gh pr view", "allow"),
    review("gh pr checkout 5 && npm run build -- --base repos/x/y", "allow"),
    review("eval \"$(ssh-agent -s)\" && gh pr view 5 && git mv src/rename src/x", "allow"),
    review("python3 -c 'subprocess.run([\"gh\",\"api\",\"-X\",\"PATCH\",\"repos/o/r\"])'", "refuse"),
    review("python3 -c \"subprocess.run(['gh', 'api', '-X', 'PATCH', 'repos/o/r'])\"", "refuse"),
    refuseSays("echo -X PATCH | xargs gh api repos/o/r", "xargs builds"),
    refuseSays("echo repos/o/r | xargs gh api -X PATCH", "xargs builds"),
    refuseSays("echo merge 5 | xargs gh pr", "xargs builds"),
    review("echo 5 | xargs gh pr view", "allow"),
    // gh repo commands that change or remove the repository ask the user first.
    asks("gh repo edit --default-branch dev"),
    asks("gh repo edit o/r --visibility public --accept-visibility-change-consequences"),
    asks("gh repo edit --enable-auto-merge"),
    asks("gh repo rename new-name --yes"),
    asks("gh repo rename -R o/r new-name --yes"),
    asks("gh repo delete o/r --yes"),
    asks("gh repo archive o/r -y"),
    asks("gh repo unarchive o/r -y"),
    asks("gh -R o/r repo delete --yes"),
    asks("gh --repo=o/r repo edit --default-branch dev"),
    asks("gh repo \"delete\" o/r --yes"),
    asks("gh repo $A o/r --yes"),
    asks("bash -c 'gh repo delete o/r --yes'"),
    asks("eval 'gh repo archive o/r -y'"),
    asks("timeout 30 gh repo delete o/r --yes"),
    asks("env GH_REPO=o/r gh repo rename x --yes"),
    asks("echo o/r | xargs gh repo delete --yes"),
    asks("git fetch && gh repo edit --default-branch dev"),
    asks("X='gh repo delete o/r --yes'; eval \"$X\"", "cannot read"),
    asks("python3 -c \"import os; os.system('gh repo delete o/r --yes')\"", "cannot read"),
    asks("gh repo --description x edit o/r --visibility public", "a flag comes before it"),
    asks("gh repo delete o/r --yes", "cannot be undone"),
    asks("gh repo archive o/r -y", "read-only"),
    asks("X='gh repo --description x edit o/r'; eval \"$X\"", "cannot read"),
    asks("X='gh -R o/r repo delete --yes'; eval \"$X\"", "cannot read"),
    asks("python3 -c \"import os; os.system('gh -R o/r repo delete')\"", "cannot read"),
    // A refusal wins over an ask on the same line.
    review("gh repo delete o/r --yes && gh pr merge 5 --admin", "refuse"),
    review("X='gh pr merge 5'; eval \"$X\"; gh repo delete o/r --yes", "refuse"),
    // Reads of the repository, and local repo commands, pass without a prompt.
    review("gh repo view", "allow"),
    review("gh repo view o/r --json defaultBranchRef", "allow"),
    review("gh repo list", "allow"),
    review("gh repo ls o", "allow"),
    review("gh repo clone o/r", "allow"),
    review("gh repo set-default o/r", "allow"),
    review("gh repo edit --help", "allow"),
    review("gh repo delete --help", "allow"),
    review("echo gh repo delete o/r --yes", "allow"),
    review("git commit -m 'gh repo delete asks first'", "allow"),
    review("eval \"$(ssh-agent -s)\" && gh repo view", "allow"),
    // Reads of the same paths, and other writes, still pass.
    review("gh api repos/o/r/git/refs/heads/main", "allow"),
    review("gh api -X GET repos/o/r/branches/main/protection", "allow"),
    review("gh api -X HEAD repos/o/r/rulesets", "allow"),
    review("gh api repos/o/r/rulesets/42", "allow"),
    review("gh api -X GET repos/o/r/git/refs -f per_page=5", "allow"),
    review("gh api repos/o/r/contents/README.md", "allow"),
    review("gh api repos/o/r/branches/main", "allow"),
    review("gh api -X POST repos/o/r/issues -f title=x", "allow"),
    review("gh api graphql -f query='query { repository(owner: \"o\", name: \"r\") { ref(qualifiedName: \"main\") { name } } }'", "allow"),
    review("gh ruleset list", "allow"),
    review("gh rs view 42", "allow"),
    review("curl -s https://api.github.com/repos/o/r/branches/main/protection", "allow"),
    review("curl -sI https://api.github.com/repos/o/r/git/refs/heads/main", "allow"),
    review("http GET https://api.github.com/repos/o/r/rulesets", "allow"),
    review("echo gh api -X DELETE repos/o/r/git/refs/heads/main", "allow"),
    // A gh alias may run a PR write the gate cannot see: defining one is refused.
    refuseSays("gh alias set m 'pr merge --admin'", ASK_OWNER),
    refuseSays("gh alias set --clobber co 'pr merge'", ASK_OWNER),
    refuseSays("gh alias set --shell m 'gh pr merge 5'", ASK_OWNER),
    refuseSays("gh alias set -s m 'gh api -X DELETE repos/o/r/branches/main/protection'", ASK_OWNER),
    refuseSays("gh alias import aliases.yml", ASK_OWNER),
    refuseSays("gh alias import -", ASK_OWNER),
    refuseSays("gh alias import --clobber - <<< 'm: pr merge'", ASK_OWNER),
    refuseSays("gh alias delete m", ASK_OWNER),
    refuseSays("gh alias delete --all", ASK_OWNER),
    refuseSays("gh alias \"set\" m 'pr merge'", ASK_OWNER),
    refuseSays("gh alias $A m 'pr merge'", ASK_OWNER),
    refuseSays("bash -c \"gh alias set m 'pr merge'\"", ASK_OWNER),
    review("X='gh alias set m x'; eval \"$X\"", "refuse"),
    review("python3 -c \"import os; os.system('gh alias set m x')\"", "refuse"),
    review("X='gh alias --clobber set m x'; eval \"$X\"", "refuse"),
    refuseSays("gh alias --clobber set m x", ASK_OWNER),
    refuseSays("cat f | xargs gh alias", "xargs builds"),
    refuseSays("echo m 5 | xargs gh", "xargs builds"),
    // A gh word that is not one of gh's own commands is an alias or an extension.
    refuseSays("gh m 5", "not a gh command"),
    refuseSays("gh co 5", "not a gh command"),
    refuseSays("gh mrg --squash 5", "not a gh command"),
    refuseSays("env gh m 5", "not a gh command"),
    refuseSays("timeout 30 gh m 5", "not a gh command"),
    refuseSays("echo 5 | xargs gh m", "not a gh command"),
    refuseSays("gh -R o/r m 5", "flags come before the subcommand"),
    refuseSays("gh --repo=o/r m 5", "flags come before the subcommand"),
    review("X='gh m 5'; eval \"$X\"", "refuse"),
    review("eval \"$(ssh-agent -s)\" && gh m 5", "refuse"),
    review("python3 -c \"import subprocess; subprocess.run(['gh','m','5'])\"", "refuse"),
    review("X='gh -R o/r m 5'; eval \"$X\"", "refuse"),
    review("X='gh --repo=o/r m 5'; eval \"$X\"", "refuse"),
    review("brew install gh jq", "allow"),
    review("eval \"$(ssh-agent -s)\" && brew install gh jq", "allow"),
    review("eval \"$(ssh-agent -s)\" && git commit -m \"Let gh handle auth\"", "allow"),
    review("X='gh co 5'; eval \"$X\"", "refuse"),
    review("Y=\" gh m 5\"; eval \"$Y\"", "refuse"),
    review("find . -exec gh co {} \\;", "refuse"),
    review("python3 -c 'subprocess.run([\"/opt/homebrew/bin/gh\",\"co\",\"5\"])'", "refuse"),
    review("ls docs/gh notes", "allow"),
    // gh behind a wrapper, an option or an assignment still starts a command.
    ...["timeout 60 gh m 5", "GH_REPO=o/r gh m 5", "env GH_REPO=o/r gh m 5", "sudo -u x gh m 5", "nice -n 5 gh m 5",
      "if gh m 5; then :; fi", "! gh m 5", "{ gh m 5; }", "xargs -n1 gh m < f", "timeout 60 gh alias set m x"]
      .map((c) => review(`python3 -c 'import os; os.system("${c}")'`, "refuse")),
    review("X='timeout 9 gh m 5'; eval \"$X\"", "refuse"),
    review("X='GH_REPO=o/r gh m 5'; eval \"$X\"", "refuse"),
    review("git -c core.pager='timeout 9 gh m 5' log", "refuse"),
    review("git -c core.pager='env X=1 gh alias set m x' log", "refuse"),
    review("timeout 30 gh pr view 5", "allow"),
    review("sudo -u x ls && gh issue list", "allow"),
    review("which gh node", "allow"),
    review("gh a11y", "allow"),
    // A git shell alias may run gh in a way the gate cannot read.
    review("git -c alias.m='!gh pr merge 5' m", "refuse"),
    review("git -c 'alias.m=!gh pr merge 5 --admin' m", "refuse"),
    review("git -c Alias.M='!sh -c \"gh pr merge 5\"' M", "refuse"),
    review("git config alias.m '!gh pr merge 5'", "refuse"),
    review("git config --global --add alias.m '!gh pr merge 5'", "refuse"),
    review("git config set alias.m '!gh pr merge 5'", "refuse"),
    review("git config alias.m \"$X\"", "refuse"),
    review("git --config-env=alias.m=X m", "refuse"),
    review("git --config-env alias.m=X m", "refuse"),
    review("git --config-env Alias.M=X M", "refuse"),
    review("git -c alias.lg=log commit -m \"$MSG\"", "allow"),
    review("git -c 'alias.x=-c \"alias.y=!echo hi\" y' x", "refuse"),
    review("git config alias.x '-c \"alias.y=!gh pr merge 5\" y'", "refuse"),
    refuseSays("git -c core.pager='gh pr merge 5; cat' log", "from its config"),
    refuseSays("git -c core.sshCommand='gh pr merge 5; ssh' fetch", "from its config"),
    refuseSays("git -c core.editor='gh api -X PATCH repos/o/r' commit", "from its config"),
    review("git -c core.pager=less log", "allow"),
    // gh's own commands, alias reads and plain git aliases still pass.
    review("gh alias list", "allow"),
    review("gh alias ls", "allow"),
    review("gh alias set --help", "allow"),
    review("gh issue list", "allow"),
    review("gh repo view o/r", "allow"),
    review("gh run list --limit 5", "allow"),
    review("gh search prs 'is:open'", "allow"),
    review("gh auth status", "allow"),
    review("gh ext list", "allow"),
    review("gh cs list", "allow"),
    review("gh copilot --help", "allow"),
    review("gh help pr", "allow"),
    review("gh --version", "allow"),
    review("gh", "allow"),
    review("which gh", "allow"),
    review("eval \"$(ssh-agent -s)\" && gh issue list", "allow"),
    review("git commit -m 'gh alias set is refused'", "allow"),
    review("git config alias.st status", "allow"),
    review("git config --get alias.m", "allow"),
    // Reads, plain merges and text that only names --admin still pass.
    review("gh pr merge 5 --squash --delete-branch --match-head-commit abc123", "allow", { FAKE_PR_BODY: good }),
    review("gh pr merge 5 --squash --subject \"$T\" --body \"$B\" -R o/r", "allow", { FAKE_PR_BODY: good }),
    review("gh pr merge --admin --help", "allow"),
    review("gh pr view 5 --json mergeStateStatus", "allow"),
    review("echo gh pr merge 5 --admin", "allow"),
    review("git commit -m 'refuse gh pr merge --admin'", "allow"),
    review("gh issue create --title 'gh pr merge --admin is refused' --body x", "allow"),
    inNamed("gh pr merge 5 -R other-owner/other-repo --squash", "allow"),
    { ...review("gh pr merge 5", "refuse"), hookDir: lone },
    mcp("mcp__github__merge_pull_request", { pullNumber: 5 }, "refuse"),
    mcp("mcp__github__create_pull_request", { body: "hi" }, "refuse"),
    mcp("mcp__github__create_pull_request", { body: "hi", draft: true }, "refuse"),
    mcp("mcp__github__create_pull_request", { body: good, draft: true }, "allow"),
    mcp("mcp__github__create_pull_request", { draft: true }, "refuse"),
    mcp("mcp__github__create_pull_request", { body: good }, "allow"),
    mcp("mcp__github__update_pull_request", { draft: false }, "refuse"),
    mcp("mcp__github__create_pull_request_review", { body: "LGTM" }, "allow"),
    mcp("mcp__db__create_project", { name: "x" }, "allow"),
    mcp("mcp__github__get_pull_request_merge_status", {}, "allow"),
    // Cleanup after a merge (coordinator prompt): run with `git -C <worktree>`,
    // both hooks allow every command from the main checkout and from the
    // worktree, with no override. The same writes without -C are refused in main.
    ...CLEANUP.flatMap((command) =>
      [main, tree].flatMap((cwd) => [guard(cwd, command, "allow"), reviewIn(cwd, command, "allow", { FAKE_PR_BODY: "" })])),
    guard(main, "git branch -d task", "refuse"),
    guard(main, "git worktree prune", "refuse"),
  ];

  let failed = 0;
  for (const c of cases) {
    const payload = c.tool
      ? { tool_name: c.tool, tool_input: c.input, cwd: c.cwd }
      : { tool_name: "Bash", tool_input: { command: c.command }, cwd: c.cwd };
    const run = spawnSync("node", [path.join(c.hookDir, FILES[c.hook])], {
      input: JSON.stringify(payload),
      env: { ...env, ...c.extra, PATH: `${bin}${path.delimiter}${env.PATH}` },
      encoding: "utf8",
    });
    // Exit 0 allows, or asks the user when stdout says so; any other output on exit 0 is a failure.
    let decision = "allow";
    let output = {};
    if (run.status === 0 && run.stdout.trim()) {
      try {
        output = JSON.parse(run.stdout).hookSpecificOutput ?? {};
        decision = output.permissionDecision ?? "no decision";
      } catch {
        decision = "unparsable output";
      }
    }
    let got = run.status === 2 ? "refuse" : run.status === 0 ? decision : `exit ${run.status}`;
    const reason = got === "ask" ? output.permissionDecisionReason ?? "" : run.stderr;
    if ((got === "refuse" || got === "ask") && c.says && !reason.toLowerCase().includes(c.says.toLowerCase())) got = `${got} without "${c.says}"`;
    if (got !== c.expect) failed += 1;
    const shown = (c.tool ?? c.command).replaceAll(tmp, "<tmp>").replace(/\n[\s\S]*/, " ...");
    console.log(`${got === c.expect ? "ok  " : "FAIL"} ${c.hook.padEnd(6)} ${c.expect.padEnd(6)} ${shown}`);
    if (got !== c.expect && run.stderr) console.log(`     stderr: ${run.stderr.trim().split("\n")[0]}`);
  }
  console.log(failed === 0 ? `\nAll ${cases.length} cases pass.` : `\n${failed} of ${cases.length} cases failed.`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
