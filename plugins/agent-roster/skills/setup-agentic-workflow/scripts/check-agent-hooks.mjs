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
  const mcp = (tool, input, expect) => ({ hook: "review", hookDir: path.join(tree, "scripts"), cwd: tree, tool, input, expect });
  const fromTree = path.join(tree, "scripts");

  const cases = [
    // The guard refuses writes in the main checkout.
    guard(main, "git commit -m x", "refuse"),
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
    review("gh pr ready 5", "allow", { FAKE_PR_BODY: filedAs("SPOT-42") }),
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
    review("gh api -X PUT repos/o/r/pulls/5/merge", "refuse", { FAKE_PR_BODY: "" }),
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
    review("curl https://api.github.com/repos/o/r/pulls --data @pr.json", "refuse"),
    review("curl -d @q.json https://api.github.com/graphql", "refuse"),
    review("curl --json @- https://github.example.com/api/graphql < q.json", "refuse"),
    review("timeout 30 curl -X PUT https://api.github.com/repos/o/r/pulls/5/merge?x=1", "refuse"),
    review("curl -s -H \"Authorization: Bearer $T\" https://api.github.com/repos/o/r/pulls/5/merge", "allow"),
    review("curl -sI https://api.github.com/repos/o/r/pulls/5/merge", "allow"),
    review("curl -sL https://api.github.com/repos/o/r/pulls?state=open | head", "allow"),
    review("curl -X GET https://api.github.com/repos/o/r/pulls/5/merge", "allow"),
    review("curl -d @q.json https://api.example.com/graphql", "allow"),
    review("bash -lc 'gh pr merge 5'", "refuse", { FAKE_PR_BODY: "" }),
    // eval and sh -c: a literal script is read like any command; one built at
    // run time, or read from stdin, is refused when the line names a PR write.
    review("eval gh pr merge 5", "refuse", { FAKE_PR_BODY: "" }),
    review("eval \"gh pr merge 5\"", "refuse", { FAKE_PR_BODY: "" }),
    review("eval 'gh pr merge 5'", "refuse", { FAKE_PR_BODY: "" }),
    review("eval 'gh pr' merge 5", "refuse", { FAKE_PR_BODY: "" }),
    review("eval \"gh pr merge $N\"", "refuse"),
    review("X='gh pr merge 5'; eval \"$X\"", "refuse"),
    review("eval \"gh api -X PUT repos/o/r/pulls/$N/merge\"", "refuse"),
    review("bash -c \"gh pr merge 5\"", "refuse", { FAKE_PR_BODY: "" }),
    review("sh -c 'gh pr merge 5'", "refuse", { FAKE_PR_BODY: "" }),
    review("zsh -c \"gh pr merge 5\"", "refuse", { FAKE_PR_BODY: "" }),
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
    reviewIn(named, "gh pr merge 5", "refuse", { FAKE_PR_BODY: "no record" }),
    reviewIn(named, "gh pr merge 5 -R Owner/Name", "refuse", { FAKE_PR_BODY: "no record" }),
    reviewIn(named, "gh pr merge 5 -R owner/name.git", "refuse", { FAKE_PR_BODY: "no record" }),
    reviewIn(named, "gh pr merge 5 --repo OWNER/NAME.git/", "refuse", { FAKE_PR_BODY: "no record" }),
    reviewIn(named, "gh pr merge 5 --repo=owner/name/", "refuse", { FAKE_PR_BODY: "no record" }),
    reviewIn(named, "gh pr merge 5 -R github.com/owner/name", "refuse", { FAKE_PR_BODY: "no record" }),
    reviewIn(named, "gh pr merge 5 -R https://github.com/Owner/Name", "refuse", { FAKE_PR_BODY: "no record" }),
    reviewIn(named, "gh pr merge 5 -R git@github.com:owner/name.git", "refuse", { FAKE_PR_BODY: "no record" }),
    reviewIn(named, "gh pr merge 5 -R ssh://git@github.com/owner/name.git", "refuse", { FAKE_PR_BODY: "no record" }),
    reviewIn(named, "gh api -X PUT repos/owner/Name.git/pulls/5/merge", "refuse", { FAKE_PR_BODY: "no record" }),
    reviewIn(named, "gh pr merge 5 -R ghe.example.com/other/repo", "refuse", { FAKE_PR_BODY: "no record" }),
    reviewIn(named, "gh pr merge 5 -R Owner/Name", "allow", { FAKE_PR_BODY: good }),
    reviewIn(named, "gh pr merge 5 -R other-owner/other-repo", "allow", { FAKE_PR_BODY: "no record" }),
    reviewIn(named, "gh pr merge 5 -R owner/name-fork.git", "allow", { FAKE_PR_BODY: "no record" }),
    reviewIn(named, "gh pr merge 5 --repo https://github.com/other-owner/name", "allow", { FAKE_PR_BODY: "no record" }),
    reviewIn(named, "gh api -X PUT repos/other/repo/pulls/5/merge", "allow", { FAKE_PR_BODY: "no record" }),
    review("timeout 60 gh pr merge 5", "refuse", { FAKE_PR_BODY: "" }),
    review("echo 5 | xargs gh pr merge", "refuse"),
    review("$GH pr merge 5", "refuse"),
    review("gh pr view 5 && gh pr list", "allow"),
    review("git commit -m 'merge ready create'", "allow"),
    review("echo gh pr merge 5", "allow"),
    review("gh pr merge --help", "allow"),
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
    const got = run.status === 2 ? "refuse" : run.status === 0 ? "allow" : `exit ${run.status}`;
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
