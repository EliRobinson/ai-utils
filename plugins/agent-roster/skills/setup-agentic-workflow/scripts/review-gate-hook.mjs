#!/usr/bin/env node
// PreToolUse hook for Bash and for the PR tools of MCP servers. Refuses to
// open a PR (draft or not), take it out of draft, or merge it, unless its
// body carries a complete `## Review` record (docs/agents/review-gate.md).
// It always refuses a merge that bypasses branch protection: `gh pr merge
// --admin`, and a REST merge through `gh api`. It always refuses a GitHub API
// write that moves, deletes or renames a branch, commits to it directly,
// changes branch protection or rulesets, or changes the repository's own
// settings, and a gh or git alias it cannot read. It asks the user first
// (permissionDecision "ask") before a gh repo command that changes or
// removes the repository: edit, rename, delete, archive, unarchive.
// The reviewers run on the branch before the PR exists. Ready and merge stay
// gated too, for PRs opened outside the hook (the web UI, other tools) and
// for bodies edited after the PR was opened.
//
// Why: a review rule that is only written down gets skipped. A record a
// machine can check makes skipping a reviewer a visible, written claim.
//
// What it proves is narrow: that the author says every reviewer ran on an
// allowed model and accounted for every finding. It cannot prove a reviewer
// ran, and it cannot see a merge made outside Claude Code.
//
// Failure policy: it allows what it can tell is unrelated. Once a call looks
// like a PR operation, every failure refuses, a crash or a missing file
// included. A merge gate that allows when it cannot check is not a gate.
// There is no escape.
//
// No dependencies. Needs agent-hook-shell.mjs in the same folder. Installed
// by the setup-agentic-workflow skill.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------- the record

// The reviewers, as the record names them, and the subagent in
// .claude/agents/ that runs each one. Either spelling is accepted.
export const AGENTS = {
  Thermonuclear: "thermonuclear-reviewer",
  "Correctness critic": "correctness-critic",
  "Spec critic": "spec-critic",
  "Security critic": "security-critic",
  "Copy critic": "copy-critic",
  "DRY critic": "dry-critic",
  "Design critic": "design-critic",
  "Accessibility critic": "accessibility-critic",
};
const REVIEWERS = Object.keys(AGENTS);
const MODELS = ["Opus", "Sonnet", "Haiku"];
const MODEL_LIST = `${MODELS.slice(0, -1).join(", ")} or ${MODELS.at(-1)}`;
const ALLOWED_MODEL = new RegExp(`(?:^|[^a-z])(?:${MODELS.join("|")})(?:$|[^a-z])`, "i");
const KINDS = ["fixed", "declined", "filed"];
const zeroCounts = () => Object.fromEntries(KINDS.map((k) => [k, 0]));

// Folding spaces around "/" lets the old combined "Spec / security / copy critic"
// row be recognised as one name, and so refused as unknown.
const key = (text) =>
  text.replace(/^[`*_]+|[`*_]+$/g, "").trim().toLowerCase().replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ");
const reviewerNamed = (text) =>
  REVIEWERS.find((name) => key(name) === key(text) || AGENTS[name] === key(text)) ?? null;
const cells = (row) =>
  row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());

// Lines GitHub renders as prose: no HTML comments, no fenced code blocks.
function renderedLines(body) {
  const out = [];
  let fence = null;
  for (const line of body.replace(/<!--[\s\S]*?(?:-->|$)/g, "").split(/\r?\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null && m) fence = m[1];
    else if (fence !== null && m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    else if (fence === null) out.push(line);
  }
  return out;
}

function dispositionOf(tag) {
  if (/^fixed$/i.test(tag)) return "fixed";
  if (/^declined:\s*\S/i.test(tag)) return "declined";
  // One ticket ID in the repo's ticketing tool (docs/agents/issue-tracker.md):
  // "#123" for GitHub, "PROJ-42" or similar elsewhere. It must hold a digit and only letters, digits and # . _ -.
  if (/^filed\s+(?=[\w#.-]*\d)[\w#.-]+$/i.test(tag)) return "filed";
  return null;
}

// Parse the Review section: { rows, findings, problems } or { error }.
function parseRecord(body) {
  const lines = renderedLines(body ?? "");
  const starts = lines.flatMap((l, i) => (/^##[ \t]+review[ \t]*#*[ \t]*$/i.test(l) ? [i] : []));
  if (starts.length === 0) return { error: "the PR body has no `## Review` section" };
  if (starts.length > 1) return { error: "the PR body has more than one `## Review` section" };
  const section = [];
  for (const line of lines.slice(starts[0] + 1)) {
    if (/^#{1,2}[ \t]/.test(line)) break;
    section.push(line);
  }
  const header = section.findIndex((l) => l.trim().startsWith("|"));
  const head = header === -1 ? [] : cells(section[header]).map((c) => c.toLowerCase());
  if (head.join("|") !== "reviewer|model|findings|disposition") {
    return { error: "the Review section has no `| Reviewer | Model | Findings | Disposition |` table" };
  }
  const separator = section[header + 1] ?? "";
  if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(separator) || !separator.includes("-")) {
    return { error: "the Review table has no `| --- |` separator row under its header" };
  }
  // The round count: at most two rounds of review per PR, unless the owner
  // allowed more, which the record must say in its own line.
  const roundLines = section.flatMap((l) => {
    const m = /^[ \t]*[*_]*rounds[*_]*[ \t]*:[*_]*[ \t]*(\S+?)[ \t]*$/i.exec(l);
    return m ? [m[1]] : [];
  });
  const allowed = section.flatMap((l) => {
    const m = /^[ \t]*[*_]*owner allowed round (\d+)[*_]*[ \t]*:[ \t]*\S/i.exec(l);
    return m ? [Number(m[1])] : [];
  });
  const rounds = { lines: roundLines, allowedUpTo: Math.max(2, ...allowed) };
  const rows = [];
  for (const line of section.slice(header + 2)) {
    if (!line.trim().startsWith("|")) break;
    rows.push(cells(line));
  }
  const problems = [];
  const findings = new Map(REVIEWERS.map((r) => [r, zeroCounts()]));
  for (const line of section) {
    const item = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+(.*)$/.exec(line)?.[1];
    const prefix = item && /^[`*_]*([a-z][a-z /-]*?)[`*_]*[ \t]*:/i.exec(item);
    const who = prefix && reviewerNamed(prefix[1]);
    const tag = /\[([^\]]*)\][ \t.]*$/.exec(item)?.[1];
    if (!who) {
      // A finding line whose name is misspelt or retired would otherwise vanish.
      if (prefix && tag !== undefined && dispositionOf(tag.trim()) !== null) {
        problems.push(`finding "${item}" names no reviewer; use one of: ${REVIEWERS.join(", ")}`);
      }
      continue;
    }
    const kind = tag === undefined ? null : dispositionOf(tag.trim());
    if (kind === null) problems.push(`finding "${item}" does not end with [fixed], [declined: <why>] or [filed <ticket ID>] (one ID per tag)`);
    else findings.get(who)[kind] += 1;
  }
  return { rows, findings, problems, rounds };
}

// The rounds problem, if any: one `Rounds: N` line, N from 1 to 2, or higher
// only up to the round an `Owner allowed round N:` line names.
function roundsProblem({ lines, allowedUpTo }) {
  if (lines.length === 0) return "the Review section has no `Rounds: 1` or `Rounds: 2` line";
  if (lines.length > 1) return "the Review section has more than one `Rounds:` line";
  const n = /^\d+$/.test(lines[0]) ? Number(lines[0]) : 0;
  if (n < 1) return `Rounds must be 1 or 2, not "${lines[0]}"`;
  if (n > allowedUpTo) {
    return `Rounds is ${n}; a PR gets at most two rounds unless the record has an "Owner allowed round ${n}: <when and where>" line`;
  }
  return null;
}

// Every problem with the body's Review record. An empty list means it passes.
export function recordProblems(body) {
  const record = parseRecord(body);
  if (record.error) return [record.error];
  const { rows, findings } = record;
  const problems = [...record.problems];
  const roundsIssue = roundsProblem(record.rounds);
  if (roundsIssue) problems.push(roundsIssue);
  const seen = new Set();
  const summaryPart = new RegExp(`^(\\d+)\\s+(${KINDS.join("|")})$`);
  for (const [name = "", model = "", count = "", summary = ""] of rows) {
    const who = reviewerNamed(name);
    if (!who) {
      problems.push(`table row "${name}" is not one of: ${REVIEWERS.join(", ")}`);
      continue;
    }
    if (seen.has(who)) problems.push(`${who} has more than one row`);
    seen.add(who);
    if (/fable/i.test(model)) problems.push(`${who} ran on Fable; reviewers run on ${MODEL_LIST}`);
    else if (!ALLOWED_MODEL.test(model)) problems.push(`${who} names no ${MODEL_LIST} model`);
    if (!/^\d+$/.test(count)) {
      problems.push(`${who}: Findings must be a whole number`);
      continue;
    }
    const found = findings.get(who);
    const total = KINDS.reduce((sum, k) => sum + found[k], 0);
    if (Number(count) !== total) problems.push(`${who}: table says ${count} findings, the list has ${total}`);
    const claimed = zeroCounts();
    const text = summary.toLowerCase().trim();
    if (text !== "none") {
      for (const part of text.split(",")) {
        const m = summaryPart.exec(part.trim());
        if (!m) {
          problems.push(`${who}: Disposition "${summary}" is not like "2 fixed, 1 declined" or "none"`);
          break;
        }
        claimed[m[2]] += Number(m[1]);
      }
    }
    if (KINDS.some((k) => claimed[k] !== found[k])) {
      problems.push(`${who}: Disposition "${summary}" does not match its finding lines`);
    }
  }
  for (const who of REVIEWERS) if (!seen.has(who)) problems.push(`${who} has no row in the table`);
  return problems;
}

const OPENING_PR = "Opening a PR (drafts included)";
const FINISH_OPEN_PR = "Then put the finished record in the PR body and try again.";

// next says what to do: review before opening, or finish an open PR's record.
function refusal(what, problems, next = "Run them on the branch before you open the PR.") {
  return [
    `Refused: ${what} needs a complete Review record in the PR body.`,
    "",
    ...problems.map((p) => `- ${p}`),
    "",
    `Run every reviewer agent from .claude/agents/ (${Object.values(AGENTS).join(", ")})`,
    `on ${MODEL_LIST}, never Fable. Fix, decline or file every finding, and write the record.`,
    `${next} Format: docs/agents/review-gate.md.`,
  ].join("\n");
}

// ------------------------------------------------------- PR operations

const PR_ACTIONS = ["merge", "ready", "create", "new"];
const MERGE_MUTATIONS =
  /\b(mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|markPullRequestReadyForReview|createPullRequest|mergeBranch)\b/;
// GraphQL mutations that move, delete or create a branch, commit to it
// directly, change branch protection or rulesets, or change the repository's
// settings (its default branch among them).
const BRANCH_MUTATIONS =
  /\b(createRef|updateRefs?|deleteRef|createCommitOnBranch|(?:create|update|delete)BranchProtectionRule|(?:create|update|delete)RepositoryRuleset|updateRepository|(?:un)?archiveRepository)\b/;
// The last part of the GitHub API paths that merge, open a PR or run GraphQL.
// API below holds the exact paths; PR_HINT and MAY_CONCERN only need the names.
const API_SEGMENTS = ["pulls", "merges", "graphql"];
// Text that may name a PR write, besides `pr <action>` (prActions below): a
// GitHub API path that merges or opens a PR or runs GraphQL, or a mutation.
const PR_HINT = new RegExp(
  [
    `/(?:${API_SEGMENTS.join("|")})(?=$|[\\s/?#])`,
    "\\bapi\\s+graphql\\b",
    "\\bmutation\\b",
    MERGE_MUTATIONS.source,
    BRANCH_MUTATIONS.source,
  ].join("|"),
  "g",
);
// A line worth walking at all. Tested on plain(line).
const MAY_CONCERN = new RegExp(`\\bgh\\b|\\bpr\\b|${API_SEGMENTS.join("|")}|mutation|github|\\balias\\b`, "i");
// A line longer than this that may concern a PR is refused unwalked.
const MAX_LINE = 20000;
// Text with quotes, backslashes and $'...' openers taken out and %XX decoded,
// so `gh pr "merge"`, `gh pr $'merge'` and `pull%73` read as what runs.
const plain = (text) =>
  text.replace(/\$'|['"\\]/g, "").replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
// The words of text as a token scan reads them (commas and brackets split
// too, so python's ["gh","pr","merge"] is seen), and for each word whether a
// command may start there: first, after a comma or bracket, after a word
// that ends in ; & | = or a backtick, after an assignment (`GH_REPO=x gh`),
// or after a word that runs the next one with its options and their values
// (`timeout 60 gh`, `sudo -u x gh`, `env X=1 gh`, `if gh`).
const RUNS_NEXT = new Set(["xargs", "exec", "env", "command", "nohup", "sudo", "doas", "eval", "then", "do", "else",
  "if", "elif", "while", "until", "time", "!", "{", "timeout", "nice",
  "ionice", "stdbuf", "setsid", "caffeinate", "watch", "parallel", "chronic", "flock", "builtin"]);
// Options whose next word is a command, wherever they stand (`bash -c gh`, `find -exec gh`).
const OPTION_RUNS_NEXT = new Set(["-c", "-exec", "-execdir", "-ok", "-okdir"]);
function scanWords(text) {
  const parts = text.split(/([\s,()[\]]+)/);
  const words = [];
  const atStart = [];
  let next = true; // the next word may start a command
  let wrapper = false; // inside a RUNS_NEXT word's options
  let optionValue = false; // the word after an option may be its value
  for (let i = 0; i < parts.length; i += 2) {
    const word = parts[i];
    const prev = words.at(-1);
    const start = next || /[,([]/.test(parts[i - 1] ?? "") || /[;&|`=]$/.test(prev ?? "");
    atStart.push(start);
    words.push(word);
    if (word === "") continue;
    const option = wrapper && (word.startsWith("-") || /^\d/.test(word) || optionValue);
    optionValue = option && word.startsWith("-") && !word.includes("=");
    // An assignment's value counts too, so X='timeout 9 gh m' is read like the command it holds.
    const runsNext = start && RUNS_NEXT.has(word.replace(/^[A-Za-z_]\w*=/, ""));
    if (runsNext) wrapper = true;
    else if (!option) wrapper = false;
    next = runsNext || (start && /^[A-Za-z_]\w*=/.test(word)) || option || OPTION_RUNS_NEXT.has(word);
  }
  return { words, atStart };
}
// A word that runs gh: gh itself, a path to it, or X=gh, ;gh, `gh.
const GH_START = /(?:^|[=;&|`/])gh$/;
// How many words a -R/--repo flag takes: 2 with its value, 1 for --repo=x,
// 0 for any other word.
const repoFlagWords = (word) => (REPO_FLAGS.includes(word) ? 2 : word.startsWith("--repo=") ? 1 : 0);
// The indexes of the words from start on that may be a gh subcommand. Flags
// may come first; each may take the next word as its value, so a word may be
// the subcommand when no more words than flags come before it. The value of
// -R/--repo is known, so it is skipped. A word no flag can take is the
// subcommand, and the scan stops there. classifyGh and the token scans share it.
function subcommandAt(words, start) {
  const found = [];
  let flags = 0;
  for (let i = start; i < words.length; i++) {
    const skip = repoFlagWords(words[i]);
    if (skip) i += skip - 1;
    else if (words[i].startsWith("-")) flags++;
    else if (found.push(i) > flags) break; // no flag left to take this word as its value
  }
  return found;
}
// How many `pr <action>` the text names, skipping flags and their values
// between them (`pr -R o/r merge`), as parsePrArgs reads them. `gh <word>
// <action>` counts too, so `gh $P merge` is seen, and so does a gh command
// that runs or changes an alias (runsAlias). A token scan, not a regex.
// An alias counts only where a command may start, so text that only names gh
// (`brew install gh jq`, a commit message) does not count.
function prActions(text) {
  const { words, atStart } = scanWords(text);
  let found = 0;
  for (let i = 0; i < words.length; i++) {
    const bare = words[i] === "gh" || words[i].endsWith("/gh");
    const startsGh = GH_START.test(words[i]) && (!bare || atStart[i]);
    if (startsGh && runsAlias(words, subcommandAt(words, i + 1))) {
      found++;
      continue;
    }
    let j;
    if (words[i] === "pr" && words[i - 1] !== "gh") j = i + 1;
    else if (words[i] === "gh" && words[i + 1] !== undefined) j = i + 2;
    else continue;
    while (j < words.length && words[j].startsWith("-")) j += VALUE_FLAGS.pr.has(words[j]) ? 2 : 1;
    if (PR_ACTIONS.includes(words[j])) found++;
  }
  return found;
}
// How many GitHub API paths that API.branchWrite matches the text names. A
// path starts with repos/, repositories/ or orgs/, after a URL's host or
// none, and after a character that is not part of a path, so a local path
// such as src/rename, .github/rulesets or docs/repos/... does not count.
const API_PATH = /(?:^|[^\w./-])((?:(?:[a-z][a-z0-9+.-]*:)?\/\/[^/\s]*|[\w.-]*github[\w.-]*)?\/?(?:repos|repositories|orgs)\/[^\s"'`,()[\]]*)/gi;
function branchPaths(said) {
  let found = 0;
  for (const match of said.matchAll(API_PATH)) {
    if (API.branchWrite.test(apiPath(match[1]))) found++;
  }
  return found;
}
// True when a call's text names a PR or branch write. A branch path counts
// only next to the word gh or GitHub.
const namesWrite = (said) =>
  prActions(said) > 0 || MERGE_MUTATIONS.test(said) || BRANCH_MUTATIONS.test(said)
  || (branchPaths(said) > 0 && /\bgh\b|github/i.test(said));
const hintCount = (text) => {
  const said = plain(text);
  return prActions(said) + (said.match(PR_HINT)?.length ?? 0) + branchPaths(said);
};
// The words of a call as the program sees them, program name first.
const wordsText = (call) => [call.program, ...call.args].map((w) => w.text).join(" ");
// A word the shell expands into other text: built at run time, or a brace
// expansion such as {merge,} (but not gh api's {owner} placeholders).
function expands(word) {
  if (word.dynamic) return true;
  for (const part of word.text.split("{").slice(1)) {
    const close = part.indexOf("}");
    const inner = close === -1 ? "" : part.slice(0, close);
    if (inner.includes(",") || inner.includes("..")) return true;
  }
  return false;
}

// GitHub REST and GraphQL paths, matched against apiPath().
const API = {
  graphql: /\/graphql$/,
  createPr: /\/pulls$/,
  mergePr: /\/pulls\/[^/]+\/merge$/,
  mergeBranch: /\/merges$/,
  // Writes here move, delete, create or rename a branch, commit to it
  // directly (contents), sync a fork's branch, or change branch protection
  // or rulesets, or write to the repository itself (its default branch and
  // settings, Actions permissions among them), or move it to another owner.
  // A branch name may hold slashes.
  branchWrite: /\/git\/refs?(?:\/|$)|\/branches\/.+\/(?:protection(?:\/.*)?|rename)$|\/rulesets(?:\/|$)|\/merge-upstream$|\/repos\/[^/]+\/[^/]+\/(?:contents(?:\/|$)|transfer$|actions\/permissions(?:\/|$))|\/repos\/[^/]+\/[^/]+$|\/repositories\/[^/]+$/i,
};
// A merge path is refused earlier, as a bypass.
const PR_WRITE_PATHS = [API.createPr, API.mergeBranch];
// A flag given no value, or a value the gate cannot read.
const MISSING = Object.freeze({ text: "", dynamic: true });
const READ_METHOD = /^(?:GET|HEAD)$/i;
const methodWrites = (method) => method.dynamic || !READ_METHOD.test(method.text);

// The path a gh api endpoint or an HTTP URL reaches, as the server sees it:
// no scheme, host, query or fragment, percent-decoded, dot segments resolved,
// no trailing slash. "repos/o/r/pulls/5/x/../merge?a=1" -> "/repos/o/r/pulls/5/merge".
export function apiPath(text) {
  let p = text.split(/[?#]/)[0];
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep it as written
  }
  p = path.posix.normalize(`/${p.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "")}`);
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

// Flags that take a value, per subcommand. On `merge`, -r and -m are the
// booleans --rebase and --merge; on `create` they take a value.
const REPO_FLAGS = ["-R", "--repo"];
const VALUE_FLAGS = {
  pr: new Set(REPO_FLAGS),
  merge: new Set([...REPO_FLAGS, "-b", "--body", "-F", "--body-file", "-t", "--subject", "-A", "--author-email",
    "--match-head-commit"]),
  ready: new Set(REPO_FLAGS),
  create: new Set([...REPO_FLAGS, "-b", "--body", "-F", "--body-file", "-t", "--title", "-B", "--base", "-H",
    "--head", "-a", "--assignee", "-l", "--label", "-m", "--milestone", "-p", "--project", "-r", "--reviewer",
    "-T", "--template"]),
};
VALUE_FLAGS.new = VALUE_FLAGS.create;
// gh's own commands and their short names, as of gh 2.103. gh refuses an
// alias with one of these names, so any other first word is an alias or an
// extension, which may run a PR or branch write the gate cannot see. `co` is
// left out: it is an alias, and can be redefined. When gh adds a command,
// add it here.
const GH_COMMANDS = new Set(["agent-task", "agent-tasks", "agent", "agents", "alias", "api", "attestation", "at",
  "auth", "browse", "cache", "codespace", "cs", "completion", "config", "copilot", "credits", "discussion",
  "extension", "extensions", "ext", "gist", "gpg-key", "help", "issue", "label", "licenses", "org", "pr", "preview",
  "project", "release", "repo", "ruleset", "rs", "run", "search", "secret", "skill", "skills", "ssh-key", "status",
  "variable", "version", "workflow", "accessibility", "a11y", "actions", "environment", "exit-codes", "formatting",
  "mintty", "reference", "telemetry"]);
// `gh alias` actions that only read.
const ALIAS_READS = new Set(["list", "ls"]);
const wantsHelp = (texts) => texts.some((t) => t === "--help" || t === "-h");
// True when the words after `gh alias` set, import or delete an alias.
const changesAlias = (rest) => rest.length > 0 && !ALIAS_READS.has(rest[0]) && !wantsHelp(rest);
// True when a gh command whose subcommand may be any of words[at] runs an
// alias or an extension, or changes an alias. The token scans read only the
// alias action, not the rest of the line.
const runsAlias = (words, at) => at.some((k) => /^[a-z][\w-]*$/i.test(words[k])
  && (!GH_COMMANDS.has(words[k]) || (words[k] === "alias" && changesAlias(words.slice(k + 1, k + 2)))));
// `gh repo` actions that change or remove the repository, and what each
// does. The gate asks the user before them, rather than refusing them.
const REPO_ADMIN_DOES = {
  edit: "changes the repository's settings (its default branch, visibility and merge methods among them)",
  rename: "renames the repository, which changes its URL",
  delete: "deletes the repository for good; it cannot be undone",
  archive: "archives the repository, which makes it read-only",
  unarchive: "unarchives the repository, which makes it writable again",
};
const REPO_ADMIN = new Set(Object.keys(REPO_ADMIN_DOES));
// Where the `gh repo` action is in texts, from start on: { at, flagFirst }.
// flagFirst: a flag other than -R/--repo came first, and gh may take the
// next word as its value (`gh repo --description x edit`).
function repoAction(texts, start) {
  let at = start;
  let flagFirst = false;
  while (at < texts.length && texts[at].startsWith("-")) {
    const skip = repoFlagWords(texts[at]);
    if (!skip) flagFirst = true;
    at += skip || 1;
  }
  return { at, flagFirst };
}
// How many `gh repo <action>` in plain text may change or remove the
// repository: an action from REPO_ADMIN, or one after another flag. A token
// scan like prActions. It counts `--help` too, since the rest of the line is
// not this command's.
function repoAdminCount(said) {
  const { words } = scanWords(said);
  let found = 0;
  for (let i = 0; i < words.length; i++) {
    if (!GH_START.test(words[i])) continue;
    const repo = subcommandAt(words, i + 1).find((k) => words[k] === "repo");
    if (repo === undefined) continue;
    const { at, flagFirst } = repoAction(words, repo + 1);
    if (flagFirst || REPO_ADMIN.has(words[at])) found++;
  }
  return found;
}
const repoAdminHints = (text) => repoAdminCount(plain(text));
// Programs that only print or record their words, so `pr merge` in them runs nothing.
const READERS = new Set(["echo", "printf", "cat", "grep", "rg", "man", "less", "head", "tail", "git"]);

// The MCP tools the gate handles, by the last part of the tool name. The
// settings matcher is built from the same list (merge-settings.mjs).
export const MCP_TOOLS = {
  merge_pull_request: "merge",
  enable_auto_merge: "merge",
  enable_pull_request_auto_merge: "merge",
  mark_pr_ready_for_review: "ready",
  mark_pull_request_ready_for_review: "ready",
  update_pull_request: "update",
  create_pull_request: "create",
};
export const MCP_MATCHER = `mcp__.*__(${Object.keys(MCP_TOOLS).join("|")})`;

// The words after `gh pr`: the action word, its flags { get, boolean } and
// the PR selector. Flags may come before the action (`gh pr -R o/r merge 5`).
// -R and --repo are one flag; like gh, the last one wins.
// runtimeWords: the words after the action that the shell builds at run time
// and that are not a flag's value. Any of them may expand to a flag (--admin).
// splitValues: flag values the shell splits (`-t $T`, `-t $(cat f)`), which can
// also become a flag. flagBeforeAction: a flag other than -R sat before the
// action, where gh may read the next word as its value (`gh pr -t x merge`).
function parsePrArgs(words) {
  const flags = new Map();
  const runtimeWords = [];
  const splitValues = [];
  let flagBeforeAction = false;
  let selector = null;
  let action = null;
  for (let i = 0; i < words.length; i++) {
    const { text, dynamic } = words[i];
    const eq = text.startsWith("--") ? text.indexOf("=") : -1;
    const name = eq === -1 ? text : text.slice(0, eq);
    const stored = REPO_FLAGS.includes(name) ? "--repo" : name;
    if ((VALUE_FLAGS[action?.text ?? "pr"] ?? VALUE_FLAGS.pr).has(name)) {
      const value = eq === -1 ? words[++i] ?? MISSING : { text: text.slice(eq + 1), dynamic, splits: words[i].splits };
      if (value.splits) splitValues.push(value);
      flags.set(stored, value);
      continue;
    }
    if (action !== null && expands(words[i])) runtimeWords.push(words[i]);
    if (text.startsWith("-")) {
      if (action === null) flagBeforeAction = true;
      flags.set(stored, eq === -1 ? "true" : text.slice(eq + 1).toLowerCase());
    } else if (action === null) {
      action = words[i];
    } else if (selector === null) {
      selector = words[i];
    }
  }
  return {
    action,
    get: (...names) => names.map((n) => flags.get(REPO_FLAGS.includes(n) ? "--repo" : n)).find((v) => v !== undefined),
    boolean: (...names) => names.some((n) => flags.get(n) === "true"),
    // Given at all, with any value: --admin=false is refused like --admin.
    given: (name) => flags.has(name),
    selector,
    runtimeWords,
    splitValues,
    flagBeforeAction,
    words,
  };
}

// The words after `gh api`: { method, endpoint, fields, input }. gh sends
// GET unless it is given fields or --input; the last -X wins.
const API_VALUE_FLAGS = new Set(["-X", "--method", "-f", "--raw-field", "-F", "--field", "-H", "--header", "--input",
  "-q", "--jq", "-t", "--template", "--hostname", "-p", "--preview", "--cache"]);
// A flag's value as the rest of a word, from index `from`.
const tail = (word, from) => ({ text: word.text.slice(from), dynamic: word.dynamic, splits: word.splits });
// The first value flag in a glued short group, as gh reads it: -iXPUT and
// -X=PUT both give { name: "-X", from } with `from` just past the letter (and
// past one "="). null when the word is not a short group with a value flag.
function shortValueFlag(text) {
  if (!/^-[a-zA-Z]/.test(text)) return null;
  for (let k = 1; k < text.length && /[a-zA-Z]/.test(text[k]); k++) {
    if (API_VALUE_FLAGS.has(`-${text[k]}`)) return { name: `-${text[k]}`, from: text[k + 1] === "=" ? k + 2 : k + 1 };
  }
  return null;
}
function parseApiArgs(words) {
  let method = null;
  let endpoint = null;
  let input = false;
  let help = false;
  const fields = [];
  // hidden: run-time words that may carry a flag (-X PUT) the gate cannot see.
  const hidden = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const { text } = word;
    let name = text;
    let value;
    const eq = text.startsWith("--") ? text.indexOf("=") : -1;
    const short = shortValueFlag(text);
    if (eq !== -1 && API_VALUE_FLAGS.has(text.slice(0, eq))) {
      name = text.slice(0, eq);
      value = tail(word, eq + 1);
    } else if (API_VALUE_FLAGS.has(text)) {
      value = words[++i] ?? MISSING;
    } else if (short !== null) {
      name = short.name; // glued: -XPUT, -X=PUT, -Fquery=@q.graphql, -iXPUT
      value = short.from < text.length ? tail(word, short.from) : words[++i] ?? MISSING;
    } else {
      if (text === "--help" || text === "-h") help = true;
      else if (!text.startsWith("-") && endpoint === null) {
        endpoint = word;
        if (word.splits) hidden.push(word);
      } else if (!text.startsWith("-") && expands(endpoint ?? word) && endpoint !== null) {
        // A run-time word before the endpoint was a flag, not the endpoint.
        if (!hidden.includes(endpoint)) hidden.push(endpoint);
      } else if (expands(word)) {
        hidden.push(word);
      }
      continue;
    }
    if (value.splits) hidden.push(value);
    if (name === "-X" || name === "--method") method = value.dynamic ? "?" : value.text.toUpperCase();
    else if (name === "--input") input = true;
    else if (["-f", "--raw-field", "-F", "--field"].includes(name)) {
      fields.push({ ...value, fromFile: name === "-F" || name === "--field" });
    }
  }
  return { method: method ?? (fields.length || input ? "POST" : "GET"), endpoint, fields, input, help, hidden };
}

// True when the gate can read the query of a `gh api graphql` call: no
// --input body, and a query field given inline, not from a file (`-F
// query=@file`), stdin or a variable.
function graphqlQueryReadable(api) {
  if (api.input) return false;
  return api.fields.every((field) => {
    const name = /^([\w-]+)(?:\[[^\]]*\])*=/.exec(field.text)?.[1];
    if (name === undefined) return false;
    return name !== "query" || !(field.dynamic || (field.fromFile && field.text.startsWith("query=@")));
  });
}

// One HTTP request an HTTP client makes: { writes, urls, headers, unread }.
// writes: a method other than GET or HEAD. unread: options that hide the
// request from the command line (curl -K, --next).
const CURL_LONG_VALUES = new Set(["--header", "--data", "--data-raw", "--data-binary", "--data-urlencode",
  "--data-ascii", "--json", "--form", "--form-string", "--upload-file", "--user", "--output", "--user-agent",
  "--referer", "--cookie", "--cookie-jar", "--proxy", "--write-out", "--max-time", "--connect-timeout", "--retry",
  "--config", "--request", "--url", "--expand-data", "--expand-json", "--expand-url", "--variable", "--range",
  "--cert", "--cacert", "--key", "--resolve", "--connect-to", "--oauth2-bearer", "--unix-socket", "--dump-header"]);
const CURL_SHORT_VALUES = "XHdFTuoAebcxwmKrEzDQCYy";
function curlRequest(call) {
  const methods = [];
  const urls = [];
  const headers = [];
  let body = false;
  let get = false;
  let head = false;
  let unread = false;
  const words = call.args;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const { text } = word;
    let name = null;
    let value;
    if (text === "--next" || text === "-:") {
      unread = true;
    } else if (text === "--get") {
      get = true;
    } else if (text === "--head") {
      head = true;
    } else if (text.startsWith("--")) {
      if (CURL_LONG_VALUES.has(text)) [name, value] = [text, words[++i]];
    } else if (text.startsWith("-") && text.length > 1) {
      for (let k = 1; k < text.length && name === null; k++) {
        const ch = text[k];
        if (CURL_SHORT_VALUES.includes(ch)) {
          name = `-${ch}`;
          value = k + 1 < text.length ? { text: text.slice(k + 1), dynamic: word.dynamic } : words[++i];
        } else if (ch === "G") get = true;
        else if (ch === "I") head = true;
        else if (ch === ":") unread = true;
      }
    } else {
      urls.push(word);
    }
    if (name === null) continue;
    value ??= MISSING;
    if (name === "-X" || name === "--request") methods.push(value);
    else if (name === "-H" || name === "--header") headers.push(value);
    else if (name === "--url" || name === "--expand-url") urls.push(value);
    else if (name === "--variable") unread = true; // {{name}} in a URL is filled in by curl
    else if (name === "-K" || name === "--config") unread = true;
    else if (/^-[dFT]$|^--(?:data|json|form|upload-file|expand-data|expand-json)/.test(name)) body = true;
  }
  const method = methods.at(-1);
  const writes = method ? methodWrites(method) : body && !get && !head;
  return { writes, urls, headers, unread };
}

// wget: --method, or a POST body option.
function wgetRequest(call) {
  const urls = [];
  let method = null;
  let body = false;
  let unread = false;
  const words = call.args;
  for (let i = 0; i < words.length; i++) {
    const { text, dynamic } = words[i];
    if (["-i", "--input-file", "-e", "--execute"].includes(text) || /^--(?:input-file|execute)=/.test(text)) unread = true;
    if (text === "--method") method = words[++i] ?? MISSING;
    else if (text.startsWith("--method=")) method = { text: text.slice(9), dynamic };
    else if (/^--(?:post|body)-(?:data|file)\b/.test(text)) body = true;
    else if (!text.startsWith("-")) urls.push(words[i]);
  }
  return { writes: method ? methodWrites(method) : body, urls, headers: [], unread };
}

// HTTPie and xh: `http [flags] [METHOD] URL [items]`. Data items (a=b,
// a:=b, a@file) make a POST; a==b is a query parameter.
const HTTP_METHODS = /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/i;
const HTTPIE_VALUE_FLAGS = new Set(["-a", "--auth", "-A", "--auth-type", "-o", "--output", "--session",
  "--session-read-only", "-p", "--print", "--verify", "--cert", "--cert-key", "--proxy", "--timeout",
  "--max-redirects", "-s", "--style", "--pretty", "--format-options", "--boundary", "--bearer"]);
function httpieRequest(call) {
  const words = [];
  for (let i = 0; i < call.args.length; i++) {
    const { text } = call.args[i];
    if (HTTPIE_VALUE_FLAGS.has(text)) i++;
    else if (!text.startsWith("-")) words.push(call.args[i]);
  }
  const method = words[0] && HTTP_METHODS.test(words[0].text) ? words.shift() : null;
  const url = words.shift();
  const items = words.some((w) => /^[^=:@]*(?::=|=(?!=)|@)/.test(w.text) && !/^[^=:@]*==/.test(w.text));
  return { writes: method ? methodWrites(method) : items, urls: url ? [url] : [], headers: [], unread: false };
}

// An HTTP client call against the GitHub API: a write that merges or opens a
// PR, and any GitHub GraphQL call, are refused. The gate cannot read an HTTP
// body, and gh does all three in a form it can check. A write whose URL it
// cannot read is refused when the URL names GitHub, and otherwise counts as
// unread (bashCheck refuses it when the line names a PR write).
function classifyHttp(request, call) {
  const github = (u) => /github/i.test(u.text) || request.headers.some((h) => /github/i.test(h.text));
  if (request.urls.some((u) => API.graphql.test(apiPath(u.text)) && (u.dynamic || github(u)))) {
    return refuse("it cannot read a GitHub GraphQL call made with an HTTP client. Use gh api graphql with the query inline: -f query='...'.");
  }
  if (!request.writes) return null;
  const hits = (re) => request.urls.some((u) => re.test(apiPath(u.text)));
  if (hits(API.mergePr)) return refuseRestMerge();
  if (hits(API.branchWrite)) return refuseBranchWrite();
  if (PR_WRITE_PATHS.some(hits)) {
    return refuse("it cannot read an HTTP call that merges or opens a PR. Use gh pr merge or gh pr create.");
  }
  const unreadUrls = request.urls.filter((u) => expands(u) || /[{[]/.test(u.text));
  if (unreadUrls.some(github)) {
    return refuse("it cannot read which GitHub URL this HTTP write goes to. Write the URL out in full, or use gh.");
  }
  return request.unread || unreadUrls.length > 0 || call.wrappers.includes("xargs")
    ? { kind: "unread", what: `which URL this \`${call.program.text}\` call writes to` }
    : null;
}

// A call the user approves first: { kind: "ask", reason }.
const ask = (reason) => ({ kind: "ask", reason });
const REPO_ASK = (action) => `\`gh repo ${action}\` ${REPO_ADMIN_DOES[action]}, so the review gate asks you first.`;
const REPO_UNREAD_ASK = (what) => `The review gate cannot read ${what}, and it may be a \`gh repo\` command that changes or removes the repository (edit, rename, delete, archive or unarchive), so it asks you first.`;

// A refusal about how the command is written, not about the record.
// bypass: a write past branch protection or around it (an admin or REST
// merge, a branch or settings write), which no record or rewording clears.
const refuse = (reason, bypass = false) => ({ kind: "refuse", reason, bypass });

// A merge that bypasses branch protection. Never needed: when checks fail or a
// branch rule blocks the merge, the agent stops and the owner decides.
const BYPASS_NEXT = "Never bypass branch protection. If a plain `gh pr merge` is refused because checks fail or a branch rule blocks it, stop and ask the owner, and say what blocks it; do not look for another way around it. The owner can fix the check or the rule, or merge the PR themselves on GitHub.";
const ADMIN_REASON = `\`gh pr merge --admin\` (even \`--admin=false\`) is refused: the flag merges past required checks and branch rules. Remove \`--admin\`. ${BYPASS_NEXT}`;
const REST_MERGE_REASON = `a merge through the REST API skips the branch protection check that gh pr merge makes, the same bypass as \`--admin\`. Run a plain \`gh pr merge\` instead (no \`--admin\`). ${BYPASS_NEXT}`;
const BRANCH_WRITE_REASON = "a GitHub API write that moves, deletes or renames a branch, commits to it directly, or changes branch protection, a ruleset or the repository's settings. Push with git from your worktree, delete a remote branch with `git push origin --delete <branch>`, and land changes through a PR merged with a plain `gh pr merge`. Protection, rulesets and repository settings are the owner's: if you need a change there, stop and ask the owner, and say what you need. Never bypass branch protection.";
const ALIAS_REASON = "a gh alias change (`gh alias set`, `import` or `delete`). An alias runs a gh command the gate cannot see, which may merge a PR past it. Write every gh command out in full. If you need an alias, stop and ask the owner.";
const NOT_GH_COMMAND = (word) => `\`gh ${word}\` is not a gh command, so gh runs it as an alias or an extension, which may merge a PR past the gate. Write the gh command out in full (\`gh pr checkout 5\`, not \`gh co 5\`). If you need an alias or an extension, stop and ask the owner; the owner can run it outside the agent. If \`${word}\` is a gh command newer than gh 2.103, tell the owner, because the gate's command list needs it.`;
const refuseAdmin = () => refuse(ADMIN_REASON, true);
const refuseRestMerge = () => refuse(REST_MERGE_REASON, true);
const refuseBranchWrite = () => refuse(BRANCH_WRITE_REASON, true);
// True when text that names a PR merge also names --admin.
const namesAdminMerge = (said) => /(?:^|[^\w-])--admin(?![\w-])/.test(said) && /\bmerge\b/.test(said);
// A call the gate cannot read: { kind: "unread", what }. bashCheck refuses
// it only when the line names a PR write the gate did not read elsewhere.
const unread = (what) => ({ kind: "unread", what });

// gh: `gh pr merge|ready|create|new`, and `gh api` merges, PR opens and GraphQL.
function classifyGh(call) {
  const text = call.args.map((w) => w.text);
  if (text.length === 1 && wantsHelp(text)) return null;
  if (call.args[0] && expands(call.args[0])) return refuse("it cannot read which gh command this is. Write the gh subcommand out in full.");
  // xargs adds words gh reads: the subcommand, an alias action, or a gh api method or endpoint.
  const xargs = call.wrappers.includes("xargs");
  if (xargs && (text.length === 0 || (text[0] === "alias" && text.length === 1) || (text[0] === "api" && !wantsHelp(text)))) {
    return refuse("it cannot read which gh command xargs builds. Write the gh command out in full.");
  }
  // gh finds the subcommand past leading flags (`gh -R o/r pr merge 5`), and the gate does not follow it.
  const leading = text[0]?.startsWith("-") ? subcommandAt(text, 0) : null;
  if (leading?.some((k) => ["pr", "api", "alias"].includes(text[k]) || !GH_COMMANDS.has(text[k]) || expands(call.args[k]))) {
    return refuse("it cannot tell which gh command this is when flags come before the subcommand. Write the subcommand first and the flags after it (`gh pr merge 5 -R o/r`).");
  }
  if (text[0] === "alias" && changesAlias(text.slice(1))) return refuse(ALIAS_REASON);
  if (text[0] !== undefined && !text[0].startsWith("-") && !GH_COMMANDS.has(text[0])) return refuse(NOT_GH_COMMAND(text[0]));
  // `gh repo` after any leading flags (`gh -R o/r repo delete`).
  const sub = leading ? leading[0] : 0;
  if (call.args[sub]?.text === "repo") {
    const found = classifyGhRepo(call.args.slice(sub + 1), xargs);
    if (found) return found;
  }
  if (xargs && !(text[0] === "pr" || text[0] === "api")) return unread("the gh command xargs builds");
  if (text[0] === "pr") return classifyGhPr(call);
  if (text[0] === "api") return classifyGhApi(call);
  return null;
}

// The words after `gh repo`: an ask when the action changes or removes the
// repository, or cannot be read (built at run time, left to xargs, or after
// a flag that may take it as its value).
function classifyGhRepo(words, xargs) {
  const texts = words.map((w) => w.text);
  if (wantsHelp(texts)) return null;
  const { at, flagFirst } = repoAction(texts, 0);
  const action = words[at];
  if (action === undefined) return xargs ? ask(REPO_UNREAD_ASK("which `gh repo` action xargs builds")) : null;
  if (flagFirst) return ask(REPO_UNREAD_ASK("which `gh repo` action this is when a flag comes before it"));
  if (expands(action)) return ask(REPO_UNREAD_ASK("the `gh repo` action, which is built at run time"));
  return REPO_ADMIN.has(action.text) ? ask(REPO_ASK(action.text)) : null;
}

const unreadMergeWord = (word, why) =>
  `it cannot read ${word.text ? `\`${word.text}\`` : "a word built at run time"} in this gh pr command: ${why}. Write the PR number and every flag out in full${word.splits && !/\$@|\[@\]/.test(word.text) ? ', or put a flag value in double quotes' : ''}.`;

function classifyGhPr(call) {
  const pr = parsePrArgs(call.args.slice(1));
  if (pr.action && expands(pr.action)) {
    return refuse("it cannot read which gh pr action this is. Write the action (merge, view, ...) out in full.");
  }
  // `gh pr -t x merge`: gh may read the flag's next word as its value and still find the action.
  if (pr.flagBeforeAction && !PR_ACTIONS.includes(pr.action?.text) && pr.words.some((w) => PR_ACTIONS.includes(w.text) || expands(w))) {
    return refuse("it cannot tell where the gh pr action is when a flag comes before it. Write the action right after `gh pr`, then the flags.");
  }
  // The bypass reason wins over the rewrite reason, so --admin is checked before the unreadable words.
  if (pr.action?.text === "merge" && pr.given("--admin") && !pr.boolean("--help", "-h")) return refuseAdmin();
  if ((pr.action === null || pr.action.text === "merge") && pr.splitValues.length > 0) {
    return refuse(unreadMergeWord(pr.splitValues[0], "the shell splits it and the parts may include `--admin`"));
  }
  const xargs = call.wrappers.includes("xargs");
  if (xargs && pr.action === null && !pr.boolean("--help", "-h")) {
    return refuse("it cannot read which gh pr action xargs builds. Run gh with the action and the PR number written out.");
  }
  if (!PR_ACTIONS.includes(pr.action?.text) || pr.boolean("--help", "-h")) return null;
  if (xargs) {
    return refuse("it cannot read a PR command whose arguments come from xargs. Run gh with the PR number written out.");
  }
  const action = pr.action.text;
  if (action === "merge") {
    if (pr.runtimeWords.length > 0) return refuse(unreadMergeWord(pr.runtimeWords[0], "the shell builds it at run time and it may expand to `--admin`"));
  }
  // A PR URL names its repo, whatever -R says.
  const url = pr.selector && !pr.selector.dynamic ? /^(.*github\.com\/[^/]+\/[^/]+)\/pull\/\d+/i.exec(pr.selector.text) : null;
  const fromUrl = url ? repoKey(url[1]) ?? url[1] : undefined;
  const ghRepo = call.env.GH_REPO;
  const repo = fromUrl
    ? { text: fromUrl, dynamic: false }
    : pr.get(...REPO_FLAGS) ?? (ghRepo !== undefined ? { text: ghRepo ?? "", dynamic: ghRepo === null } : null);
  if (action === "create" || action === "new") return { kind: "create", pr, repo };
  if (action === "ready" && pr.boolean("--undo")) return null;
  return { kind: "remote", what: `\`gh pr ${action}\``, selector: pr.selector, repo, host: call.env.GH_HOST };
}

function classifyGhApi(call) {
  const said = plain(wordsText(call));
  if (MERGE_MUTATIONS.test(said)) {
    return refuse("it cannot check a GraphQL mutation that merges, opens or readies a PR. Use gh pr merge, gh pr ready or gh pr create.");
  }
  const api = parseApiArgs(call.args.slice(1));
  if (api.help) return null;
  if (api.hidden.length > 0) {
    return refuse(`it cannot read \`${api.hidden[0].text || "a word built at run time"}\` in this gh api call, and the shell may turn it into \`-X PUT\` or another flag. Write the method and the endpoint out in full, and quote any value.`);
  }
  if (!api.endpoint) return null;
  if (expands(api.endpoint)) {
    return READ_METHOD.test(api.method) ? null : refuse("it cannot tell which endpoint this gh api write goes to. Write the endpoint out in full.");
  }
  const where = apiPath(api.endpoint.text);
  if (API.graphql.test(where)) {
    if (BRANCH_MUTATIONS.test(said)) return refuseBranchWrite();
    return graphqlQueryReadable(api) ? null
      : refuse("it cannot read a GraphQL query from a file, stdin or a variable. Pass it inline with -f query='...'.");
  }
  if (READ_METHOD.test(api.method)) return null;
  if (API.branchWrite.test(where)) return refuseBranchWrite();
  if (API.createPr.test(where)) return refuse("it cannot check a PR opened through gh api. Use gh pr create.");
  if (API.mergeBranch.test(where)) return refuse("it cannot check a branch merge through gh api. Use gh pr merge.");
  // gh pr merge refuses a merge that branch protection blocks unless given
  // --admin; the REST endpoint has no such check, so with admin rights it is
  // the same bypass.
  if (API.mergePr.test(where)) {
    return refuseRestMerge();
  }
  return null;
}

// Any other program: one that is handed a PR command as text (python -c,
// node -e, alias, a wrapper the walk does not know) is refused.
function classifyOther(call, prog) {
  if (prog === null) return unread("a command whose program is built at run time");
  if (prog === "git") {
    const found = classifyGitConfig(call);
    if (found) return found;
  }
  if (READERS.has(prog)) return null;
  const said = plain(wordsText(call));
  if (!namesWrite(said)) {
    return repoAdminCount(said) > 0 ? ask(REPO_UNREAD_ASK("a gh command run through another program")) : null;
  }
  return namesAdminMerge(said) ? refuse(`${ADMIN_REASON} Run gh directly, not through another program.`, true) : refuse("it cannot read a gh or GitHub API command run through another program. Run gh directly, in its own Bash call.");
}

// The config a git call sets, as [{ key, value }]: `-c key=value`,
// `git config [options] key value`, and `--config-env key=VAR` (either
// spelling), whose value comes from the environment (value null).
function gitConfigSets(call) {
  const words = call.args;
  const isConfig = words.some((w) => w.text === "config");
  const sets = [];
  for (let i = 0; i < words.length; i++) {
    const text = plain(words[i].text);
    const env = /^--config-env(?:=(.*))?$/i.exec(text);
    if (env) {
      const key = env[1] !== undefined ? { text: env[1], dynamic: words[i].dynamic } : words[i + 1];
      if (key) sets.push({ key, value: null });
      if (env[1] === undefined) i++;
      continue;
    }
    const pair = /^([a-z][\w-]*(?:\.[^=\s]+)?\.[\w-]+)=(.*)$/is.exec(text);
    if (pair) sets.push({ key: { text: pair[1], dynamic: false }, value: { text: pair[2], dynamic: words[i].dynamic } });
    else if (isConfig && /^[a-z][\w-]*\.\S+$/i.test(text) && words[i + 1]) sets.push({ key: { text, dynamic: false }, value: words[i + 1] });
  }
  return sets;
}

// git config that runs a command the gate cannot read: an alias whose value
// may run a shell command (`!...`) or set another alias, any alias from the
// environment, or a value (core.pager, core.sshCommand, an alias) that names
// a gh write.
function classifyGitConfig(call) {
  for (const { key, value } of gitConfigSets(call)) {
    const isAlias = expands(key) || /^alias\./i.test(plain(key.text));
    const said = value ? plain(value.text) : "";
    if (isAlias && (value === null || expands(value) || /!|alias\.|--config-env/i.test(said))) {
      return refuse("it cannot read what a git shell alias (a value that starts with `!`, or one read from the environment) runs, and it may run gh. Run the command directly, not through a git alias.");
    }
    if (value && (namesWrite(said) || repoAdminCount(said) > 0)) {
      return refuse(`it cannot read a gh command that git runs from its config (\`${plain(key.text)}\`). Run gh directly, in its own Bash call.`);
    }
  }
  return null;
}

// The HTTP clients the gate reads, by program name.
const HTTP_CLIENTS = { curl: curlRequest, wget: wgetRequest, http: httpieRequest, https: httpieRequest, xh: httpieRequest, xhs: httpieRequest };
const CLASSIFIERS = {
  gh: classifyGh,
  ...Object.fromEntries(Object.entries(HTTP_CLIENTS).map(([prog, request]) => [prog, (call) => classifyHttp(request(call), call)])),
};

// Classify one simple command into the PR operation it makes, or null:
//   { kind: "create", pr, repo }               gh pr create / new, draft or not
//   { kind: "remote", what, selector, repo }   a gh pr merge or ready of an existing PR
//   { kind: "refuse", reason, bypass }         a form the gate refuses
//   { kind: "unread", what }                   a command the gate cannot read
//   { kind: "ask", reason }                    a command the user approves first
function classify(call, shell) {
  const prog = shell.nameOf(call);
  const byProgram = CLASSIFIERS[prog];
  return byProgram ? byProgram(call) : classifyOther(call, prog);
}

// Options whose value a read call prints rather than runs (gh -q '"gh pr merge 5"'
// | sh prints a PR command). Their text does not count as read.
const PRINTED_VALUES = new Set(["-q", "--jq", "-t", "--template"]);
function readText(call) {
  const kept = [call.program];
  for (let i = 0; i < call.args.length; i++) {
    const { text } = call.args[i];
    if (PRINTED_VALUES.has(text)) i++;
    else if (!/^(?:--jq|--template)=/.test(text)) kept.push(call.args[i]);
  }
  return kept.map((w) => w.text).join(" ");
}

// Hints in the line as the shell splits it: every word of every command,
// assignments and heredoc bodies included. Counted both ways, so text the
// lexer drops (a redirection target) or joins ($(true)) cannot pad the
// read count past the line's.
function lineHints(command, shell, count = hintCount) {
  let total = 0;
  for (const item of shell.lex(command)) {
    if (item.type !== "cmd") continue;
    total += count(item.words.map((w) => w.text).join(" "));
    for (const doc of item.heredocs) total += count(doc.body);
  }
  return Math.max(total, count(command));
}

// A refusal the walk could not read: what it could not read, and the way out.
// adminHidden: the line also names a `gh pr merge --admin`, which is never allowed.
const unreadRefusal = (what, adminHidden = false) =>
  formRefusal(`it cannot read ${what}, and this line names a PR write that it did not read in a plain gh or HTTP call. Run that part in its own Bash call, then run any gh PR command on its own, written out in full. If the line has no PR write, the trigger is text that looks like one (a commit message, an echo): run that text in its own Bash call.${adminHidden ? ` If the line runs \`gh pr merge --admin\`, that is never allowed. ${BYPASS_NEXT}` : ""}`);

// "owner/name", lower case, for any spelling of a github.com repo: owner/name,
// with a trailing .git or /, github.com/owner/name, an https or ssh URL, or
// git@github.com:owner/name.git. GitHub names ignore case. null for anything
// else, another host included. With requireHost, a bare owner/name (which a
// git remote would read as a local path) is null too.
function repoKey(text, { requireHost = false } = {}) {
  let bare = text.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^[^@/]*@/, "");
  const hosted = /^(?:www\.)?github\.com(?::\d+)?[/:]/.exec(bare);
  if (requireHost && !hosted) return null;
  if (hosted) bare = bare.slice(hosted[0].length);
  while (bare.endsWith("/")) bare = bare.slice(0, -1);
  if (bare.endsWith(".git")) bare = bare.slice(0, -4);
  return /^[\w.-]+\/[\w.-]+$/.test(bare) ? bare : null;
}

function thisRepo(cwd) {
  try {
    const url = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return repoKey(url, { requireHost: true });
  } catch {
    return null;
  }
}

// True only when the command names, as plain text, a github.com repo that is
// not this one. Any spelling of this repo, or one it cannot read, is checked.
function isAnotherRepo(repo, cwd) {
  if (!repo || repo.dynamic) return false;
  const named = repoKey(repo.text);
  const own = thisRepo(cwd);
  return own !== null && named !== null && named !== own;
}

function fetchBody(selector, repo, cwd, host) {
  if (selector?.dynamic) throw new Error("the PR is chosen at run time, so the gate cannot read it");
  if (repo?.dynamic) throw new Error("the repo is chosen at run time, so the gate cannot read the PR");
  if (host === null) throw new Error("GH_HOST is set at run time, so the gate cannot read the PR");
  const args = ["pr", "view", ...(selector ? [selector.text] : []), "--json", "body", "-q", ".body"];
  if (repo) args.push("-R", repo.text);
  const env = host === undefined ? process.env : { ...process.env, GH_HOST: host };
  try {
    return execFileSync("gh", args, { cwd, env, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(`\`gh ${args.join(" ")}\` failed: ${String(error.stderr ?? error.message).trim()}`);
  }
}

// The body of a `gh pr create`: { body } or { problem }.
function createBody(pr, dir) {
  const body = pr.get("-b", "--body");
  const file = pr.get("-F", "--body-file");
  if (body && file) return { problem: "both --body and --body-file are given" };
  if (body) {
    return body.dynamic
      ? { problem: "the --body is built at run time; use --body-file or a quoted heredoc" }
      : { body: body.text };
  }
  if (file && !file.dynamic && file.text !== "-" && dir !== null) {
    try {
      return { body: fs.readFileSync(path.resolve(dir, file.text), "utf8") };
    } catch {
      return { problem: `cannot read --body-file ${file.text}` };
    }
  }
  return { problem: "the gate cannot read this PR body (use --body-file <path>)" };
}

// The refusal for one operation, or null. dir is where it runs; when a cd
// could not be followed it is null and the session's cwd stands in.
function problemFor(op, dir, cwd) {
  if (op.kind === "refuse") return op.bypass ? bypassRefusal(op.reason) : formRefusal(op.reason);
  const where = dir ?? cwd;
  if (isAnotherRepo(op.repo, where)) return null;
  if (op.kind === "create") {
    const got = createBody(op.pr, dir);
    const found = got.problem ? [got.problem] : recordProblems(got.body);
    return found.length ? refusal(OPENING_PR, found) : null;
  }
  try {
    const found = recordProblems(fetchBody(op.selector, op.repo, where, op.host));
    return found.length ? refusal(op.what, found, FINISH_OPEN_PR) : null;
  } catch (error) {
    return refusal(op.what, [error.message], FINISH_OPEN_PR);
  }
}

// A refusal about how a command is written. A Review record does not clear it.
const formRefusal = (reason) =>
  `Refused by the review gate: ${reason}\nThis is about how the command is written; a complete Review record does not change it.`;

const bypassRefusal = (reason) => `Refused by the review gate: ${reason}\nA Review record does not clear this, and neither does writing the bypass another way.`;

// Every reason to refuse a Bash command, and every reason to ask the user
// first: { problems, asks }. Both empty allows it; any problem refuses it,
// whatever the asks. shell is agent-hook-shell.mjs, passed in so it loads
// inside main's try.
//
// A call the gate cannot read (an eval or sh -c script built at run time, a
// script piped into a shell, a program built at run time) is refused only
// when the line names more PR writes than the gh and HTTP calls the gate did
// read. So `eval "$(ssh-agent -s)" && gh pr merge 5` is checked like the
// merge alone, and `X='gh pr merge 5'; eval "$X"` is refused.
// The same count, for `gh repo` commands that change the repository, asks
// instead: `X='gh repo delete o/r'; eval "$X"` asks the user.
const refused = (reason) => ({ problems: [formRefusal(reason)], asks: [] });
const asking = (reason) => ({ problems: [], asks: [reason] });
export function bashCheck(command, cwd, shell) {
  const none = { problems: [], asks: [] };
  if (!MAY_CONCERN.test(plain(command))) return none;
  if (command.length > MAX_LINE) {
    // Only linear scans here: hints, the word gh, an HTTP client next to GitHub.
    const risky = hintCount(command) > 0 || /\bgh\b/.test(command)
      || (/\b(?:curl|wget|https?|xh|xhs)\b/.test(command) && /github/i.test(command));
    return risky ? refused("this command is too long for it to check, and it may write to a PR. Split it into shorter Bash calls.") : none;
  }
  let steps;
  let total;
  let repoTotal;
  try {
    steps = [...shell.walk(command, cwd)];
    total = lineHints(command, shell);
    repoTotal = lineHints(command, shell, repoAdminHints);
  } catch {
    if (hintCount(command) > 0) {
      return refused("it cannot parse this command, and the command may write to a PR. Split it into simpler Bash calls, and run the gh PR command on its own.");
    }
    return repoAdminHints(command) > 0 ? asking(REPO_UNREAD_ASK("this command")) : none;
  }
  const ops = steps.map((step) => ({
    step,
    op: step.opaque ? unread(`the script that \`${shell.nameOf(step.call) ?? "this command"}\` runs`) : classify(step.call, shell),
  }));
  const readCalls = ops.filter(({ step, op }) => op?.kind !== "unread" && CLASSIFIERS[shell.nameOf(step.call)]);
  const countRead = (count) => readCalls.reduce((n, { step }) => n + count(readText(step.call)), 0);
  const hidden = total > countRead(hintCount);
  const anyUnread = ops.some(({ op }) => op?.kind === "unread");
  const adminHidden = namesAdminMerge(plain(command));
  const problems = ops
    .map(({ step, op }) => {
      if (op?.kind === "unread") return hidden ? unreadRefusal(op.what, adminHidden) : null;
      if (op?.kind === "ask") return null;
      return op && problemFor(op, step.dir, cwd);
    })
    .filter(Boolean);
  const asks = ops.filter(({ op }) => op?.kind === "ask").map(({ op }) => op.reason);
  if (anyUnread && repoTotal > countRead(repoAdminHints)) asks.push(REPO_UNREAD_ASK("part of this line"));
  return { problems: [...new Set(problems)], asks: [...new Set(asks)] };
}

// Every reason to refuse an MCP tool call. An empty list allows it.
export function mcpProblems(toolName, input) {
  const action = MCP_TOOLS[toolName.split("__").pop()];
  if (action === "merge") return ["Merging through an MCP tool is refused; use `gh pr merge`, which the review gate can check."];
  if (action === "ready" || (action === "update" && input?.draft === false)) {
    return ["Taking a PR out of draft through an MCP tool is refused; use `gh pr ready`."];
  }
  if (action === "create") {
    const found = recordProblems(typeof input?.body === "string" ? input.body : "");
    return found.length ? [refusal(OPENING_PR, found)] : [];
  }
  return [];
}

// main reads stdin and refuses by itself, rather than with agent-hook-shell's
// readPayload and refuse, so it still refuses when that module is missing.
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return;
  }
  const tool = typeof payload?.tool_name === "string" ? payload.tool_name : "";
  const command = payload?.tool_input?.command;
  const concerns = tool === "Bash" ? typeof command === "string" && MAY_CONCERN.test(plain(command)) : tool.startsWith("mcp__");
  if (!concerns) return;
  let problems;
  let asks = [];
  try {
    // Loaded here, so a missing shell module refuses instead of exiting 1,
    // which Claude Code would treat as allow.
    const shell = await import("./agent-hook-shell.mjs");
    if (tool === "Bash") ({ problems, asks } = bashCheck(command, payload.cwd ?? process.cwd(), shell));
    else problems = mcpProblems(tool, payload.tool_input ?? {});
  } catch (error) {
    problems = [`review-gate: the hook failed while checking a PR operation, so it refuses: ${error?.stack ?? error}`];
  }
  if (problems.length) {
    process.stderr.write(`${problems.join("\n\n")}\n`);
    process.exitCode = 2;
  } else if (asks.length) {
    // Claude Code shows the user a permission prompt with this reason.
    const decision = { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: asks.join("\n\n") };
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: decision })}\n`);
  }
}

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
const started = Boolean(process.argv[1]) && real(process.argv[1]) === real(fileURLToPath(import.meta.url));
if (started) {
  main().catch((error) => {
    // Only reachable before the call is classified: allow, or every Bash call would fail.
    process.stderr.write(`review-gate: hook crashed before classifying the call, allowing it: ${error}\n`);
  });
}
