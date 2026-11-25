#!/usr/bin/env node
// Write, check and remove the tracker copies of the agent-roster agents.
//
//   node tracker-copies.mjs plan   --agents <dir> --out <dir> --prefix <p> --read <a,b> [--write-tools <c,d>]
//   node tracker-copies.mjs write  --agents <dir> --out <dir> --prefix <p> --read <a,b> [--write-tools <c,d>]
//   node tracker-copies.mjs check  --agents <dir> --out <dir>
//   node tracker-copies.mjs remove --out <dir>
//
// A tracker copy is a plugin agent file with the tracker's MCP tools added to
// the end of its `tools:` line, and one comment as the first line of its body.
// Every agent gains the --read tools (the tracker's Search and View tools);
// ticket-writer and pr-finisher also gain the --write-tools. Nothing else
// changes. plan prints what write would do and writes nothing. write checks
// every file it wrote, byte for byte and by re-reading its `tools:` line, and
// deletes the copy and fails if one is wrong: a copy whose frontmatter does not
// parse would load with no tool limit. It also deletes copies of agents the
// plugin no longer has. check reports copies that are stale, edited, orphaned,
// or missing. remove deletes only files that carry the tracker-copy comment.
// --version defaults to the version in <agents>/../.claude-plugin/plugin.json.
// Exit 0 when all is well, 1 on a problem, 2 on bad usage.
// No dependencies. Part of the setup-agentic-workflow skill; run from there.

import fs from "node:fs";
import path from "node:path";

export const WRITERS = new Set(["ticket-writer", "pr-finisher"]);
const PREFIX = /^mcp__[A-Za-z0-9_-]+__$/;
const MCP_NAME = /^mcp__[A-Za-z0-9_-]+$/;
const TOOL_TOKEN = /^(?:[A-Za-z]+|mcp__[A-Za-z0-9_-]+)$/;
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;
const MARKER = /^<!-- agent-roster (\S+) tracker copy of ([a-z0-9-]+); added tools: (.*?)\. Rerun setup-agentic-workflow \("change ticketing tool"\) after each agent-roster update\. -->$/m;

export const marker = (version, name, added) =>
  `<!-- agent-roster ${version} tracker copy of ${name}; added tools: ${added.length ? added.join(", ") : "none"}. ` +
  `Rerun setup-agentic-workflow ("change ticketing tool") after each agent-roster update. -->\n`;

// The frontmatter of an agent file: its fields, its one `tools:` line and its
// tools. Throws on anything Claude Code might read another way.
export function parseAgent(text, where) {
  const match = FRONTMATTER.exec(text);
  if (!match) throw new Error(`${where}: no frontmatter block at the top`);
  const lines = match[1].split("\n");
  const toolLines = lines.filter((line) => /^tools\s*:/.test(line));
  if (toolLines.length !== 1) throw new Error(`${where}: needs exactly one \`tools:\` line, found ${toolLines.length}`);
  if (lines.some((line) => /^disallowedTools\s*:/.test(line))) throw new Error(`${where}: sets disallowedTools`);
  const name = (lines.find((line) => /^name:/.test(line)) || "").slice(5).trim();
  if (!name) throw new Error(`${where}: no \`name:\` line`);
  const raw = toolLines[0].replace(/^tools\s*:/, "").trim();
  const tools = raw.split(",").map((t) => t.trim());
  if (!raw || tools.some((t) => !TOOL_TOKEN.test(t))) {
    throw new Error(`${where}: the \`tools:\` line must be a plain comma list of tool names, got ${JSON.stringify(raw)}`);
  }
  return { name, tools, toolLine: toolLines[0], end: match[0].length };
}

// The tracker tools to add, checked: each one a full MCP tool name under the one prefix.
export function checkAdded(prefix, read, writeTools) {
  if (!PREFIX.test(prefix || "")) throw new Error(`--prefix must look like mcp__<server>__, got ${JSON.stringify(prefix)}`);
  const all = [...read, ...writeTools];
  if (!all.length) throw new Error("name at least one tracker tool with --read or --write-tools");
  for (const tool of all) {
    if (!MCP_NAME.test(tool) || !tool.startsWith(prefix) || tool.length === prefix.length) {
      throw new Error(`${JSON.stringify(tool)} is not one tool of the server ${prefix}; give full tool names, no wildcards`);
    }
  }
  if (new Set(all).size !== all.length) throw new Error("a tool is named twice");
}

export const addedFor = (name, read, writeTools) => (WRITERS.has(name) ? [...read, ...writeTools] : [...read]);

export function copyText(agentText, agent, added, version) {
  const tools = [...agent.tools, ...added.filter((t) => !agent.tools.includes(t))];
  // Only one line starts with "tools:", so the first whole line equal to it is that line.
  const head = agentText.slice(0, agent.end).replace(`\n${agent.toolLine}\n`, () => `\ntools: ${tools.join(", ")}\n`);
  return head + marker(version, agent.name, added) + agentText.slice(agent.end);
}

export function loadAgents(dir) {
  const agents = new Map();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    const agent = parseAgent(text, file);
    agents.set(agent.name, { ...agent, text });
  }
  return agents;
}

// The tracker copies in a folder: name -> { file, version, added, text }.
export function loadCopies(dir) {
  const copies = new Map();
  if (!fs.existsSync(dir)) return copies;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const full = path.join(dir, file);
    if (fs.lstatSync(full).isSymbolicLink()) continue;
    const text = fs.readFileSync(full, "utf8");
    // Found anywhere, so a copy whose frontmatter broke is still seen as a copy.
    const found = MARKER.exec(text);
    if (!found) continue;
    const added = found[3] === "none" ? [] : found[3].split(", ");
    copies.set(found[2], { file: full, version: found[1], added, text });
  }
  return copies;
}

// What is wrong with the copies in a folder, as one line each.
export function copyProblems(agents, copies, version) {
  const problems = [];
  const nonWriterSets = new Set();
  for (const [name, copy] of copies) {
    const agent = agents.get(name);
    if (!agent) {
      problems.push(`${copy.file}: the plugin has no agent ${name}; delete this copy`);
      continue;
    }
    if (copy.version !== version) problems.push(`${copy.file}: made from agent-roster ${copy.version}, installed is ${version}`);
    if (copy.added.some((t) => !MCP_NAME.test(t))) problems.push(`${copy.file}: adds a tool that is not one MCP tool name`);
    if (!WRITERS.has(name)) nonWriterSets.add(copy.added.join(", "));
    let parsed;
    try {
      parsed = parseAgent(copy.text, copy.file);
    } catch (error) {
      problems.push(error.message);
      continue;
    }
    const wanted = new Set([...agent.tools, ...copy.added]);
    if (parsed.tools.length !== wanted.size || parsed.tools.some((t) => !wanted.has(t))) {
      problems.push(`${copy.file}: its tools are not the plugin's tools plus the tools its comment names`);
    } else if (copy.text !== copyText(agent.text, agent, copy.added, copy.version)) {
      problems.push(`${copy.file}: differs from the plugin's ${name} plus its added tools; rewrite it`);
    }
  }
  if (nonWriterSets.size > 1) problems.push("the copies of the read-only and work agents add different tools; rewrite them");
  if (copies.size) {
    for (const name of agents.keys()) {
      if (!copies.has(name)) problems.push(`no tracker copy of ${name}; rewrite the copies`);
    }
  }
  return problems;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!key?.startsWith("--") || rest[i + 1] === undefined) throw new Error(`bad argument ${JSON.stringify(key)}`);
    opts[key.slice(2)] = rest[i + 1];
  }
  return opts;
}

const list = (value) => (value ? value.split(",").map((t) => t.trim()).filter(Boolean) : []);

function pluginVersion(opts) {
  if (opts.version) return opts.version;
  const manifest = path.join(opts.agents, "..", ".claude-plugin", "plugin.json");
  const version = JSON.parse(fs.readFileSync(manifest, "utf8")).version;
  if (!version) throw new Error(`${manifest} has no version; pass --version`);
  return version;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
    if (!["plan", "write", "check", "remove"].includes(opts.command) || !opts.out) throw new Error("usage");
    if (opts.command !== "remove" && !opts.agents) throw new Error("usage");
  } catch {
    console.error("usage: tracker-copies.mjs plan|write|check|remove --agents <dir> --out <dir> " +
      "[--prefix mcp__<server>__ --read <tools> --write-tools <tools>] [--version <v>]");
    return 2;
  }
  try {
    if (opts.command === "remove") {
      for (const copy of loadCopies(opts.out).values()) {
        fs.unlinkSync(copy.file);
        console.log(`removed ${copy.file}`);
      }
      return 0;
    }
    const agents = loadAgents(opts.agents);
    const version = pluginVersion(opts);
    if (opts.command === "check") {
      const problems = copyProblems(agents, loadCopies(opts.out), version);
      for (const problem of problems) console.log(problem);
      if (!problems.length) console.log("tracker copies OK");
      return problems.length ? 1 : 0;
    }
    const read = list(opts.read);
    const writeTools = list(opts["write-tools"]);
    checkAdded(opts.prefix, read, writeTools);
    const plan = [...agents.values()].map((agent) => {
      const added = addedFor(agent.name, read, writeTools);
      return { agent, added, file: path.join(opts.out, `${agent.name}.md`), text: copyText(agent.text, agent, added, version) };
    });
    const copies = loadCopies(opts.out);
    for (const { agent, file } of plan) {
      if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || copies.get(agent.name)?.file !== file)) {
        throw new Error(`${file} exists and is not a tracker copy; move it, then run this again`);
      }
    }
    for (const { agent, added } of plan) console.log(`${agent.name}: adds ${added.join(", ") || "nothing"}`);
    if (opts.command === "plan") return 0;
    fs.mkdirSync(opts.out, { recursive: true });
    let bad = 0;
    for (const { agent, added, file, text } of plan) {
      fs.writeFileSync(file, text);
      const back = fs.readFileSync(file, "utf8");
      let ok = back === text;
      try {
        const tools = parseAgent(back, file).tools;
        const wanted = new Set([...agent.tools, ...added]);
        ok &&= tools.length === wanted.size && tools.every((t) => wanted.has(t));
      } catch {
        ok = false;
      }
      if (!ok) {
        fs.unlinkSync(file);
        console.error(`${file}: did not read back as written; deleted it`);
        bad += 1;
      }
    }
    for (const [name, copy] of copies) {
      if (!agents.has(name)) {
        fs.unlinkSync(copy.file);
        console.log(`removed ${copy.file}: the plugin has no agent ${name}`);
      }
    }
    console.log(bad ? `${bad} copy(ies) failed` : `wrote ${plan.length} tracker copies to ${opts.out}`);
    return bad ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (path.basename(process.argv[1] || "") === "tracker-copies.mjs") {
  process.exitCode = main(process.argv.slice(2));
}
