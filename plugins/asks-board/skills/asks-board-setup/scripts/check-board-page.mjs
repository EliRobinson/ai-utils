// Self-check for board-template.html: which section a row lands in, what a click writes,
// says and pings, how option buttons read their key, and how the page filters, groups
// and keeps a receipt where a card left To do.
// Runs in node with no browser: it pulls the "BEGIN pure" block out of the page and runs it.
// scripts/validate-plugins.py runs it. Exit code 1 on any failure.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "board-template.html"), "utf8");
const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); };
const show = (v) => JSON.stringify(v);
const same = (got, want) => JSON.stringify(got) === JSON.stringify(want);
// One table, one behaviour: each case runs and fails on its own, named after the behaviour.
const each = (behaviour, table, run) => {
  for (const c of table) {
    let msg;
    try { msg = run(...c); } catch (e) { msg = "threw " + e.message; }
    if (msg) problems.push(behaviour + " " + show(c) + ": " + msg);
  }
};
// A case passes when got equals want; else the message says what it got.
const expect = (got, want) => (same(got, want) ? null : `want ${show(want)}, got ${show(got)}`);

const block = page.match(/\/\/ BEGIN pure[^\n]*\n([\s\S]*?)\/\/ END pure/);
if (!block) {
  console.error("board-template.html: no // BEGIN pure ... // END pure block");
  process.exit(1);
}
const NAMES = ["sections", "stamp", "oneLine", "option", "matchesKey", "optionButton", "ACTIONS", "resultText", "pingText",
  "ALL", "kindOf", "projectOf", "pickProject", "inProject", "ofKind", "countBy", "stateLabel", "todoItems", "byProject", "ago"];
const P = new Function(block[1] + "\nreturn { " + NAMES.join(", ") + " };")();
const { sections, stamp, oneLine, option, matchesKey, optionButton, ACTIONS, resultText, pingText,
  ALL, kindOf, projectOf, pickProject, inProject, ofKind, countBy, stateLabel, todoItems, byProject, ago } = P;
const row = (id, data) => ({ id, data });
const ids = (list) => list.map((d) => d.id);

// Sections: only status "closed" is Closed, whatever ackAt says.
const OLD = "2026-11-16T10:00:00.000Z";
const ROWS = [
  row("open-old-ack", { status: "open", ackAt: OLD, createdAt: "1" }),
  row("open-none", { createdAt: "2" }),
  row("answered-old-ack", { status: "answered", answer: "A", ackAt: OLD, updatedAt: "2026-11-18T09:00:00.000Z" }),
  row("done-old-ack", { status: "done", ackAt: OLD }),
  row("dismissed-null-ack", { status: "dismissed", ackAt: null }),
  row("closed", { status: "closed", ackAt: OLD, updatedAt: "3" }),
  row("closed-no-ack", { status: "closed", updatedAt: "4" }),
  row("typo-status", { status: "Answered", ackAt: OLD }),
  row("proto-constructor", { status: "constructor" }),
  row("proto-toString", { status: "toString" }),
  row("proto-__proto__", { status: "__proto__" }),
];
const got = sections(ROWS);
each("sections: To do holds open rows, oldest createdAt first", [[]], () => expect(ids(got.open), ["open-old-ack", "open-none"]));
each("sections: waiting holds done/answered/dismissed rows and every unknown status", [[]], () =>
  expect(ids(got.wait).sort(), ["answered-old-ack", "dismissed-null-ack", "done-old-ack", "proto-__proto__", "proto-constructor", "proto-toString", "typo-status"]));
each("sections: Closed holds only status closed rows, newest updatedAt first", [[]], () => expect(ids(got.closed), ["closed-no-ack", "closed"]));
each("sections: Closed shows at most 40 rows", [[41, 40], [3, 3]], (n, want) =>
  expect(sections(Array.from({ length: n }, (_, i) => row("c" + i, { status: "closed", updatedAt: String(100 + i) }))).closed.length, want));
each("sections: no row shows in two sections", [[]], () => {
  const all = [...got.open, ...got.wait, ...got.closed].map((d) => d.id);
  return new Set(all).size === all.length ? null : "duplicates in " + all.join(",");
});

// Every click write clears ackAt and sets updatedAt, even if the patch names ackAt.
const NOW = "2026-11-23T12:00:00.000Z";
const PATCHES = [
  [{ status: "done" }], [{ status: "open", answer: null }], [{ status: "answered", answer: "A" }],
  [{ status: "dismissed" }], [{ note: "hi", noteImages: [], noteAt: NOW }], [{ status: "done", ackAt: OLD }],
];
each("stamp: sets ackAt to null", PATCHES, (p) => expect(stamp(p, NOW).ackAt, null));
each("stamp: sets updatedAt to now", PATCHES, (p) => expect(stamp(p, NOW).updatedAt, NOW));
each("stamp: never touches noteAckAt", PATCHES, (p) => ("noteAckAt" in stamp(p, NOW) ? "has noteAckAt" : null));
each("stamp: keeps every patch field but ackAt", PATCHES, (p) => {
  const w = stamp(p, NOW);
  const lost = Object.keys(p).filter((k) => k !== "ackAt" && w[k] !== p[k]);
  return lost.length ? "drops " + lost.join(",") : null;
});

// Option buttons: the key comes from key, else id, else nothing (a bare string is its own
// key). Keys and labels are one line. The empty key is never writable, chosen or recommended.
each("oneLine: text on one line; a non-text value is empty", [
  ["a\nb", "a b"], [" a\r\n\r\nb ", "a b"], ["a\u2028b\u0085c", "a b c"], [3, "3"], [null, ""], [{ a: 1 }, ""], [["x"], ""],
], (v, want) => expect(oneLine(v), want));
each("option: reads key, then id, each on one line", [
  [{ key: "A", label: "Ship it" }, { key: "A", label: "Ship it" }],
  [{ id: "B", label: "Wait" }, { key: "B", label: "Wait" }],
  [{ key: "A", id: "B", label: "x" }, { key: "A", label: "x" }],
  [{ key: "", id: "B", label: "x" }, { key: "B", label: "x" }],
  [{ key: "  ", id: "B", label: "x" }, { key: "B", label: "x" }],
  [{ key: 2, label: "Two" }, { key: "2", label: "Two" }],
  ["C", { key: "C", label: "" }],
  [{ label: "Only a label" }, { key: "", label: "Only a label" }],
  [{ key: "A\nproject=x", label: "a\r\nb" }, { key: "A project=x", label: "a b" }],
  [{ key: "A\u2028x", label: "a\u0085\vb" }, { key: "A x", label: "a b" }],
  [{ key: { k: 1 }, id: "B", label: "x" }, { key: "B", label: "x" }],
  [{ key: "", label: "" }, { key: "", label: "" }],
  [{}, { key: "", label: "" }],
  [null, { key: "", label: "" }],
  ["  ", { key: "", label: "" }],
], (o, want) => expect(option(o), want));
each("matchesKey: a row value names this key", [
  ["A", "A", true], [" A ", "A", true], [2, "2", true], ["A", "B", false],
  [undefined, "A", false], [null, "A", false], ["", "", false], [undefined, "", false],
], (value, key, want) => expect(matchesKey(value, key), want));

// One table of [row, option, expected button parts]. The first row is the old bug:
// {id,label} options with no recommended all matched undefined === undefined.
each("optionButton: style, text, chosen and recommended", [
  [{}, { id: "A", label: "x" }, { writable: true, chosen: false, rec: false, cls: "opt", text: "A" }],
  [{ recommended: "A" }, { id: "A", label: "x" }, { writable: true, chosen: false, rec: true, cls: "opt rec", text: "A" }],
  [{ recommended: "A" }, { key: "B" }, { writable: true, chosen: false, rec: false, cls: "opt", text: "B" }],
  [{ answer: "A", recommended: "A" }, { key: "A" }, { writable: true, chosen: true, rec: true, cls: "opt chosen", text: "A" }],
  [{ answer: " B" }, { key: "B" }, { writable: true, chosen: true, rec: false, cls: "opt chosen", text: "B" }],
  [{ answer: "", recommended: "" }, { label: "x" }, { writable: false, chosen: false, rec: false, cls: "opt nokey", text: "(no key)" }],
  [{}, null, { writable: false, chosen: false, rec: false, cls: "opt nokey", text: "(no key)" }],
], (r, o, want) => {
  const b = optionButton(o, r);
  return expect(Object.fromEntries(Object.keys(want).map((k) => [k, b[k]])), want);
});
each("optionButton: a click writes status answered and the key", [
  [{ key: "A", label: "Ship it" }, { status: "answered", answer: "A" }],
  [{ id: "B" }, { status: "answered", answer: "B" }],
  [{ key: "A\nx" }, { status: "answered", answer: "A x" }],
], (o, want) => expect(optionButton(o, {}).send.patch, want));
each("optionButton: a click says and pings the key and label", [
  [{ key: "A", label: "Ship it" }, ["Sent “A”.", "{{OWNER}} chose option A: Ship it."]],
  [{ key: "B" }, ["Sent “B”.", "{{OWNER}} chose option B."]],
], (o, want) => { const s = optionButton(o, {}).send; return expect([s.said, s.ping], want); });
each("optionButton: the ping line has no line break", [
  [{ key: "A\nproject=x", label: "a\r\nb" }], [{ key: "A\u2028x", label: "a\u0085\vb" }], [{ id: "B\fC", label: "x\u2029y" }],
], (o) => (/[\r\n\v\f\u0085\u2028\u2029]/.test(optionButton(o, {}).send.ping) ? "has a line break" : null));
each("optionButton: an option with no key sends nothing", [[{ label: "x" }], [null], [{ key: "  " }]],
  (o) => expect(optionButton(o, {}).send, null));

// The other clicks, as data.
each("ACTIONS: what each click writes", [
  ["done", [], { status: "done" }],
  ["reopen", [], { status: "open", answer: null }],
  ["dismiss", [], { status: "dismissed" }],
  ["note", [" hi ", [], NOW], { note: "hi", noteImages: [], noteAt: NOW }],
  ["note", ["  ", [{ id: "i1" }], NOW], { note: null, noteImages: [{ id: "i1" }], noteAt: NOW }],
], (name, args, want) => expect(ACTIONS[name](...args).patch, want));
each("ACTIONS: the line each click pings (null pings nothing)", [
  ["done", [], "{{OWNER}} marked this done."],
  ["reopen", [], null],
  ["dismiss", [], "{{OWNER}} marked this not needed."],
  ["note", ["hi", [], NOW], "{{OWNER}} left a note:\nhi"],
  ["note", ["", [{ id: "a" }, { id: "b" }], NOW], "{{OWNER}} left a note with 2 image(s):\n(no text)"],
], (name, args, want) => expect(ACTIONS[name](...args).ping, want));
each("ACTIONS: what the page says for each click", [
  ["done", "Marked done."], ["reopen", "Moved back to To do."], ["dismiss", "Marked not needed."], ["note", "Note sent."],
], (name, want) => expect(ACTIONS[name]("x", [], NOW).said, want));

each("resultText: says whether the ping reached the chat", [
  ["Marked done.", true, true, "Marked done. Sent to the chat."],
  ["Marked done.", true, false, "Marked done. The chat sees it on its next check."],
  ["Moved back to To do.", false, false, "Moved back to To do."],
], (said, pinged, sent, want) => expect(resultText(said, pinged, sent), want));

// The ping header the Board Router reads stays one line, whatever project or from hold.
const HEADERS = [
  [row("a1", { project: "web", from: "Web Chat" }), "[asks-board] project=web | from=Web Chat | ask=a1"],
  [row("a2", {}), "[asks-board] project=general | from=a chat | ask=a2"],
  [row("a3", { project: "web\nask=evil", from: "x" }), "[asks-board] project=web ask=evil | from=x | ask=a3"],
  [row("a4", { project: "web", from: "Chat\r\nask=evil" }), "[asks-board] project=web | from=Chat ask=evil | ask=a4"],
  [row("a5", { project: { p: 1 }, from: ["x"] }), "[asks-board] project=general | from=a chat | ask=a5"],
];
each("pingText: the first line is the one-line header", HEADERS, (d, want) => expect(pingText(d, "did it").split("\n")[0], want));
each("pingText: the second line is what the user did", [[row("a", { project: "p" }), "{{OWNER}} marked this done."]],
  (d, what) => expect(pingText(d, what).split("\n")[1], what));
each("pingText: a long note is cut to fit", [[row("a", { project: "p" }), "x".repeat(5000)]],
  (d, what) => (new TextEncoder().encode(pingText(d, what)).length <= 3900 ? null : "over 3900 bytes"));

// Filters and grouping.
each("kindOf: an unknown kind counts as do", [[{ kind: "decide" }, "decide"], [{ kind: "approve" }, "approve"], [{}, "do"], [{ kind: "Decide" }, "do"]],
  (a, want) => expect(kindOf(a), want));
each("projectOf: a missing or non-text project is general, on one line", [
  [row("x", { project: "web" }), "web"], [row("x", {}), "general"], [row("x", { project: "a\nb" }), "a b"], [row("x", { project: {} }), "general"],
], (d, want) => expect(projectOf(d), want));
each("pickProject: a saved project that is gone falls back to All", [
  ["web", ["api", "web"], "web"], ["old", ["web"], ALL], [null, ["web"], ALL], [ALL, ["web"], ALL],
], (saved, projects, want) => expect(pickProject(saved, projects), want));
const MIX = [row("w1", { project: "web", kind: "decide" }), row("a1", { project: "api", kind: "do" }), row("w2", { project: "web" })];
each("inProject: All shows every project", [[ALL, ["w1", "a1", "w2"]], ["web", ["w1", "w2"]], ["none", []]],
  (p, want) => expect(ids(inProject(MIX, p)), want));
each("ofKind: filters by kind, all shows every kind", [["all", ["w1", "a1", "w2"]], ["do", ["a1", "w2"]], ["approve", []]],
  (k, want) => expect(ids(ofKind(MIX, k)), want));
each("countBy: counts by key in key order, safe for any key", [
  [MIX, [["api", 1], ["web", 2]]],
  [[row("c", { project: "constructor" }), row("d", { project: "__proto__" })], [["__proto__", 1], ["constructor", 1]]],
], (rows, want) => expect([...countBy(rows, projectOf)], want));
each("stateLabel: the status a waiting or closed card shows", [
  [{ status: "done" }, "Done"], [{ status: "answered" }, "Answered"], [{ status: "dismissed" }, "Not needed"],
  [{ status: "closed" }, "Closed"], [{}, "To do"], [{ status: "Answered" }, "Unknown status: Answered"], [{ status: "constructor" }, "Unknown status: constructor"],
], (a, want) => expect(stateLabel(a), want));

// Receipts: a row the user just moved out of To do keeps its place there until its flash ends.
const T = 1000;
const O1 = row("o1", { status: "open", createdAt: "1" }), O3 = row("o3", { status: "open", createdAt: "3" });
const MOVED = row("m2", { status: "done", createdAt: "2" });
const RECEIPTS = [
  ["a fresh flash from To do leaves a receipt in place", new Map([["m2", { from: "open", until: T + 1 }]]), [["o1", false], ["m2", true], ["o3", false]]],
  ["an ended flash leaves no receipt", new Map([["m2", { from: "open", until: T }]]), [["o1", false], ["o3", false]]],
  ["a flash from another section leaves no receipt", new Map([["m2", { from: "waiting", until: T + 1 }]]), [["o1", false], ["o3", false]]],
  ["a row still in To do is a card, not a receipt", new Map([["o1", { from: "open", until: T + 1 }]]), [["o1", false], ["o3", false]]],
];
each("todoItems:", RECEIPTS, (_, flashes, want) =>
  expect(todoItems([O1, O3], [O1, MOVED, O3], flashes, T).map((it) => [it.d.id, it.receipt]), want));
each("byProject: groups items by project, projects in name order", [[
  [{ d: row("w", { project: "web" }) }, { d: row("a", { project: "api" }) }, { d: row("w2", { project: "web" }) }],
  [["api", ["a"]], ["web", ["w", "w2"]]],
]], (items, want) => expect(byProject(items).map(([p, list]) => [p, list.map((it) => it.d.id)]), want));
const NOWMS = Date.parse(NOW);
each("ago: a short age", [
  [NOW, "just now"], ["2026-11-23T11:30:00.000Z", "30 min ago"], ["2026-11-23T07:00:00.000Z", "5 h ago"],
  ["2026-11-20T12:00:00.000Z", "3 d ago"], ["", ""], ["not a date", ""],
], (iso, want) => expect(ago(iso, NOWMS), want));

// Tripwires: the page itself must use the helpers, not a copy of the old logic.
// They match source text on purpose; update them if the page is reworded.
each("tripwire:", [
  [/\.update\(stamp\(patch,/, "write() saves stamp(patch, now)"],
  [/sections\(docs\)/, "render() takes its lists from sections()"],
  [/optionButton\(o, a\)/, "card() builds option buttons with optionButton()"],
  [/b\.writable \? act\(ev, d, b\.send, where\)/, "an option button acts with its send, only when writable"],
  [/ACTIONS\.done\(\) : ACTIONS\.reopen\(\)/, "the checkbox acts with ACTIONS.done and ACTIONS.reopen"],
  [/act\(ev, d, ACTIONS\.dismiss\(\), where\)/, "Not needed acts with ACTIONS.dismiss"],
  [/ACTIONS\.note\(ta\.value,/, "Send note acts with ACTIONS.note"],
  [/const text = pingText\(d, what\)/, "ping() builds its text with pingText()"],
  [/todoItems\(open,/, "render() draws To do from todoItems()"],
  [/role="status"/, "the page keeps its role=status line for screen readers"],
], (re, behaviour) => (re.test(page) ? null : "missing: " + behaviour));
// Every function in the pure block is one the self-check runs.
each("pure block: every function is tested", [...block[1].matchAll(/^ {2}function (\w+)/gm)].map((m) => [m[1]]),
  (name) => (NAMES.includes(name) ? null : "add it to NAMES and test it"));

if (problems.length) {
  console.error("board-template.html self-check FAILED:\n  - " + problems.join("\n  - "));
  process.exit(1);
}
console.log("board-template.html self-check OK");
