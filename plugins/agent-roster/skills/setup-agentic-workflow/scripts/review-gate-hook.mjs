#!/usr/bin/env node
// PreToolUse hook for Bash and for the PR tools of MCP servers. Refuses to
// open a PR (draft or not), take it out of draft, or merge it, unless its
// body carries a complete `## Review` record (docs/agents/review-gate.md).
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
  // "#123" for GitHub, "SPOT-42" or similar elsewhere. It must hold a digit and only letters, digits and # . _ -.
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
const NAMES_PR_OP = new RegExp(`\\bpr\\s+(?:${PR_ACTIONS.join("|")})\\b`);
const MAY_CONCERN = /\bgh\b|pulls\/|graphql|\bpr\b/;
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
// Programs that only print or record their words, so `pr merge` in them runs nothing.
const READERS = new Set(["echo", "printf", "cat", "grep", "rg", "man", "less", "head", "tail", "git"]);
const MERGE_MUTATIONS =
  /\b(mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|markPullRequestReadyForReview|createPullRequest|mergeBranch)\b/;

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

// The words after `gh pr`: the action, its flags { get, boolean } and the
// PR selector. Flags may come before the action (`gh pr -R o/r merge 5`).
function parsePrArgs(words) {
  const flags = new Map();
  let selector = null;
  let action = null;
  for (let i = 0; i < words.length; i++) {
    const { text, dynamic } = words[i];
    const eq = text.startsWith("--") ? text.indexOf("=") : -1;
    const name = eq === -1 ? text : text.slice(0, eq);
    if ((VALUE_FLAGS[action ?? "pr"] ?? VALUE_FLAGS.pr).has(name)) {
      flags.set(name, eq === -1 ? words[++i] ?? { text: "", dynamic: true } : { text: text.slice(eq + 1), dynamic });
    } else if (text.startsWith("-")) {
      flags.set(name, eq === -1 ? "true" : text.slice(eq + 1).toLowerCase());
    } else if (action === null) {
      action = text;
    } else if (selector === null) {
      selector = words[i];
    }
  }
  return {
    action,
    get: (...names) => names.map((n) => flags.get(n)).find((v) => v !== undefined),
    boolean: (...names) => names.some((n) => flags.get(n) === "true"),
    selector,
  };
}

// The HTTP method of a `gh api` call. gh sends GET unless fields are given.
function apiMethod(text) {
  const at = text.findIndex((t) => t === "-X" || t === "--method");
  if (at !== -1 && text[at + 1]) return text[at + 1].toUpperCase();
  const joined = text.map((t) => /^(?:-X|--method=)(\w+)$/.exec(t)?.[1]).find(Boolean);
  if (joined) return joined.toUpperCase();
  return text.some((t) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(t)) ? "POST" : "GET";
}

// Classify one simple command into the PR operation it makes, or null:
//   { kind: "create", pr, repo }               gh pr create / new, draft or not
//   { kind: "remote", what, selector, repo }   a merge or ready of an existing PR
//   { kind: "refuse", reason }                 a form the gate cannot read
function classify(call, shell) {
  const prog = shell.nameOf(call);
  const text = call.args.map((w) => w.text);
  const namesOp = text.some((t, i) => t === "pr" && PR_ACTIONS.includes(text[i + 1]));
  if (prog !== "gh") {
    return namesOp && !READERS.has(prog)
      ? { kind: "refuse", reason: "the gate cannot read a PR command run through another program or a variable; run gh directly" }
      : null;
  }
  if (text.includes("--help") || text.includes("-h")) return null;
  if (text[0] === "pr") {
    const pr = parsePrArgs(call.args.slice(1));
    if (!PR_ACTIONS.includes(pr.action)) return null;
    if (call.wrappers.includes("xargs")) {
      return { kind: "refuse", reason: "the gate cannot read a PR command whose arguments come from xargs" };
    }
    const repo = pr.get(...REPO_FLAGS) ?? null;
    if (pr.action === "create" || pr.action === "new") return { kind: "create", pr, repo };
    if (pr.action === "ready" && pr.boolean("--undo")) return null;
    return { kind: "remote", what: `\`gh pr ${pr.action}\``, selector: pr.selector, repo };
  }
  if (text[0] === "api") {
    if (MERGE_MUTATIONS.test(text.join(" "))) {
      return { kind: "refuse", reason: "GraphQL PR merge, ready and create mutations are refused; use gh pr merge, ready or create" };
    }
    const createPath = call.args.some((w) => /(?:^|\/)pulls\/?$/.test(w.text));
    if (createPath && apiMethod(text) !== "GET") {
      return { kind: "refuse", reason: "opening a PR through gh api is refused; use gh pr create, which the gate can check" };
    }
    const apiPath = call.args.find((w) => /(?:^|\/)pulls\/[^/]+\/merge$/.test(w.text));
    if (!apiPath || apiMethod(text) === "GET") return null;
    const merge = /(?:repos\/([\w.-]+\/[\w.-]+)\/)?pulls\/(\d+)\/merge$/.exec(apiPath.text);
    if (!merge || apiPath.dynamic) {
      return { kind: "refuse", reason: "the gate cannot tell which PR this gh api merge names; use gh pr merge <number>" };
    }
    return {
      kind: "remote",
      what: "A merge through gh api",
      selector: { text: merge[2], dynamic: false },
      repo: merge[1] ? { text: merge[1], dynamic: false } : null,
    };
  }
  return null;
}

function thisRepo(cwd) {
  try {
    const url = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1].toLowerCase() ?? null;
  } catch {
    return null;
  }
}

// True only when the command names, as plain text, a repo that is not this one.
function isAnotherRepo(repo, cwd) {
  if (!repo || repo.dynamic) return false;
  const named = repo.text.toLowerCase();
  const own = thisRepo(cwd);
  return own !== null && /^[\w.-]+\/[\w.-]+$/.test(named) && named !== own;
}

function fetchBody(selector, repo, cwd) {
  if (selector?.dynamic) throw new Error("the PR is chosen at run time, so the gate cannot read it");
  const args = ["pr", "view", ...(selector ? [selector.text] : []), "--json", "body", "-q", ".body"];
  if (repo) args.push("-R", repo.text);
  try {
    return execFileSync("gh", args, { cwd, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
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
  if (op.kind === "refuse") return op.reason;
  const where = dir ?? cwd;
  if (isAnotherRepo(op.repo, where)) return null;
  if (op.kind === "create") {
    const got = createBody(op.pr, dir);
    const found = got.problem ? [got.problem] : recordProblems(got.body);
    return found.length ? refusal(OPENING_PR, found) : null;
  }
  try {
    const found = recordProblems(fetchBody(op.selector, op.repo, where));
    return found.length ? refusal(op.what, found, FINISH_OPEN_PR) : null;
  } catch (error) {
    return refusal(op.what, [error.message], FINISH_OPEN_PR);
  }
}

// Every reason to refuse a Bash command. An empty list allows it.
// shell is agent-hook-shell.mjs, passed in so it loads inside main's try.
export function bashProblems(command, cwd, shell) {
  if (!MAY_CONCERN.test(command)) return [];
  let steps;
  try {
    steps = [...shell.walk(command, cwd)];
  } catch {
    return NAMES_PR_OP.test(command) || /pulls\/|graphql/.test(command) ? ["the gate cannot parse this command"] : [];
  }
  return steps
    .map(({ call, dir }) => {
      const op = classify(call, shell);
      return op && problemFor(op, dir, cwd);
    })
    .filter(Boolean);
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
  const concerns = tool === "Bash" ? typeof command === "string" && MAY_CONCERN.test(command) : tool.startsWith("mcp__");
  if (!concerns) return;
  let problems;
  try {
    // Loaded here, so a missing shell module refuses instead of exiting 1,
    // which Claude Code would treat as allow.
    const shell = await import("./agent-hook-shell.mjs");
    problems = tool === "Bash"
      ? bashProblems(command, payload.cwd ?? process.cwd(), shell)
      : mcpProblems(tool, payload.tool_input ?? {});
  } catch (error) {
    problems = [`review-gate: the hook failed while checking a PR operation, so it refuses: ${error?.stack ?? error}`];
  }
  if (problems.length) {
    process.stderr.write(`${problems.join("\n\n")}\n`);
    process.exitCode = 2;
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
