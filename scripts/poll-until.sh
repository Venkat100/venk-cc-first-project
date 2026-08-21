#!/usr/bin/env bash
# Bounded polling with a mandatory timeout and a loud, unambiguous exit.
#
# WHY THIS EXISTS (2026-08-21): a `until npx vercel ls | grep Ready; do
# sleep N; done`-style loop, hand-rolled and backgrounded, ran for 86 hours
# after the deploy it was waiting on had long since finished — ~60k wasted
# CLI calls, unnoticed until a manual `ps` check days later. Same failure
# shape this project keeps finding and fixing elsewhere (a stated policy
# — "don't poll forever" — is exactly the kind of thing that doesn't hold
# under repetition; a structural bound does). This script is the
# structural fix: every polling loop gets a `--timeout` up front, with NO
# default, so the caller cannot construct one without deciding how long
# "too long" is, and a timeout is never silent — it's a loud, non-zero-exit
# failure that names what it was waiting for and for how long.
#
# Usage:
#   scripts/poll-until.sh --timeout SECONDS [--interval SECONDS] -- <condition command...>
#
# Runs <condition command> every --interval seconds (default 5) until it
# exits 0 (success — prints elapsed time, exits 0) or --timeout seconds
# have elapsed (failure — prints a loud TIMED OUT message with elapsed
# time and attempt count, exits 1). Never runs longer than --timeout,
# regardless of what the condition command does.
#
# Example:
#   scripts/poll-until.sh --timeout 600 --interval 10 -- \
#     bash -c 'npx vercel ls venk-cc-first-project 2>/dev/null | grep -q "Ready"'

set -uo pipefail

TIMEOUT_SECONDS=""
INTERVAL_SECONDS=5

while [ $# -gt 0 ]; do
  case "$1" in
    --timeout)
      TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --interval)
      INTERVAL_SECONDS="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      echo "poll-until.sh: unrecognized argument '$1' (expected --timeout, --interval, or --)" >&2
      exit 2
      ;;
  esac
done

if [ -z "$TIMEOUT_SECONDS" ]; then
  echo "poll-until.sh: --timeout SECONDS is REQUIRED — there is no infinite default, on purpose (see this script's header)." >&2
  exit 2
fi
if ! [[ "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || [ "$TIMEOUT_SECONDS" -le 0 ]; then
  echo "poll-until.sh: --timeout must be a positive integer number of seconds, got '$TIMEOUT_SECONDS'." >&2
  exit 2
fi
if ! [[ "$INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || [ "$INTERVAL_SECONDS" -le 0 ]; then
  echo "poll-until.sh: --interval must be a positive integer number of seconds, got '$INTERVAL_SECONDS'." >&2
  exit 2
fi
if [ $# -eq 0 ]; then
  echo "poll-until.sh: no condition command given — usage: poll-until.sh --timeout SECONDS [--interval SECONDS] -- <command...>" >&2
  exit 2
fi

COND_DESC="$*"
START_TS=$(date +%s)
ATTEMPT=0

echo "poll-until.sh: polling every ${INTERVAL_SECONDS}s, up to ${TIMEOUT_SECONDS}s total, for: ${COND_DESC}"

while true; do
  ATTEMPT=$((ATTEMPT + 1))
  if "$@"; then
    ELAPSED=$(( $(date +%s) - START_TS ))
    echo "poll-until.sh: condition succeeded after ${ELAPSED}s (${ATTEMPT} attempt(s))."
    exit 0
  fi

  NOW_TS=$(date +%s)
  ELAPSED=$((NOW_TS - START_TS))
  if [ "$ELAPSED" -ge "$TIMEOUT_SECONDS" ]; then
    echo "poll-until.sh: TIMED OUT after ${ELAPSED}s (${ATTEMPT} attempt(s)) waiting for: ${COND_DESC}" >&2
    echo "poll-until.sh: this is a HARD STOP — the condition never succeeded and this loop will not run any longer. Investigate manually; do not just re-run with a bigger --timeout without checking why it didn't succeed." >&2
    exit 1
  fi

  sleep "$INTERVAL_SECONDS"
done
