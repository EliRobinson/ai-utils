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
#
# Prints the --gremlins arguments to pass to survivors.py.
# Env: GREMLINS (binary path), MGT_WORKERS (default 4), MGT_TIMEOUT
#      (timeout coefficient, default 10), MGT_GOFLAGS (extra GOFLAGS, e.g. -short).
set -euo pipefail

usage() { sed -n '2,16p' "$0" >&2; exit 2; }
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

repo=$(git rev-parse --show-toplevel)
src="$repo/$module"
[ -f "$src/go.mod" ] || { echo "go_mutate: no go.mod in $src" >&2; exit 2; }

gremlins=${GREMLINS:-$(command -v gremlins || true)}
if [ -z "$gremlins" ] || [ ! -x "$gremlins" ]; then
  echo "go_mutate: gremlins not found. Install it into a local GOBIN, not globally:" >&2
  echo "  GOBIN=\$PWD/.tools/bin go install github.com/go-gremlins/gremlins/cmd/gremlins@v0.6.0" >&2
  echo "and set GREMLINS=\$PWD/.tools/bin/gremlins (see reference/go.md)" >&2
  exit 2
fi

out=${out:-$(mktemp -d "${TMPDIR:-/tmp}/mgt-go-out.XXXXXX")}
mkdir -p "$out"
out=$(cd "$out" && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/mgt-go-copy.XXXXXX")
trap 'rm -rf "$work"' EXIT

# 1. Copy the module and make every relative replace path absolute.
rsync -a --exclude .git --exclude node_modules "$src/" "$work/mod/"
python3 - "$src" "$work/mod/go.mod" <<'PY'
import os, re, sys
src, gomod = sys.argv[1], sys.argv[2]
# `=> ./x` or `=> ../x`, quoted or not, on a replace line or in a replace block.
target = re.compile(r'(=>\s*)("?)(\.\.?/[^\s"]*)\2')
out, in_block = [], False
with open(gomod) as f:
    for line in f:
        code = line.split("//", 1)[0].strip()
        if code.startswith("replace") and code.rstrip().endswith("("):
            in_block = True
        elif in_block and code == ")":
            in_block = False
        elif in_block or code.startswith("replace "):
            line = target.sub(lambda m: m.group(1) + m.group(2)
                              + os.path.normpath(os.path.join(src, m.group(3))) + m.group(2), line)
        out.append(line)
with open(gomod, "w") as f:
    f.writelines(out)
PY

# 2. Mutate each package, changed files only.
status=0
for pkg in "${pkgs[@]}"; do
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
    for f in "$dir"/*.go; do
      [ -e "$f" ] || continue
      case $f in *_test.go) continue ;; esac
      relf=${f#"$work/mod/"}
      case " $files " in
        *" $relf "*) ;;
        *) base=$(basename "$f"); flags+=(--exclude-files "(^|/)${base//./\\.}\$") ;;
      esac
    done
  fi
  name=$(echo "${rel:-root}" | tr '/' '_')
  report="$out/$name.json"
  echo "== gremlins $pkg (${flags[*]})" >&2
  start=$(date +%s)
  if ! (cd "$work/mod" && GOFLAGS="-count=1 ${MGT_GOFLAGS:-}" "$gremlins" unleash "${flags[@]}" ${extra[@]+"${extra[@]}"} -o "$report" "./$rel") >&2; then
    status=1
  fi
  echo "   took $(( $(date +%s) - start ))s" >&2
  if [ ! -f "$report" ]; then
    echo "go_mutate: gremlins wrote no report for $pkg" >&2
    status=1
    continue
  fi
  # "Runnable: 0": nothing was mutated, or no test reached the mutants.
  ran=$(python3 -c '
import json, sys
rep = json.load(open(sys.argv[1]))
print(sum(m.get("status") in ("KILLED", "LIVED", "TIMED OUT")
          for f in rep.get("files") or [] for m in f.get("mutations") or []))
' "$report")
  if [ "$ran" = 0 ]; then
    echo "go_mutate: no mutant ran for $pkg (Runnable: 0). Check --files, or use --integration" \
         "or the package that tests it; this is not a clean result." >&2
    status=1
  fi
  echo "--gremlins $module${rel:+/$rel}=$report"
done
exit $status
