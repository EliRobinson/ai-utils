#!/usr/bin/env node
// Write, check and remove the tracker copies of the agent-roster agents.
//
//   node tracker-copies.mjs plan   --agents <dir> --out <dir> --prefix <p> --read <a,b> [--write-tools <c,d>]
//   node tracker-copies.mjs write  --agents <dir> --out <dir> --prefix <p> --read <a,b> [--write-tools <c,d>]
//   node tracker-copies.mjs check  --agents <dir> --out <dir> [--prefix <p> --read <a,b> --write-tools <c,d>]
//   node tracker-copies.mjs remove --out <dir>
//
// A tracker copy is a plugin agent file with the tracker's MCP tools added to
// the end of its `tools:` line, and one comment as the first line of its body.
// Every agent gains the --read tools (the tracker's Search and View tools);
// ticket-writer and pr-finisher also gain the --write-tools. Nothing else
// changes. plan prints what write would do and writes nothing. write writes
// each copy through a temporary file, then runs check on the folder and
// deletes every copy check finds wrong: a copy whose frontmatter does not
// parse would load with no tool limit. It also deletes copies of agents the
// plugin no longer has. check reports copies that are stale, edited,
// duplicated, orphaned, missing or that add tools beyond the tracker's, and
// any other file or symlink in the folder that would load as an agent-roster
// agent. With --prefix, --read and --write-tools it also checks the added tools
// equal those. remove deletes every file that carries the tracker-copy comment.
// --version defaults to the version in <agents>/../.claude-plugin/plugin.json.
// The folder is read recursively, because Claude Code reads agent subfolders.
// Exit 0 when all is well, 1 on a problem, 2 on bad usage.
// No dependencies. Part of the setup-agentic-workflow skill; run from there.

import fs from "node:fs";
import path from "node:path";

export const WRITERS = new Set(["ticket-writer", "pr-finisher"]);
const MAX_READ_TOOLS = 2; // Search and View
const PREFIX = /^mcp__[A-Za-z0-9_-]+__$/;
const AGENT_NAME = /^[a-z0-9-]+$/;
const VERSION = /^[0-9A-Za-z.+-]+$/;
const TOOL_TOKEN = /^(?:[A-Za-z]+|mcp__[A-Za-z0-9_-]+)$/;
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;
const RERUN = 'Rerun setup-agentic-workflow after each agent-roster update ("change ticketing tool" for your own copies, the full setup for a repo\'s).';
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MARKER = new RegExp(`^<!-- agent-roster (\\S+) tracker copy of (\\S+); prefix (\\S+); added tools: (.*?)\\. ${escape(RERUN)} -->$`, "m");

export const marker = (version, name, prefix, added) =>
  `<!-- agent-roster ${version} tracker copy of ${name}; prefix ${prefix}; added tools: ${added.length ? added.join(", ") : "none"}. ${RERUN} -->\n`;

// The frontmatter of an agent file: its name, its one `tools:` line and its
// tools. Throws on anything Claude Code might read another way.
export function parseAgent(text, where) {
  const match = FRONTMATTER.exec(text);
  if (!match) throw new Error(`${where}: no frontmatter block at the top`);
  const lines = match[1].split("\n");
  const at = lines.flatMap((line, i) => (/^tools\s*:/.test(line) ? [i] : []));
  if (at.length !== 1) throw new Error(`${where}: needs exactly one \`tools:\` line, found ${at.length}`);
  const next = lines[at[0] + 1];
  if (next !== undefined && !/^[A-Za-z_-]+\s*:/.test(next)) {
    throw new Error(`${where}: the line after \`tools:\` must be another key; YAML would read it as more tools`);
  }
  if (lines.some((line) => /^disallowedTools\s*:/.test(line))) throw new Error(`${where}: sets disallowedTools`);
  const name = (lines.find((line) => /^name:/.test(line)) || "").slice(5).trim();
  if (!AGENT_NAME.test(name)) throw new Error(`${where}: \`name:\` must be lowercase letters, digits and -, got ${JSON.stringify(name)}`);
  const raw = lines[at[0]].replace(/^tools\s*:/, "").trim();
  const tools = raw.split(",").map((t) => t.trim());
  if (!raw || tools.some((t) => !TOOL_TOKEN.test(t))) {
    throw new Error(`${where}: the \`tools:\` line must be a plain comma list of tool names, got ${JSON.stringify(raw)}`);
  }
  return { name, tools, toolLine: lines[at[0]], end: match[0].length };
}

// Why a list of tracker tools is not allowed, or null: each one a full MCP tool
// name of the one server, with at most two read tools.
export function addedProblem(prefix, read, writeTools) {
  if (!PREFIX.test(prefix || "")) return `the prefix must look like mcp__<server>__, got ${JSON.stringify(prefix)}`;
  const all = [...read, ...writeTools];
  if (!all.length) return "name at least one tracker tool with --read or --write-tools";
  if (read.length > MAX_READ_TOOLS) return `--read takes at most ${MAX_READ_TOOLS} tools, the Search and View tools`;
  for (const tool of all) {
    if (!tool.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(tool.slice(prefix.length))) {
      return `${JSON.stringify(tool)} is not one tool of the server ${prefix}; give full tool names, no wildcards`;
    }
  }
  if (new Set(all).size !== all.length) return "a tool is named twice";
  return null;
}

export const addedFor = (name, read, writeTools) => (WRITERS.has(name) ? [...read, ...writeTools] : [...read]);

export function copyText(agentText, agent, prefix, added, version) {
  const tools = [...agent.tools, ...added.filter((t) => !agent.tools.includes(t))];
  // Only one line starts with "tools:", so the first whole line equal to it is that line.
  const head = agentText.slice(0, agent.end).replace(`\n${agent.toolLine}\n`, () => `\ntools: ${tools.join(", ")}\n`);
  return head + marker(version, agent.name, prefix, added) + agentText.slice(agent.end);
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

const isLink = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

// Every .md file and symlink under a folder, recursively, as [path, isLink].
function listFiles(dir) {
  if (isLink(dir)) throw new Error(`${dir} is a symlink; point --out at the real folder`);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).sort()
    .map((rel) => path.join(dir, rel))
    .filter((full) => full.endsWith(".md") && (isLink(full) || fs.statSync(full).isFile()))
    .map((full) => [full, isLink(full)]);
}

// The files in a folder: tracker copies (found by their comment, even when the
// frontmatter above it broke) and every other file.
export function loadFolder(dir) {
  const copies = [];
  const others = [];
  for (const [file, link] of listFiles(dir)) {
    if (link) {
      others.push({ file, link });
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    const found = MARKER.exec(text);
    // A copy's comment follows its frontmatter with no blank line before it; a
    // file that only quotes the comment further down is not a copy.
    if (!found || text.slice(0, found.index).includes("\n\n")) {
      others.push({ file, text });
      continue;
    }
    const added = found[4] === "none" ? [] : found[4].split(", ");
    copies.push({ file, version: found[1], name: found[2], prefix: found[3], added, text });
  }
  return { copies, others };
}

// What is wrong in a folder of copies, as { file, message } records.
// `wanted`, when given, is { prefix, read, writeTools }: the tools copies must add.
export function folderProblems(agents, folder, version, wanted = null) {
  const problems = [];
  const add = (file, message) => problems.push({ file, message });
  const seen = new Map();
  const sets = { read: new Set(), write: new Set(), prefix: new Set() };
  for (const copy of folder.copies) {
    const agent = agents.get(copy.name);
    if (!agent) {
      add(copy.file, `the plugin has no agent ${copy.name}; delete this copy`);
      continue;
    }
    if (seen.has(copy.name)) add(copy.file, `a second copy of ${copy.name}, beside ${seen.get(copy.name)}; delete one`);
    seen.set(copy.name, copy.file);
    if (copy.version !== version) add(copy.file, `made from agent-roster ${copy.version}, installed is ${version}; rewrite it`);
    const writer = WRITERS.has(copy.name);
    const reason = addedProblem(copy.prefix, writer ? [] : copy.added, writer ? copy.added : []);
    if (reason) add(copy.file, `${reason}; rewrite it`);
    sets.prefix.add(copy.prefix);
    sets[writer ? "write" : "read"].add(copy.added.join(", "));
    if (wanted) {
      const expected = addedFor(copy.name, wanted.read, wanted.writeTools);
      if (copy.prefix !== wanted.prefix || copy.added.join(", ") !== expected.join(", ")) {
        add(copy.file, `adds ${copy.added.join(", ") || "nothing"}, not ${expected.join(", ")}; rewrite it`);
      }
    }
    let parsed;
    try {
      parsed = parseAgent(copy.text, copy.file);
    } catch (error) {
      add(copy.file, error.message);
      continue;
    }
    const tools = new Set([...agent.tools, ...copy.added]);
    if (parsed.tools.length !== tools.size || parsed.tools.some((t) => !tools.has(t))) {
      add(copy.file, "its tools are not the plugin's tools plus the tools its comment names; rewrite it");
    } else if (copy.text !== copyText(agent.text, agent, copy.prefix, copy.added, copy.version)) {
      add(copy.file, `differs from the plugin's ${copy.name} plus its added tools; rewrite it`);
    }
  }
  if (sets.prefix.size > 1) add(null, "the copies name more than one MCP server; rewrite them");
  if (sets.read.size > 1 || sets.write.size > 1) add(null, "the copies of one kind add different tools; rewrite them");
  const [readSet] = sets.read;
  const [writeSet] = sets.write;
  if (readSet && writeSet !== undefined && readSet.split(", ").some((t) => !writeSet.split(", ").includes(t))) {
    add(null, "the read-only and work agents add a tool that ticket-writer and pr-finisher do not; rewrite them");
  }
  if (folder.copies.length) {
    for (const name of agents.keys()) if (!seen.has(name)) add(null, `no tracker copy of ${name}; rewrite the copies`);
  }
  for (const other of folder.others) {
    const stem = path.basename(other.file, ".md");
    const name = other.text ? ((FRONTMATTER.exec(other.text)?.[1] || "").match(/^name:\s*(.*)$/m)?.[1] || "").trim() : "";
    if (other.link) add(other.file, "is a symlink; Claude Code would load whatever it points to as an agent");
    else if (agents.has(stem) || agents.has(name)) add(other.file, `is not a tracker copy but loads as the agent ${name || stem}`);
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
  const version = opts.version ?? JSON.parse(fs.readFileSync(path.join(opts.agents, "..", ".claude-plugin", "plugin.json"), "utf8")).version;
  if (!VERSION.test(version || "")) throw new Error("no usable agent-roster version; pass --version with the installed one");
  return version;
}

function wantedTools(opts) {
  const wanted = { prefix: opts.prefix, read: list(opts.read), writeTools: list(opts["write-tools"]) };
  const reason = addedProblem(wanted.prefix, wanted.read, wanted.writeTools);
  if (reason) throw new Error(reason);
  return wanted;
}

const report = (problems) => problems.forEach(({ file, message }) => console.log(file ? `${file}: ${message}` : message));

function buildPlan(opts) {
  const wanted = wantedTools(opts);
  const agents = loadAgents(opts.agents);
  const version = pluginVersion(opts);
  const folder = loadFolder(opts.out);
  const plan = [...agents.values()].map((agent) => {
    const added = addedFor(agent.name, wanted.read, wanted.writeTools);
    return { agent, added, file: path.join(opts.out, `${agent.name}.md`), text: copyText(agent.text, agent, wanted.prefix, added, version) };
  });
  for (const { file } of plan) {
    if ((fs.existsSync(file) || isLink(file)) && !folder.copies.some((copy) => copy.file === file)) {
      throw new Error(`${file} exists and is not a tracker copy; move it, then run this again`);
    }
  }
  return plan;
}

const COMMANDS = {
  remove(opts) {
    for (const copy of loadFolder(opts.out).copies) {
      fs.unlinkSync(copy.file);
      console.log(`removed ${copy.file}`);
    }
    return 0;
  },
  check(opts) {
    const wanted = opts.prefix || opts.read || opts["write-tools"] ? wantedTools(opts) : null;
    const problems = folderProblems(loadAgents(opts.agents), loadFolder(opts.out), pluginVersion(opts), wanted);
    report(problems);
    if (!problems.length) console.log("tracker copies OK");
    return problems.length ? 1 : 0;
  },
  plan(opts) {
    buildPlan(opts).forEach(({ agent, added }) => console.log(`${agent.name}: adds ${added.join(", ") || "nothing"}`));
    return 0;
  },
  write(opts) {
    const plan = buildPlan(opts);
    fs.mkdirSync(opts.out, { recursive: true });
    for (const { file, text } of plan) {
      const temp = `${file}.tmp-${process.pid}`;
      try {
        fs.writeFileSync(temp, text);
        fs.renameSync(temp, file);
      } finally {
        fs.rmSync(temp, { force: true });
      }
    }
    const agents = loadAgents(opts.agents);
    for (const copy of loadFolder(opts.out).copies) {
      if (!agents.has(copy.name)) {
        fs.unlinkSync(copy.file);
        console.log(`removed ${copy.file}: the plugin has no agent ${copy.name}`);
      }
    }
    // One verifier: the same check `check` runs, on what was just written.
    const problems = folderProblems(agents, loadFolder(opts.out), pluginVersion(opts), wantedTools(opts));
    report(problems);
    for (const file of new Set(problems.map((p) => p.file))) {
      if (plan.some((p) => p.file === file)) fs.rmSync(file, { force: true });
    }
    console.log(problems.length ? `${problems.length} problems; deleted the copies that had one` : `wrote ${plan.length} tracker copies to ${opts.out}`);
    return problems.length ? 1 : 0;
  },
};

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
    if (!COMMANDS[opts.command] || !opts.out || (opts.command !== "remove" && !opts.agents)) throw new Error();
  } catch {
    console.error("usage: tracker-copies.mjs plan|write|check|remove --agents <dir> --out <dir> " +
      "[--prefix mcp__<server>__ --read <tools> --write-tools <tools>] [--version <v>]");
    return 2;
  }
  try {
    return COMMANDS[opts.command](opts);
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (path.basename(process.argv[1] || "") === "tracker-copies.mjs") {
  process.exitCode = main(process.argv.slice(2));
}
