#!/usr/bin/env node
// Self-check for tracker-copies.mjs. Runs it on throwaway folders and checks
// that copies gain only the named tracker tools, that bad tool names and
// clashing files are refused, and that check finds stale, edited, orphaned and
// missing copies. validate-plugins.py runs every check-*.mjs.
//
//   node check-tracker-copies.mjs

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "tracker-copies.mjs");
const PREFIX = "mcp__tr__";
const READ = "mcp__tr__search,mcp__tr__view";
const WRITE = "mcp__tr__create,mcp__tr__close";

const agentFile = (name, tools, extra = "") => `---\nname: ${name}\ndescription: Use for tests.\ntools: ${tools}\n${extra}model: sonnet\n---\n\nYou are ${name}.\n`;
const AGENTS = {
  "lookup.md": agentFile("lookup", "Read, Grep, Glob, Bash"),
  "implementer-engine.md": agentFile("implementer-engine", "Read, Edit, Write, Bash, Skill"),
  "ticket-writer.md": agentFile("ticket-writer", "Read, Grep, Glob, Bash, Skill"),
  "pr-finisher.md": agentFile("pr-finisher", "Read, Edit, Write, Bash, Skill, Agent"),
};

let failures = 0;
let count = 0;
const ok = (label, pass, detail = "") => {
  count += 1;
  if (!pass) {
    failures += 1;
    console.log(`FAIL ${label}${detail ? `\n  ${detail}` : ""}`);
  }
};

function setup(agents = AGENTS) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-copies-"));
  const dir = path.join(root, "agents");
  fs.mkdirSync(dir);
  for (const [file, text] of Object.entries(agents)) fs.writeFileSync(path.join(dir, file), text);
  return { root, agents: dir, out: path.join(root, "out") };
}

const run = (args) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
const writeArgs = (s, extra = {}) => {
  const o = { prefix: PREFIX, read: READ, "write-tools": WRITE, version: "1.0.0", ...extra };
  return ["write", "--agents", s.agents, "--out", s.out,
    ...Object.entries(o).flatMap(([k, v]) => (v === null ? [] : [`--${k}`, v]))];
};
const checkArgs = (s, extra = []) => ["check", "--agents", s.agents, "--out", s.out, "--version", "1.0.0", ...extra];
const toolsOf = (file) => fs.readFileSync(file, "utf8").match(/^tools: (.*)$/m)[1].split(", ");

// 1. Each agent gains exactly its tracker tools.
{
  const s = setup();
  const result = run(writeArgs(s));
  ok("write exits 0", result.status === 0, result.stderr);
  const WANTED = [
    ["lookup", ["Read", "Grep", "Glob", "Bash", "mcp__tr__search", "mcp__tr__view"]],
    ["implementer-engine", ["Read", "Edit", "Write", "Bash", "Skill", "mcp__tr__search", "mcp__tr__view"]],
    ["ticket-writer", ["Read", "Grep", "Glob", "Bash", "Skill", "mcp__tr__search", "mcp__tr__view", "mcp__tr__create", "mcp__tr__close"]],
    ["pr-finisher", ["Read", "Edit", "Write", "Bash", "Skill", "Agent", "mcp__tr__search", "mcp__tr__view", "mcp__tr__create", "mcp__tr__close"]],
  ];
  for (const [name, tools] of WANTED) {
    const got = toolsOf(path.join(s.out, `${name}.md`));
    ok(`${name} gains only its tracker tools`, JSON.stringify(got) === JSON.stringify(tools), got.join(", "));
  }
  ok("a fresh write passes check", run(checkArgs(s)).status === 0);
  ok("a fresh write passes check against the tools it was given",
    run(checkArgs(s, ["--prefix", PREFIX, "--read", READ, "--write-tools", WRITE])).status === 0);
}

// 1b. The shipped agents parse, so setup can copy them.
{
  const s = setup();
  const result = run(["plan", "--agents", path.join(here, "..", "..", "..", "agents"), "--out", s.out,
    "--prefix", PREFIX, "--read", READ, "--write-tools", WRITE]);
  ok("plan works on the shipped agents", result.status === 0 && !fs.existsSync(s.out), result.stderr);
}

// 2. Bad tool lists are refused, and nothing is written.
const REFUSED = [
  ["wildcard", { read: "mcp__tr__*" }],
  ["bare prefix", { read: "mcp__tr__" }],
  ["other server", { read: "mcp__mail__send" }],
  ["built-in tool", { read: "Write" }],
  ["newline in a name", { read: "mcp__tr__view\nWrite" }],
  ["colon in a name", { read: "mcp__tr__view: x" }],
  ["bad prefix", { prefix: "mcp__tr" }],
  ["no tools at all", { read: null, "write-tools": null }],
  ["tool named twice", { read: "mcp__tr__view,mcp__tr__view" }],
  ["three read tools", { read: "mcp__tr__search,mcp__tr__view,mcp__tr__list" }],
];
for (const [label, extra] of REFUSED) {
  const s = setup();
  const result = run(writeArgs(s, extra));
  ok(`refuses ${label}`, result.status === 1 && !fs.existsSync(s.out), `${result.status} ${result.stdout}${result.stderr}`);
}

// 3. Plan writes nothing.
{
  const s = setup();
  const args = writeArgs(s);
  args[0] = "plan";
  const result = run(args);
  ok("plan exits 0 and writes nothing", result.status === 0 && !fs.existsSync(s.out), result.stderr);
}

// 4. A file in the way that is not a tracker copy is never overwritten.
for (const [label, make] of [
  ["own agent file", (file) => fs.writeFileSync(file, "my own lookup\n")],
  ["symlink", (file) => fs.symlinkSync(path.join(path.dirname(file), "..", "agents", "lookup.md"), file)],
]) {
  const s = setup();
  fs.mkdirSync(s.out);
  const file = path.join(s.out, "lookup.md");
  make(file);
  const before = fs.readFileSync(path.join(s.agents, "lookup.md"), "utf8");
  const result = run(writeArgs(s));
  ok(`refuses to overwrite a ${label}`, result.status === 1 && fs.readdirSync(s.out).length === 1, result.stdout);
  ok(`leaves the plugin file alone with a ${label}`, fs.readFileSync(path.join(s.agents, "lookup.md"), "utf8") === before);
}

// 5. Agent files whose tools: line is not a plain list are refused.
const BAD_AGENTS = [
  ["empty tools line", agentFile("lookup", "")],
  ["block list", "---\nname: lookup\ntools:\n  - Read\nmodel: sonnet\n---\n\nx\n"],
  ["flow list", agentFile("lookup", "[Read, Grep]")],
  ["two tools lines", agentFile("lookup", "Read", "tools: Read, Edit\n")],
  ["deny-list", agentFile("lookup", "Read", "disallowedTools: Edit\n")],
  ["no frontmatter", "name: lookup\n"],
  ["tools continued on the next line", agentFile("lookup", "Read", "  , Edit\n")],
  ["a name that is not a plain name", agentFile("lookup", "Read").replace("name: lookup", "name: ../lookup")],
];
for (const [label, text] of BAD_AGENTS) {
  const s = setup({ "lookup.md": text });
  const result = run(writeArgs(s));
  ok(`refuses an agent file with ${label}`, result.status === 1 && !fs.existsSync(s.out), result.stdout + result.stderr);
}

// 6. check finds each kind of bad copy, and anything else that would load as an agent.
// Rewrites a copy's comment and tools line together, as a careful attacker would.
const tamper = (from, to, file = "lookup.md") => (s) => edit(s, file, (t) => t.split(from).join(to));
const BROKEN = [
  ["stale version", () => {}, ["--version", "2.0.0"], "installed is 2.0.0"],
  ["extra tool", (s) => edit(s, "lookup.md", (t) => t.replace("mcp__tr__view\nmodel", "mcp__tr__view, Edit\nmodel")), [], "not the plugin's tools"],
  ["edited prompt", (s) => edit(s, "lookup.md", (t) => t.replace("You are lookup.", "You are anyone.")), [], "differs from the plugin"],
  ["another server, comment and tools both", tamper("mcp__tr__close", "mcp__tr__close, mcp__mail__send", "pr-finisher.md"), [], "not one tool of the server"],
  ["a whole server, comment and tools both", tamper("mcp__tr__close", "mcp__tr__close, mcp__tr", "pr-finisher.md"), [], "not one tool of the server"],
  ["write tools on a read-only agent", tamper("mcp__tr__view", "mcp__tr__view, mcp__tr__create"), [], "different tools"],
  ["tools other than the ones given", () => {}, ["--prefix", PREFIX, "--read", "mcp__tr__search", "--write-tools", WRITE], "not mcp__tr__search"],
  ["orphan", (s) => fs.rmSync(path.join(s.agents, "lookup.md")), [], "has no agent lookup"],
  ["missing copy", (s) => fs.writeFileSync(path.join(s.agents, "researcher.md"), agentFile("researcher", "Read")), [], "no tracker copy of researcher"],
  ["broken frontmatter", (s) => edit(s, "lookup.md", (t) => t.replace(/^---\n/, "--\n")), [], "no frontmatter"],
  ["a second copy", (s) => fs.copyFileSync(path.join(s.out, "lookup.md"), path.join(s.out, "lookup-old.md")), [], "a second copy of lookup"],
  ["a second copy in a subfolder", (s) => {
    fs.mkdirSync(path.join(s.out, "old"));
    fs.copyFileSync(path.join(s.out, "lookup.md"), path.join(s.out, "old", "lookup.md"));
  }, [], "a second copy of lookup"],
  ["a plain file with an agent's name", (s) => fs.writeFileSync(path.join(s.out, "mine.md"), agentFile("implementer-engine", "")), [], "loads as the agent implementer-engine"],
  ["a symlink", (s) => fs.symlinkSync(path.join(s.agents, "lookup.md"), path.join(s.out, "link.md")), [], "is a symlink"],
];
function edit(s, file, change) {
  const full = path.join(s.out, file);
  fs.writeFileSync(full, change(fs.readFileSync(full, "utf8")));
}
for (const [label, breakIt, extra, needle] of BROKEN) {
  const s = setup();
  run(writeArgs(s));
  breakIt(s);
  const result = run(checkArgs(s, extra));
  ok(`check finds ${label}`, result.status === 1 && result.stdout.includes(needle), result.stdout + result.stderr);
}
{
  const s = setup();
  fs.mkdirSync(path.join(s.root, "real"));
  fs.symlinkSync(path.join(s.root, "real"), s.out);
  ok("refuses an --out folder that is a symlink", run(writeArgs(s)).status === 1 && !fs.readdirSync(path.join(s.root, "real")).length);
}

// 7. write removes copies of agents the plugin dropped; remove deletes only copies.
{
  const s = setup();
  run(writeArgs(s));
  fs.rmSync(path.join(s.agents, "lookup.md"));
  run(writeArgs(s));
  ok("write removes an orphan copy", !fs.existsSync(path.join(s.out, "lookup.md")));
  fs.writeFileSync(path.join(s.out, "mine.md"), agentFile("mine", "Read") + "\n" + fs.readFileSync(path.join(s.out, "pr-finisher.md"), "utf8").match(/^<!--.*-->$/m)[0] + "\n");
  fs.copyFileSync(path.join(s.out, "pr-finisher.md"), path.join(s.out, "pr-finisher-old.md"));
  const result = run(["remove", "--out", s.out]);
  ok("remove deletes every tracker copy and nothing else, not even a file that quotes the comment", result.status === 0 && fs.readdirSync(s.out).join() === "mine.md", fs.readdirSync(s.out).join());
}

console.log(failures ? `${failures} of ${count} cases failed.` : `All ${count} cases pass.`);
process.exitCode = failures ? 1 : 0;
