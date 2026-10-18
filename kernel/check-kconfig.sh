#!/usr/bin/env bash
# check-kconfig.sh - fail unless a final kernel .config satisfies the vmapp required/forbidden option lists.
#
# Adapted from d9010-native/tools/build-rootfs/check-kconfig.sh
#
# usage: check-kconfig.sh [--source-tree DIR] CONFIG REQUIRED FORBIDDEN
#
#   CONFIG     final .config (after `make olddefconfig`)
#   REQUIRED   kernel/kconfig-required.txt
#   FORBIDDEN  kernel/kconfig-forbidden.txt
#   --source-tree DIR  also verify that every symbol/glob named in the two lists exists in the Kconfig files
#              below DIR, so a typo or an upstream rename cannot silently neuter a check.
#
# Exit status: 0 all checks passed, 1 at least one deviation, 2 usage/input error.
# Runs with bash >= 3.2 and a POSIX awk (BSD awk, mawk, gawk).

set -euo pipefail

usage() {
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
}

srctree=""
if [ "${1:-}" = "--source-tree" ]; then
    [ $# -ge 2 ] || usage
    srctree=$2
    shift 2
fi
[ $# -eq 3 ] || usage
config=$1
required=$2
forbidden=$3

for f in "$config" "$required" "$forbidden"; do
    if [ ! -f "$f" ]; then
        echo "check-kconfig: no such file: $f" >&2
        exit 2
    fi
done

symfile=""
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/check-kconfig.XXXXXX")
cleanup() {
    case "$tmpdir" in
        */check-kconfig.*) rm -rf -- "$tmpdir" ;;
    esac
}
trap cleanup EXIT

if [ -n "$srctree" ]; then
    if [ ! -d "$srctree" ]; then
        echo "check-kconfig: no such directory: $srctree" >&2
        exit 2
    fi
    symfile=$tmpdir/symbols.txt
    (cd "$srctree" && grep -rhoE '^[[:space:]]*(menu)?config[[:space:]]+[A-Za-z0-9_]+' --include='Kconfig*' .) |
        awk '{ print $2 }' | LC_ALL=C sort -u >"$symfile"
    if [ ! -s "$symfile" ]; then
        echo "check-kconfig: no Kconfig symbols found below $srctree" >&2
        exit 2
    fi
else
    : >"$tmpdir/symbols.txt"
    symfile=$tmpdir/symbols.txt
fi

have_tree=0
[ -n "$srctree" ] && have_tree=1

# File order matters: 1 = .config, 2 = required, 3 = forbidden, 4 = symbols.
awk -v have_tree="$have_tree" '
function trim(s) { sub(/^[ \t\r]+/, "", s); sub(/[ \t\r]+$/, "", s); return s }
function fail(msg) { print "FAIL " msg | "LC_ALL=C sort"; nfail++ }
FNR == 1 { fileidx++ }
fileidx == 1 {
    if (match($0, /^CONFIG_[A-Za-z0-9_]+=/)) {
        name = substr($0, 8, RLENGTH - 8)
        cfg[name] = substr($0, RLENGTH + 1)
    } else if ($0 ~ /^# CONFIG_[A-Za-z0-9_]+ is not set$/) {
        name = $0
        sub(/^# CONFIG_/, "", name)
        sub(/ is not set$/, "", name)
        cfg[name] = "n"
    }
    next
}
fileidx == 2 {
    line = trim($0)
    if (line == "" || substr(line, 1, 1) == "#") next
    if (!match(line, /^CONFIG_[A-Za-z0-9_]+=/)) {
        fail("required list: unparsable line: " line)
        next
    }
    name = substr(line, 8, RLENGTH - 8)
    want = substr(line, RLENGTH + 1)
    nreq++
    reqname[nreq] = name
    reqwant[nreq] = want
    next
}
fileidx == 3 {
    line = $0
    sub(/#.*$/, "", line)
    line = trim(line)
    if (line == "") next
    isexempt = 0
    if (substr(line, 1, 1) == "!") {
        isexempt = 1
        line = trim(substr(line, 2))
    }
    sub(/^CONFIG_/, "", line)
    valid = isexempt ? (line ~ /^[A-Za-z0-9_]+$/) : (line ~ /^[A-Za-z0-9_*]+$/)
    if (!valid) {
        fail("forbidden list: invalid pattern: " line)
        next
    }
    if (isexempt) {
        nexempt++
        exemptname[nexempt] = line
        next
    }
    nforb++
    forbpat[nforb] = line
    next
}
fileidx == 4 { sym[$1] = 1; next }
END {
    for (i = 1; i <= nreq; i++) {
        n = reqname[i]; w = reqwant[i]
        have = (n in cfg) ? cfg[n] : "n"
        if (w == "n") {
            if (have != "n") fail("required off: CONFIG_" n " is " have)
        } else if (have != w) {
            fail("required: CONFIG_" n "=" w " expected, found " ((n in cfg) ? (n "=" cfg[n]) : "absent/not set"))
        }
        if (have_tree && !(n in sym)) fail("required list names unknown Kconfig symbol: CONFIG_" n)
    }
    for (i = 1; i <= nforb; i++) {
        pat = forbpat[i]
        re = pat
        gsub(/\*/, "[A-Z0-9_]*", re)
        re = "^" re "$"
        isglob = (index(pat, "*") > 0)
        hits = 0
        for (n in cfg) {
            if (n ~ re && cfg[n] != "n") {
                skip = 0
                for (j = 1; j <= nexempt; j++) if (exemptname[j] == n) skip = 1
                if (!skip) fail("forbidden: CONFIG_" n "=" cfg[n] " (pattern " pat ")")
            }
        }
        if (have_tree) {
            for (s in sym) if (s ~ re) hits++
            if (hits == 0) {
                if (isglob) fail("forbidden list: glob matches no Kconfig symbol: " pat)
                else fail("forbidden list names unknown Kconfig symbol: CONFIG_" pat)
            }
        }
    }
    for (j = 1; j <= nexempt; j++) {
        if (have_tree && !(exemptname[j] in sym)) fail("forbidden list: exemption names unknown Kconfig symbol: CONFIG_" exemptname[j])
    }
    close("LC_ALL=C sort")
    printf "check-kconfig: %d required, %d forbidden patterns (%d exemptions), %d deviation(s)\n", nreq, nforb, nexempt + 0, nfail + 0
    exit (nfail > 0) ? 1 : 0
}
' "$config" "$required" "$forbidden" "$symfile"
