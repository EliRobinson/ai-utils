// Shared by guard-main-checkout-hook.mjs and review-gate-hook.mjs: reading a
// Bash command the way the shell would, and the stdin plumbing of a
// PreToolUse hook. Policy lives in the hooks; this file only reads.
//
// It is not a full shell parser. It handles quotes, escapes, heredocs,
// here-strings, redirections, $(...), backticks, ( ) subshells, cd, pushd,
// popd, common wrappers (env, sudo, timeout, xargs, ...), `sh -c` and `eval`.
// It flags a script it cannot read (built at run time, or read from stdin)
// as opaque. Each hook decides what to do with a command it cannot read.
//
// The plumbing at the end (readPayload, isEntry, refuse) is used by the
// guard. The review gate keeps its own copy on purpose: it must still work,
// and refuse, when this module is missing.
//
// No dependencies. Installed by the setup-agentic-workflow skill.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ------------------------------------------------------------------ lexer

const WORD_END = /[\s;&|<>()]/;

// Lex a command line into items:
//   { type: "cmd", words, heredocs }  a simple command
//   { type: "push" } / { type: "pop" } a ( ) subshell or a $(...) scope
// A word is { text, dynamic, splits }. dynamic is true when the shell builds it at
// run time ($VAR, $(...), globs, ~). splits is true when that happens outside
// double quotes, so the result may split into several words. Commands inside $(...) and backticks run
// before the command that holds them, so they come first, in their own scope.
// `$(cat <<'X' ... X)` with a quoted delimiter is read as its literal body.
// Throws on an unterminated quote, $( or backtick.
export function lex(line) {
  let i = 0;

  function readDelimiter() {
    while (line[i] === " " || line[i] === "\t") i++;
    let delim = "";
    let quoted = false;
    while (i < line.length && !WORD_END.test(line[i])) {
      if (line[i] === "'" || line[i] === '"' || line[i] === "\\") quoted = true;
      else delim += line[i];
      i++;
    }
    return { delim, quoted, body: "" };
  }

  // At the start of a line: read the bodies of the heredocs opened on the
  // line before, in order.
  function readBodies(heredocs) {
    for (const doc of heredocs) {
      const lines = [];
      while (i < line.length) {
        const eol = line.indexOf("\n", i);
        const text = line.slice(i, eol === -1 ? line.length : eol);
        i = eol === -1 ? line.length : eol + 1;
        if (text.replace(/^\t+/, "") === doc.delim) break;
        lines.push(text);
      }
      doc.body = lines.join("\n");
    }
  }

  // From an opening "(", the index just past its matching ")". Quotes inside
  // are skipped whole.
  function skipParens(from) {
    let depth = 0;
    for (let j = from; j < line.length; j++) {
      const ch = line[j];
      if (ch === "\\") j++;
      else if (ch === "'" || ch === '"') {
        const close = line.indexOf(ch, j + 1);
        if (close === -1) throw new Error(`unterminated ${ch}`);
        j = close;
      } else if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) return j + 1;
    }
    throw new Error("unterminated (");
  }

  function backtick() {
    const close = line.indexOf("`", i + 1);
    if (close === -1) throw new Error("unterminated backtick");
    const inner = lex(line.slice(i + 1, close));
    i = close + 1;
    return inner;
  }

  // nested: inside $( ... ); returns when it reaches the matching ")".
  function parse(nested) {
    const items = [];
    let words = [];
    let word = null;
    let cmdHeredocs = [];
    let waiting = [];
    let pending = [];
    let skipTarget = false;
    let depth = 0;

    const startWord = () => {
      if (word === null) word = { text: "", dynamic: false };
    };
    const endWord = () => {
      if (word !== null) {
        if (skipTarget) skipTarget = false;
        else words.push(word);
      }
      word = null;
    };
    const endCommand = () => {
      endWord();
      items.push(...pending);
      pending = [];
      if (words.length > 0) items.push({ type: "cmd", words, heredocs: cmdHeredocs });
      words = [];
      cmdHeredocs = [];
    };
    // quoted: inside "...", where the result stays one word. Outside quotes
    // the shell splits it, so it can become several words (and flags).
    const substitute = (inner, quoted = false) => {
      startWord();
      const only = inner.length === 1 ? inner[0] : null;
      const doc = only?.words?.length === 1 && only.words[0].text === "cat" && only.heredocs.length === 1
        ? only.heredocs[0]
        : null;
      if (doc && doc.quoted) {
        word.text += doc.body;
      } else {
        word.dynamic = true;
        if (!quoted) word.splits = true;
        pending.push({ type: "push" }, ...inner, { type: "pop" });
      }
    };
    const redirection = () => {
      // A number right before the operator (2>&1) belongs to it.
      if (word !== null && !word.dynamic && /^\d+$/.test(word.text)) word = null;
      endWord();
      if (line.startsWith("<<<", i)) i += 3;
      else if (line.startsWith("<<", i)) {
        i += line[i + 2] === "-" ? 3 : 2;
        const doc = readDelimiter();
        cmdHeredocs.push(doc);
        waiting.push(doc);
        return;
      } else {
        i++;
        while (i < line.length && "<>&|".includes(line[i])) i++;
      }
      skipTarget = true;
    };

    while (i < line.length) {
      const c = line[i];
      if (c === "\n") {
        endCommand();
        i++;
        readBodies(waiting);
        waiting = [];
      } else if (c === " " || c === "\t") {
        endWord();
        i++;
      } else if (c === "#" && word === null) {
        while (i < line.length && line[i] !== "\n") i++;
      } else if ((c === "<" || c === ">") && line[i + 1] === "(") {
        // <(...) and >(...): the commands inside run.
        i += 2;
        substitute(parse(true));
      } else if (line.startsWith("$((", i) || line.startsWith("((", i)) {
        // Arithmetic: no commands, and `<<` in it is a shift, not a heredoc.
        startWord();
        word.dynamic = true;
        word.splits = true;
        i = skipParens(i + (c === "$" ? 1 : 0));
      } else if (c === "(" && word !== null && word.text.endsWith("=")) {
        // name=(a b c): array elements, not a subshell.
        word.dynamic = true;
        i = skipParens(i);
      } else if (c === "<" || c === ">" || (c === "&" && line[i + 1] === ">")) {
        if (c === "&") i++;
        redirection();
      } else if (c === "(") {
        endCommand();
        depth++;
        items.push({ type: "push" });
        i++;
      } else if (c === ")") {
        endCommand();
        i++;
        if (depth > 0) {
          depth--;
          items.push({ type: "pop" });
        } else if (nested) {
          return items;
        }
      } else if (c === ";" || c === "&" || c === "|") {
        endCommand();
        i += line[i + 1] === c ? 2 : 1;
      } else if (line.startsWith("$(", i) && line[i + 2] !== "(") {
        i += 2;
        substitute(parse(true));
      } else if (c === "`") {
        substitute(backtick());
      } else if (c === "\\" && line[i + 1] === "\n") {
        i += 2; // a line continuation joins two lines and adds no word
      } else if (c === "\\") {
        startWord();
        word.text += line[i + 1] ?? "";
        i += 2;
      } else if (c === "'") {
        startWord();
        const close = line.indexOf("'", i + 1);
        if (close === -1) throw new Error("unterminated '");
        word.text += line.slice(i + 1, close);
        i = close + 1;
      } else if (c === '"') {
        startWord();
        i++;
        while (i < line.length && line[i] !== '"') {
          if (line[i] === "\\" && '"\\$`'.includes(line[i + 1])) {
            word.text += line[i + 1];
            i += 2;
          } else if (line.startsWith("$(", i)) {
            i += 2;
            substitute(parse(true), true);
          } else if (line[i] === "`") {
            substitute(backtick(), true);
          } else {
            if (line[i] === "$") word.dynamic = true;
            word.text += line[i];
            i++;
          }
        }
        if (i >= line.length) throw new Error('unterminated "');
        i++;
      } else {
        startWord();
        if ("$*?[".includes(c) || (c === "~" && word.text === "")) word.dynamic = true;
        if ("$*?[".includes(c)) word.splits = true;
        word.text += c;
        i++;
      }
    }
    if (nested) throw new Error("unterminated $(");
    endCommand();
    return items;
  }

  return parse(false);
}

// ------------------------------------------------------- reading a command

const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "time"]);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

// Wrappers that run the command after them, with their options that take a
// separate value. `positional` is how many plain words come before the command.
const WRAPPERS = {
  env: { values: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"], rewrites: ["-C", "--chdir", "-S", "--split-string"] },
  sudo: { values: ["-u", "-g", "-h", "-p", "-C", "-U", "-r", "-t", "-T", "-D"] },
  nice: { values: ["-n", "--adjustment"] },
  timeout: { values: ["-s", "--signal", "-k", "--kill-after"], positional: 1 },
  xargs: { values: ["-n", "-I", "-L", "-P", "-d", "-E", "-s", "-a"] },
  watch: { values: ["-n", "--interval", "-d"] },
  stdbuf: { values: ["-i", "-o", "-e"] },
  nohup: {},
  command: {},
  exec: { values: ["-a"] },
  builtin: {},
  noglob: {},
  nocorrect: {},
};

// The program and arguments of a simple command, past keywords, NAME=value
// prefixes and wrappers. Returns { env, program, args, wrappers } or null.
// env maps each NAME= prefix to its value, or to null when the value is
// built at run time.
// A wrapper option that changes what runs (env -C, env -S) makes the
// program dynamic, so callers treat it as unreadable.
export function programOf(words) {
  const env = {};
  const wrappers = [];
  let i = 0;
  let dynamic = false;
  for (;;) {
    while (i < words.length && !words[i].dynamic && KEYWORDS.has(words[i].text)) {
      i++;
      while (words[i] && words[i].text.startsWith("-")) i++; // time -p
    }
    const assign = words[i] && ASSIGNMENT.exec(words[i].text);
    if (assign) {
      env[assign[1]] = words[i].dynamic ? null : assign[2];
      i++;
      continue;
    }
    const wrapper = words[i] && !words[i].dynamic && WRAPPERS[path.basename(words[i].text)];
    if (wrapper) {
      wrappers.push(path.basename(words[i].text));
      i++;
      while (words[i] && words[i].text.startsWith("-") && words[i].text !== "--") {
        const flag = words[i].text.split("=")[0];
        const rewrites = wrapper.rewrites ?? [];
        // -S'...' glued to its value counts as -S.
        if (rewrites.includes(flag) || (/^-[a-zA-Z]./.test(flag) && rewrites.includes(flag.slice(0, 2)))) dynamic = true;
        i += (wrapper.values ?? []).includes(words[i].text) ? 2 : 1;
      }
      if (words[i]?.text === "--") i++;
      i += wrapper.positional ?? 0;
      continue;
    }
    break;
  }
  // env -S 'gh pr merge 5' runs its value: a program the caller cannot read.
  if (i >= words.length) return dynamic ? { env, program: { text: "", dynamic: true }, args: [], wrappers } : null;
  const program = dynamic ? { ...words[i], dynamic: true } : words[i];
  return { env, program, args: words.slice(i + 1), wrappers };
}

export const nameOf = (call) => (call.program.dynamic ? null : path.basename(call.program.text));

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish"]);
// Shell options that take a separate value: bash -o pipefail, -O extglob,
// +o, and -euo pipefail (a cluster with o or O takes the next word).
const SHELL_VALUE_FLAGS = new Set(["--rcfile", "--init-file"]);
// A script file that is really stdin or a pipe.
const STDIN_FILE = /^(?:-|\/dev\/stdin|\/dev\/fd\/\d+|\/proc\/self\/fd\/\d+)$/;
const readsStdin = (word) => !word || word.dynamic || STDIN_FILE.test(word.text);
const OPAQUE = { script: null };

// What a command runs as a nested script, or null when it runs none (or
// runs a script file, which no hook reads):
//   { script, sameShell }  the literal script; sameShell for eval, whose cd
//                          moves the rest of the line
//   { script: null }       a script the walk cannot read: built at run time,
//                          or read from stdin, a pipe or <(...)
// eval, source and ., sh -c, bash reading stdin, busybox sh. Anything run
// under xargs gets its words from stdin, so it cannot be read either.
export function nestedScript(call) {
  const name = nameOf(call);
  let args = call.args;
  let shellName = name;
  if (name === "busybox" && args[0] && !args[0].dynamic) {
    shellName = path.basename(args[0].text);
    args = args.slice(1);
  }
  const runsScript = name === "eval" || name === "source" || name === "." || SHELLS.has(shellName ?? "");
  if (!runsScript) return null;
  if (call.wrappers.includes("xargs")) return OPAQUE;
  if (name === "eval") {
    return args.some((w) => w.dynamic) ? OPAQUE : { script: args.map((w) => w.text).join(" "), sameShell: true };
  }
  if (name === "source" || name === ".") return readsStdin(args[0]) ? OPAQUE : null;
  // Like the shell: read the options, then the first other word is the
  // script (with -c) or the script file. -s, or no word, reads stdin.
  let command = false;
  let stdin = false;
  for (let i = 0; i < args.length; i++) {
    const { text, dynamic } = args[i];
    if (dynamic) return OPAQUE;
    if (text === "--command") command = true;
    else if (SHELL_VALUE_FLAGS.has(text)) i++;
    else if (/^[-+][a-zA-Z]+$/.test(text)) {
      if (text[0] === "-" && text.includes("c")) command = true;
      if (text[0] === "-" && text.includes("s")) stdin = true;
      if (text.includes("o") || text.includes("O")) i++;
    } else if (text.startsWith("--") && text !== "--") {
      // --login, --norc: no value
    } else {
      const word = text === "--" ? args[i + 1] : args[i];
      if (command) return word && !word.dynamic ? { script: word.text, sameShell: false } : OPAQUE;
      return stdin || readsStdin(word) ? OPAQUE : null;
    }
  }
  return OPAQUE; // no script and no file: the shell reads stdin
}

// Resolve a directory word against base, or null when that cannot be known.
export function resolveDir(base, word) {
  if (base === null || !word || word.dynamic) return null;
  const text = word.text === "~" || word.text.startsWith("~/")
    ? path.join(os.homedir(), word.text.slice(1))
    : word.text;
  return path.resolve(base, text);
}

// Walk every simple command in a Bash command line, following cd, pushd,
// popd, subshells and $(...) scopes, and reading into `sh -c '...'` and
// `eval '...'`. Yields { call, dir, opaque }: dir is where the command runs,
// or null when a cd could not be followed; opaque is true when call runs a
// script the walk cannot read (see nestedScript). A `sh -c` or `eval` script inherits its
// caller's NAME= prefixes. Returns the directory the line ends in. Throws
// when the line cannot be lexed.
export function* walk(command, cwd, depth = 0, inherited = {}) {
  if (depth > 4) throw new Error("shells nested too deeply");
  let dir = cwd === null ? null : path.resolve(cwd);
  const scopes = [];
  const pushd = [];
  for (const item of lex(command)) {
    if (item.type === "push") {
      scopes.push({ dir, pushd: pushd.length });
      continue;
    }
    if (item.type === "pop") {
      const scope = scopes.pop();
      if (scope) {
        dir = scope.dir;
        pushd.length = scope.pushd;
      }
      continue;
    }
    const call = programOf(item.words);
    if (!call) continue;
    call.env = { ...inherited, ...call.env };
    const name = nameOf(call);
    if (name === "cd" || name === "pushd") {
      if (name === "pushd") pushd.push(dir);
      const target = call.args.find((w) => !w.text.startsWith("-") || w.text === "-");
      dir = target && target.text !== "-" ? resolveDir(dir, target) : null;
      continue;
    }
    if (name === "popd") {
      dir = pushd.length > 0 ? pushd.pop() : null;
      continue;
    }
    const nested = nestedScript(call);
    if (nested?.script != null) {
      const end = yield* walk(nested.script, dir, depth + 1, call.env);
      if (nested.sameShell) dir = end;
      continue;
    }
    yield nested ? { call, dir, opaque: true } : { call, dir };
  }
  return dir;
}

// ------------------------------------------------------------- plumbing

// The hook payload Claude Code writes to stdin, or null if it is not JSON.
export async function readPayload() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export const realpath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

// True when the module at `url` is the script node was started with.
export const isEntry = (url) =>
  Boolean(process.argv[1]) && realpath(process.argv[1]) === realpath(fileURLToPath(url));

// Refuse the tool call. exitCode, not exit(): stderr is a pipe and an
// immediate exit can cut the reason short.
export function refuse(reason) {
  process.stderr.write(`${reason}\n`);
  process.exitCode = 2;
}
