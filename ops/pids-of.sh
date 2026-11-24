#!/bin/sh
# Print the PID of every process whose command line matches the grep pattern $1.
#
# Usage: sh ops/pids-of.sh "[s]cripts/scout-watch.ts"
#
# Bracket the first letter of the pattern, as in the example. The caller's own command
# line then holds the bracketed text, which the pattern does not match.
#
# The script reads /proc, not `ps`: the `ps` columns differ between systems. BusyBox
# (the NAS) prints PID first and the user second, and procps prints the user first.
# A column parse of `ps -ef` returned the user name on the NAS (2026-11-24).
# `tr` replaces the NUL separators of cmdline, because some BusyBox grep builds stop
# at the first NUL.
[ -n "$1" ] || { echo "usage: pids-of.sh PATTERN" >&2; exit 2; }
for f in /proc/[0-9]*/cmdline; do
    if { tr '\0' ' ' < "$f"; } 2>/dev/null | grep -q "$1"; then
        f="${f#/proc/}"
        echo "${f%/cmdline}"
    fi
done
exit 0
