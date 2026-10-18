#!/usr/bin/env bash
# Compare a CTS group run natively (deqp-vk on macOS through MoltenVK) with the same case list run in the VM (Venus):
#   cts-compare.sh NATIVE_LOG VM_LOG
# Prints per-result counts of both runs and the cases whose outcome differs (the Venus-induced differences).
set -uo pipefail
nat="${1:?native log}"; vm="${2:?vm log}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/ctscmp.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
extract() { # log -> "case<TAB>result"
    awk '/^Test case /{n=$3; sub(/^\x27/,"",n); sub(/\x27\.\.$/,"",n); next}
         /^  (Pass|Fail|NotSupported|QualityWarning|CompatibilityWarning|Waiver|InternalError|ResourceError|Crash|Timeout) /{print n "\t" $1}' "$1" | LC_ALL=C sort
}
extract "$nat" >"$tmp/n"; extract "$vm" >"$tmp/v"
for x in n v; do
    printf '%s: ' "$([ $x = n ] && echo native || echo venus )"
    cut -f2 "$tmp/$x" | sort | uniq -c | awk '{printf "%s=%s ", $2, $1} END{print ""}'
done
echo "cases in both: $(join -t $'\t' "$tmp/n" "$tmp/v" | wc -l | tr -d ' ')"
echo "outcome differs (native -> venus), summary:"
join -t $'\t' "$tmp/n" "$tmp/v" | awk -F'\t' '$2 != $3 {print $2 " -> " $3}' | sort | uniq -c | sort -rn
echo "examples (first 25):"
join -t $'\t' "$tmp/n" "$tmp/v" | awk -F'\t' '$2 != $3 {print "  " $1 "  (" $2 " -> " $3 ")"}' | head -25
