// Self-check for board-template.html: which section a row lands in, and what a click writes.
// Runs in node with no browser: it pulls the "BEGIN pure" block out of the page and runs it.
// scripts/validate-plugins.py runs it. Exit code 1 on any failure.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "board-template.html"), "utf8");
const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); };

const block = page.match(/\/\/ BEGIN pure[^\n]*\n([\s\S]*?)\/\/ END pure/);
if (!block) {
  console.error("board-template.html: no // BEGIN pure ... // END pure block");
  process.exit(1);
}
const { sections, stamp } = new Function(block[1] + "\nreturn { sections, stamp };")();

// Sections: only status "closed" is Closed, whatever ackAt says.
const OLD = "2026-11-16T10:00:00.000Z";
const rows = [
  { id: "open-old-ack", data: { status: "open", ackAt: OLD, createdAt: "1" } },
  { id: "open-none", data: { createdAt: "2" } },
  { id: "answered-old-ack", data: { status: "answered", answer: "A", ackAt: OLD, updatedAt: "2026-11-18T09:00:00.000Z" } },
  { id: "done-old-ack", data: { status: "done", ackAt: OLD } },
  { id: "dismissed-null-ack", data: { status: "dismissed", ackAt: null } },
  { id: "closed", data: { status: "closed", ackAt: OLD, updatedAt: "3" } },
  { id: "closed-no-ack", data: { status: "closed", updatedAt: "4" } },
  { id: "typo-status", data: { status: "Answered", ackAt: OLD } },
  { id: "proto-constructor", data: { status: "constructor" } },
  { id: "proto-toString", data: { status: "toString" } },
  { id: "proto-__proto__", data: { status: "__proto__" } },
];
const got = sections(rows);
const ids = (list) => list.map((d) => d.id).sort().join(",");
const order = (list) => list.map((d) => d.id).join(",");
check(order(got.open) === "open-old-ack,open-none", `open section: want open-old-ack,open-none (oldest createdAt first), got ${order(got.open)}`);
check(ids(got.wait) === "answered-old-ack,dismissed-null-ack,done-old-ack,proto-__proto__,proto-constructor,proto-toString,typo-status",
  `waiting section: want every done/answered/dismissed row and every unknown status, got ${ids(got.wait)}`);
check(order(got.closed) === "closed-no-ack,closed", `closed section: want only status closed rows, newest updatedAt first, got ${order(got.closed)}`);
const many = Array.from({ length: 41 }, (_, i) => ({ id: "c" + i, data: { status: "closed", updatedAt: String(100 + i) } }));
check(sections(many).closed.length === 40, "closed section: want at most 40 rows");
const all = [...got.open, ...got.wait, ...got.closed].map((d) => d.id);
check(new Set(all).size === all.length, `a row shows in two sections: ${all.join(",")}`);

// Every click write clears ackAt and sets updatedAt, even if the patch names ackAt.
const NOW = "2026-11-23T12:00:00.000Z";
for (const patch of [
  { status: "done" },
  { status: "open", answer: null },
  { status: "answered", answer: "A" },
  { status: "dismissed" },
  { note: "hi", noteImages: [], noteAt: NOW },
  { status: "done", ackAt: OLD },
]) {
  check(!("noteAckAt" in stamp(patch, NOW)), `stamp(${JSON.stringify(patch)}) must not touch noteAckAt`);
  const w = stamp(patch, NOW);
  check("ackAt" in w && w.ackAt === null, `stamp(${JSON.stringify(patch)}) must set ackAt: null, got ${JSON.stringify(w.ackAt)}`);
  check(w.updatedAt === NOW, `stamp(${JSON.stringify(patch)}) must set updatedAt`);
  for (const [k, v] of Object.entries(patch)) if (k !== "ackAt") check(w[k] === v, `stamp drops ${k}`);
}

// Tripwires: the page itself must use both helpers, not a copy of the old logic.
// They match source text on purpose; update them if write() or render() is reworded.
check(/\.update\(stamp\(patch,/.test(page), "write() must save stamp(patch, now)");
check(/sections\(docs\.filter\(/.test(page), "render() must take its lists from sections()");

if (problems.length) {
  console.error("board-template.html self-check FAILED:\n  - " + problems.join("\n  - "));
  process.exit(1);
}
console.log("board-template.html self-check OK");
