#!/usr/bin/env bash
# Run Gremlins on changed Go packages without its known traps.
#
# Usage (from inside the repo):
#   bash go_mutate.sh <module-dir> [--files 'a.go pkg/b.go'] [--out DIR] [--integration] <pkg>... [-- FLAGS]
#
#   <module-dir>  repo-relative dir holding go.mod
#   --files       module-relative changed files; the other .go files in each
#                 package are excluded, so only changed files get mutated
#   --out         where the JSON reports go (default: a new temp dir)
#   --integration run the whole module's tests per mutant (for packages whose
#                 tests live elsewhere); added on its own for a package
#                 that has no _test.go files
#   <pkg>         module-relative package path, e.g. ./auth
#   -- FLAGS      anything after -- goes to gremlins as is (e.g. --coverpkg=./...)
#
# Traps handled:
#   - Gremlins copies only the module dir, so relative `replace` paths break
#     every build and each broken build counts as KILLED (a false 100%).
#     We mutate a copy whose replaces are absolute.
#   - Cached test results shrink Gremlins' timeouts: GOFLAGS=-count=1.
#   - The default timeout coefficient is too tight for fast packages.
#   - A run where no mutant ran ("Runnable: 0") is a failure, not a clean result.
#   - A go.work above the module would pull in other modules: GOWORK=off.
#
# Prints the --gremlins arguments to pass to survivors.py, shell-quoted.
# Env: GREMLINS (binary path), MGT_WORKERS (default 4), MGT_TIMEOUT
#      (timeout coefficient, default 10), MGT_GOFLAGS (extra GOFLAGS, e.g. -short).
set -euo pipefail

usage() { sed -n '2,16s/^# \{0,1\}//p' "$0" >&2; exit 2; }
[ $# -ge 2 ] || usage

module=$1; shift
files="" out="" integration=""
pkgs=()
extra=()
while [ $# -gt 0 ]; do
  case $1 in
    --files) [ $# -ge 2 ] || usage; files=$2; shift 2 ;;
    --out) [ $# -ge 2 ] || usage; out=$2; shift 2 ;;
    --integration) integration=1; shift ;;
    -h|--help) usage ;;
    --) shift; extra=("$@"); break ;;
    -*) echo "go_mutate: unknown option $1" >&2; usage ;;
    *) pkgs+=("$1"); shift ;;
  esac
done
[ ${#pkgs[@]} -gt 0 ] || usage

here=$(cd "$(dirname "$0")" && pwd)
repo=$(git rev-parse --show-toplevel)
src="$repo/$module"
[ -f "$src/go.mod" ] || { echo "go_mutate: no go.mod in $src" >&2; exit 2; }

gremlins=${GREMLINS:-$(command -v gremlins || true)}
if [ -z "$gremlins" ] || [ ! -x "$gremlins" ]; then
  echo "go_mutate: gremlins not found. Install it into a local GOBIN, not globally," >&2
  echo "and point GREMLINS at it: see \"Install\" in reference/go.md." >&2
  exit 2
fi

out=${out:-$(mktemp -d "${TMPDIR:-/tmp}/mgt-go-out.XXXXXX")}
mkdir -p "$out"
out=$(cd "$out" && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/mgt-go-copy.XXXXXX")
trap 'rm -rf "$work"' EXIT

# 1. Copy the module and make every relative replace path absolute.
rsync -a --exclude .git --exclude node_modules "$src/" "$work/mod/"
python3 -I - "$src" "$work/mod/go.mod" <<'PY'
import os, re, sys
src, gomod = sys.argv[1], sys.argv[2]
# `=> ./x` or `=> ../x`, quoted or not, on a replace line or in a replace block.
target = re.compile(r'(=>\s*)("?)(\.\.?/[^\s"]*)\2')


def absolute(m):
    path = os.path.normpath(os.path.join(src, m.group(3)))
    quote = m.group(2) or ('"' if re.search(r"\s", path) else "")
    return m.group(1) + quote + path + quote


out, in_block = [], False
with open(gomod) as f:
    for line in f:
        code = line.split("//", 1)[0].strip()
        if code.startswith("replace") and code.rstrip().endswith("("):
            in_block = True
        elif in_block and code == ")":
            in_block = False
        elif in_block or code.startswith("replace "):
            line = target.sub(absolute, line)
        out.append(line)
with open(gomod, "w") as f:
    f.writelines(out)
PY

# survivors.gremlins_ran counts the mutants that ran; check it loads once, so a
# broken import is not reported as an unreadable report for every package.
count_ran='import json, sys; sys.path.insert(0, sys.argv[1]); import survivors
print(survivors.gremlins_ran(json.load(open(sys.argv[2]))) if len(sys.argv) > 2 else "")'
python3 -I -c "$count_ran" "$here" >/dev/null || {
  echo "go_mutate: cannot load survivors.py from $here" >&2; exit 2; }

# 2. Mutate each package, changed files only.
status=0 i=0
for pkg in "${pkgs[@]}"; do
  i=$((i + 1))
  rel=${pkg#./}
  [ "$rel" = "." ] && rel=""
  dir="$work/mod${rel:+/$rel}"
  [ -d "$dir" ] || { echo "go_mutate: no package $pkg in $module" >&2; status=1; continue; }
  flags=(--timeout-coefficient "${MGT_TIMEOUT:-10}" --workers "${MGT_WORKERS:-4}"
         --invert-logical --invert-loopctrl --invert-assignments --invert-bitwise
         --invert-bwassign --remove-self-assignments)
  if [ -n "$integration" ] || ! ls "$dir"/*_test.go >/dev/null 2>&1; then
    flags+=(--integration)
  fi
  if [ -n "$files" ]; then
    # Gremlins matches each pattern against the path relative to the package
    # it mutates (subpackages included), so anchor on that path: an unchanged
    # util.go must not hide a changed sub/util.go.
    while IFS= read -r -d '' f; do
      relf=${f#"$work/mod/"}
      prel=${f#"$dir/"}
      case " $files " in
        *" $relf "*) ;;
        *) flags+=(--exclude-files "^$(printf '%s' "$prel" | sed 's/[][\.*^$+?(){}|]/\\&/g')\$") ;;
      esac
    done < <(find "$dir" -name '*.go' ! -name '*_test.go' -print0)
  fi
  name="$i-$(echo "${rel:-root}" | tr '/' '_')"
  report="$out/$name.json"
  echo "== gremlins $pkg (${flags[*]})" >&2
  start=$(date +%s)
  if ! (cd "$work/mod" && GOWORK=off GOFLAGS="${GOFLAGS:-} -count=1 ${MGT_GOFLAGS:-}" "$gremlins" unleash "${flags[@]}" ${extra[@]+"${extra[@]}"} -o "$report" "./$rel") >&2; then
    status=1
  fi
  echo "   took $(( $(date +%s) - start ))s" >&2
  if [ ! -f "$report" ]; then
    echo "go_mutate: gremlins wrote no report for $pkg" >&2
    status=1
    continue
  fi
  # "Runnable: 0": nothing was mutated, or no test reached the mutants.
  if ! ran=$(python3 -I -c "$count_ran" "$here" "$report" 2>/dev/null); then
    echo "go_mutate: cannot read the report for $pkg ($report)" >&2
    status=1
    continue
  fi
  if [ "$ran" = 0 ]; then
    echo "go_mutate: no mutant ran for $pkg (Runnable: 0). This is not a clean result." \
         "Check --files, rerun with --integration, or pass the package whose tests cover this code." >&2
    status=1
  fi
  printf -- '--gremlins %q\n' "$module${rel:+/$rel}=$report"
done
exit $status
