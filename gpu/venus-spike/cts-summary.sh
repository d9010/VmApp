#!/usr/bin/env bash
# Summarise CTS result logs written by guest/scripts/tests/cts.sh:  cts-summary.sh TAG [TAG...]
# Works on the deqp stdout log, so it also gives counts for runs that were cut short (hang / timeout).
# Prints: cases listed, executed, Pass / Fail / NotSupported / QualityWarning / CompatibilityWarning / Waiver /
# InternalError / Crash, and the first failing case names.
set -uo pipefail
WORK="${VMAPP_WORK:?set VMAPP_WORK}"
for tag in "$@"; do
    log="$WORK/run/work/cts-$tag.log"
    list="$WORK/run/work/cts-$tag.list"
    [ -f "$log" ] || { echo "$tag: no log"; continue; }
    awk -v tag="$tag" -v listed="$( [ -f "$list" ] && wc -l <"$list" | tr -d ' ' || echo '?')" '
        /^Test case / { name=$3; sub(/^\x27/, "", name); sub(/\x27\.\.$/, "", name); next }
        /^  (Pass|Fail|NotSupported|QualityWarning|CompatibilityWarning|Waiver|InternalError|ResourceError|Crash|Timeout|Pending) / {
            r=$1; n[r]++; total++
            if (r != "Pass" && r != "NotSupported" && r != "QualityWarning" && r != "CompatibilityWarning" && r != "Waiver") { fails[++nf]=name " :: " $0 }
        }
        END {
            printf "%-28s listed=%s executed=%d", tag, listed, total
            for (r in n) printf "  %s=%d", r, n[r]
            printf "\n"
            for (i=1; i<=nf && i<=40; i++) printf "    %s\n", fails[i]
            if (nf>40) printf "    ... and %d more\n", nf-40
        }' "$log"
done
