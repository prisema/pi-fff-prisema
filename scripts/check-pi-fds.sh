#!/usr/bin/env bash
set -euo pipefail

# Usage: run inside a Pi bash tool call or child shell.
# Shows FD pressure in the parent Pi process.

pi_pid="$(ps -o ppid= -p $$ | tr -d ' ')"
echo "pi_pid=${pi_pid}"
echo "total_fds=$(lsof -nP -p "${pi_pid}" 2>/dev/null | wc -l | tr -d ' ')"
echo "dir_fds=$(lsof -nP -p "${pi_pid}" 2>/dev/null | awk '$5=="DIR"{n++} END{print n+0}')"
echo "top_dir_parents:"
lsof -nP -p "${pi_pid}" 2>/dev/null \
  | awk '$5=="DIR"{print $9}' \
  | sed 's#/[^/]*$##' \
  | sort \
  | uniq -c \
  | sort -nr \
  | head -20
