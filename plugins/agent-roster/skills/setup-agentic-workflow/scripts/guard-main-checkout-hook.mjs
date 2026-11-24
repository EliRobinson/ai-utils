#!/usr/bin/env node
// PreToolUse hook for Bash. Refuses git commands that change the working tree
// or a local ref when they would run in this repository's main checkout.
//
// Why: several agents share one clone. A write into the shared checkout can
// commit, revert or switch away another agent's uncommitted work, and git
// keeps no record of unstaged edits. A linked worktree has no such risk.
//
// Escape: prefix the one command with ALLOW_MAIN_CHECKOUT_WRITE=1. An
// exported variable does not count, so a session cannot switch the guard off
// by accident.
//
// Contract: Claude Code writes the tool call to stdin as JSON. Exit 2 refuses
// the call and shows stderr to the agent. Exit 0 allows it.
//
// Every doubt allows: a line it cannot parse, a directory built at run time,
// a cd it cannot follow, its own crash. It sees every Bash call, so a bug
// that refused would block all work. It is a guard against accidents, not a
// security boundary.
//
// No dependencies. Needs agent-hook-shell.mjs in the same folder. Installed
// by the setup-agentic-workflow skill.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isEntry, readPayload, realpath, refuse, resolveDir, walk, nameOf } from "./agent-hook-shell.mjs";

const OVERRIDE = "ALLOW_MAIN_CHECKOUT_WRITE";

// ------------------------------------------------- which git calls write

const positionals = (rest) => rest.filter((w) => !w.startsWith("-"));
const has = (rest, ...flags) => rest.some((w) => flags.some((f) => w === f || w.startsWith(`${f}=`)));

const ALWAYS = () => true;
// -n alone, or inside a bundle of short flags such as -nd.
const unlessDryRun = (rest) => !rest.some((w) => w === "--dry-run" || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(w));
const subIn = (...subs) => (rest) => subs.includes(positionals(rest)[0]);
const subNotIn = (...reads) => (rest) => {
  const first = positionals(rest)[0];
  return first !== undefined && !reads.includes(first);
};

// `git config` reads a key with one positional and writes with two, or with
// a write flag or subcommand. --global, --system and -f <file> do not touch
// the checkout's config.
const CONFIG_VALUE_FLAGS = new Set(["-f", "--file", "--blob", "--type", "--default", "--comment"]);
function configWrites(rest) {
  if (has(rest, "--global", "--system", "-f", "--file")) return false;
  if (has(rest, "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l")) return false;
  if (has(rest, "--add", "--unset", "--unset-all", "--replace-all", "--rename-section", "--remove-section", "-e", "--edit")) {
    return true;
  }
  const args = rest.filter((w, i) => !w.startsWith("-") && !CONFIG_VALUE_FLAGS.has(rest[i - 1]));
  if (["get", "list"].includes(args[0])) return false;
  if (["set", "unset", "edit", "rename-section", "remove-section"].includes(args[0])) return true;
  return args.length >= 2;
}

// Git verbs that change a working tree or a local ref, with the predicate
// that decides whether this call does. `fetch` and `push` are left out on
// purpose: fetch is the coordinator's daily read, and push changes no tree.
const MUTATING = new Map([
  ...["am", "cherry-pick", "commit", "filter-branch", "merge", "prune", "pull", "rebase", "reset",
    "restore", "revert", "switch", "update-index", "update-ref"].map((verb) => [verb, ALWAYS]),
  ...["add", "clean", "rm", "mv"].map((verb) => [verb, unlessDryRun]),
  ["checkout", (rest) => rest.length > 0],
  ["stash", (rest) => !["list", "show"].includes(positionals(rest)[0])],
  ["apply", (rest) => !has(rest, "--check", "--stat", "--summary", "--numstat")],
  ["submodule", subNotIn("status", "summary")],
  ["bisect", subNotIn("log", "visualize", "view")],
  ["sparse-checkout", subNotIn("list")],
  ["worktree", subIn("remove", "move", "prune")],
  ["notes", subIn("add", "append", "copy", "edit", "remove", "prune")],
  ["remote", subIn("add", "remove", "rm", "rename", "set-url", "set-head", "prune")],
  ["reflog", subIn("expire", "delete", "drop")],
  ["branch", (rest) => has(rest, "-d", "-D", "-m", "-M", "--delete", "--move", "-f", "--force")],
  ["tag", (rest) => has(rest, "-d", "--delete", "-f", "--force")],
  ["gc", (rest) => has(rest, "--prune", "--aggressive")],
  ["config", configWrites],
]);

const GIT_VALUE_OPTIONS = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env",
]);

// The git call a command makes: { env, verb, rest, dirs } or null. dirs holds
// the words of -C, --git-dir and --work-tree (and GIT_DIR / GIT_WORK_TREE).
function gitCall(call) {
  if (nameOf(call) !== "git") return null;
  const dirs = { C: [], gitDir: null, workTree: null };
  const args = call.args;
  let i = 0;
  const take = (option, word) => {
    if (option === "-C") dirs.C.push(word);
    if (option === "--git-dir") dirs.gitDir = word;
    if (option === "--work-tree") dirs.workTree = word;
  };
  while (i < args.length && args[i].text.startsWith("-")) {
    const text = args[i].text;
    const eq = text.indexOf("=");
    if (text.startsWith("--") && eq !== -1) {
      take(text.slice(0, eq), { text: text.slice(eq + 1), dynamic: args[i].dynamic });
    } else if (GIT_VALUE_OPTIONS.has(text) && args[i + 1]) {
      take(text, args[i + 1]);
      i++;
    }
    i++;
  }
  if (i >= args.length) return null;
  if ("GIT_DIR" in call.env) dirs.gitDir = { text: call.env.GIT_DIR ?? "", dynamic: call.env.GIT_DIR === null };
  if ("GIT_WORK_TREE" in call.env) {
    dirs.workTree = { text: call.env.GIT_WORK_TREE ?? "", dynamic: call.env.GIT_WORK_TREE === null };
  }
  return { env: call.env, verb: args[i].text, rest: args.slice(i + 1).map((w) => w.text), dirs };
}

// ---------------------------------------------------------- checkouts

// Walk up from dir to the nearest `.git`. A `.git` directory marks a main
// checkout; a `.git` file marks a linked worktree or a submodule.
function checkoutOf(dir) {
  let current = path.resolve(dir);
  for (;;) {
    try {
      return { root: current, main: fs.statSync(path.join(current, ".git")).isDirectory() };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

const WORKTREES = `${path.sep}.git${path.sep}worktrees${path.sep}`;

// The main checkout of the repository this file lives in, or null. From a
// linked worktree, follow its `.git` file back to the main checkout.
function ownMainRoot(from = path.dirname(fileURLToPath(import.meta.url))) {
  const found = checkoutOf(from);
  if (!found) return null;
  if (found.main) return realpath(found.root);
  try {
    const pointer = fs.readFileSync(path.join(found.root, ".git"), "utf8");
    const gitdir = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
    const full = gitdir ? path.resolve(found.root, gitdir) : "";
    const at = full.lastIndexOf(WORKTREES);
    return at === -1 ? null : realpath(full.slice(0, at));
  } catch {
    return null;
  }
}

// The checkout a git call acts on, or null when that cannot be known or is
// not a main checkout. A --git-dir wins over a --work-tree: it names the
// index and branch that change.
function mainCheckoutActedOn(git, dir) {
  let base = dir;
  for (const word of git.dirs.C) base = resolveDir(base, word);
  if (base === null) return null;
  if (git.dirs.gitDir) {
    const gitDir = resolveDir(base, git.dirs.gitDir);
    if (gitDir === null || gitDir.includes(WORKTREES)) return null;
    base = path.basename(gitDir) === ".git" ? path.dirname(gitDir) : gitDir;
  } else if (git.dirs.workTree) {
    base = resolveDir(base, git.dirs.workTree);
    if (base === null) return null;
  }
  const checkout = checkoutOf(base);
  return checkout?.main ? checkout.root : null;
}

// ------------------------------------------------------------- decision

function refusal(verb, root) {
  return [
    `Refused: \`git ${verb}\` would change the main checkout at ${root}.`,
    "",
    "Other agents share that tree. A write there can commit, revert or switch away",
    "their uncommitted work, and git keeps no record of unstaged edits.",
    "",
    "Take your own worktree first:",
    "",
    "  git fetch origin",
    "  git worktree add ../<repo>-<task> -b <username>/<ticket>/<short-description> origin/main",
    "",
    "Reads still work here: status, log, diff, show, fetch, stash list, worktree add.",
    "",
    `If this one command must run in the shared tree, prefix it with ${OVERRIDE}=1`,
    "and say in your next message that you used it, and why.",
    "See docs/agents/git-workflow.md.",
  ].join("\n");
}

// Decide one Bash command: { blocked: false } or { blocked: true, reason }.
// guarded is the main checkout to protect; null (unknown) guards nothing.
export function decide(command, cwd, guarded = ownMainRoot()) {
  if (guarded === null) return { blocked: false };
  try {
    for (const { call, dir } of walk(command, cwd)) {
      const git = gitCall(call);
      if (!git || git.env[OVERRIDE] === "1" || dir === null) continue;
      const writes = MUTATING.get(git.verb);
      if (!writes || git.rest.includes("--help") || git.rest.includes("-h") || !writes(git.rest)) continue;
      const root = mainCheckoutActedOn(git, dir);
      if (root !== null && realpath(root) === guarded) {
        return { blocked: true, reason: refusal(git.verb, root) };
      }
    }
  } catch {
    // A line the shell would reject too, or one too nested to read.
  }
  return { blocked: false };
}

async function main() {
  const payload = await readPayload();
  const command = payload?.tool_input?.command;
  if (payload?.tool_name !== "Bash" || typeof command !== "string") return;
  const decision = decide(command, payload.cwd ?? process.cwd());
  if (decision.blocked) refuse(decision.reason);
}

if (isEntry(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`guard-main-checkout: hook crashed, allowing the call: ${error}\n`);
  });
}
