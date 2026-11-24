#!/usr/bin/env node
// Merge the agent hooks into <repo>/.claude/settings.json without touching
// anything else in it.
//
//   node merge-settings.mjs <repo>           # print the merged file, write nothing
//   node merge-settings.mjs <repo> --write   # write it
//
// A hook already wired for a matcher that covers the same tool is left as it
// is. The file is written back with 2-space indent, so a hand-formatted file
// can show layout changes beyond the added hooks.
// Exit 1 if the existing file is not valid JSON or has an odd shape.
// No dependencies. Part of the setup-agentic-workflow skill; run from there.

import fs from "node:fs";
import path from "node:path";

import { MCP_MATCHER, MCP_TOOLS } from "./review-gate-hook.mjs";

const [repo, flag] = process.argv.slice(2);
if (!repo) {
  console.error("usage: merge-settings.mjs <repo> [--write]");
  process.exit(2);
}

const command = (script) => `node "$CLAUDE_PROJECT_DIR/scripts/${script}"`;
// Each hook, the matcher to add, and the tool names it must cover. An
// existing wiring counts only if it covers every one of them.
const WANTED = [
  { matcher: "Bash", tools: ["Bash"], script: "guard-main-checkout-hook.mjs" },
  { matcher: "Bash", tools: ["Bash"], script: "review-gate-hook.mjs" },
  { matcher: MCP_MATCHER, tools: Object.keys(MCP_TOOLS).map((t) => `mcp__any__${t}`), script: "review-gate-hook.mjs" },
];

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const file = path.join(repo, ".claude", "settings.json");
const exists = fs.existsSync(file);
let settings = {};
if (exists) {
  try {
    settings = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${file} is not valid JSON (${error.message}). Fix it by hand, then run this again.`);
  }
}
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const byHand = "Fix it by hand, then run this again.";
if (!isObject(settings)) fail(`${file} is not a JSON object. ${byHand}`);
settings.hooks ??= {};
if (!isObject(settings.hooks)) fail(`${file}: hooks is not an object. ${byHand}`);
settings.hooks.PreToolUse ??= [];
const groups = settings.hooks.PreToolUse;
if (!Array.isArray(groups)) fail(`${file}: hooks.PreToolUse is not a list. ${byHand}`);
for (const group of groups) {
  if (!isObject(group) || (group.hooks !== undefined && !Array.isArray(group.hooks))) {
    fail(`${file}: a hooks.PreToolUse entry is not { matcher, hooks: [...] }. ${byHand}`);
  }
}

// Whether a matcher would send this tool's calls to its hooks. An empty
// matcher and "*" match every tool.
const covers = (matcher, tool) => {
  if (!matcher || matcher === "*") return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return matcher === tool;
  }
};

const added = [];
const runs = (group, script) => (group.hooks ?? []).some((h) => String(h?.command ?? "").includes(script));
for (const { matcher, tools, script } of WANTED) {
  const wired = tools.every((tool) => groups.some((g) => covers(g.matcher, tool) && runs(g, script)));
  if (wired) continue;
  let group = groups.find((g) => g.matcher === matcher);
  if (!group) {
    group = { matcher, hooks: [] };
    groups.push(group);
  }
  group.hooks ??= [];
  group.hooks.push({ type: "command", command: command(script) });
  added.push(`${matcher} -> ${script}`);
}

const after = `${JSON.stringify(settings, null, 2)}\n`;
if (added.length === 0) {
  console.log(`${file}: the guard and the review gate are already wired. No change.`);
} else if (flag === "--write") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, after);
  console.log(`${file}: added ${added.join("; ")}.`);
} else {
  console.log(`${file} would gain: ${added.join("; ")}.${exists ? "" : " (The file does not exist yet.)"}`);
  console.log(after);
}
