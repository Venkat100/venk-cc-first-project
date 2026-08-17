#!/usr/bin/env bash
# Runs the full verify-*.ts regression suite, one script at a time, with a
# stagger delay between scripts, and a per-script INACTIVITY timeout so a
# hung script can never stall the whole run.
#
# ROOT CAUSE (PLAN.md §6d): the suite was being run as a flat-out, back-to-
# back loop with zero breathing room between scripts. Several verify-*.ts
# scripts share the SAME live Finnhub/Twelve Data rate-limit window; running
# them immediately adjacent to each other left no slack for that window to
# drain, and two separate incidents (three distinct scripts, same day) came
# from exactly that contention, not from any one script being fragile. This
# stagger is the first, structural half of the fix; the second half is
# verify-harness.ts's `withRetry` (rate-limit-aware backoff), applied only
# to SETUP-classified live-provider calls, never to a script's SUBJECT call.
#
# THIRD hang in this project's history (2026-08-17): verify-harness.test.ts
# (a vitest spec, no runVerification() call) matched this script's own
# verify-*.ts glob and vite-node tried to run it as a live script — it hung
# with zero output, and the ONLY thing that stopped the run was a human
# noticing the terminal had gone quiet. The glob collision was the trigger;
# the actual gap is what this timeout closes: a script that emits nothing
# for VERIFY_INACTIVITY_TIMEOUT_SECONDS is killed, marked failed with a
# clear reason, and the run continues — independent of what caused the
# hang, so the *next* accidental collision (or a genuine bug in some future
# script) can't repeat this incident.
#
# N = 300s (5 minutes), chosen against the slowest known legitimate silent
# gap in the suite: verify-live-prices.ts runs two 120-second (2-minute)
# steps with a single before/after log line each — 120s of real, expected
# silence while it polls in the background. 300s gives that ~2.5x headroom
# (150% margin) before the watchdog would ever second-guess a script that's
# actually still working, while still catching a genuine hang in a small
# fraction of runVerification()'s own 8-minute global ceiling (verify-
# harness.ts's structural backstop for a single stuck AWAIT inside a
# script) — this timeout exists for the class of hang that ceiling can't
# catch: a script with no runVerification() wrapper at all, exactly what
# happened here.
#
# Usage:
#   ./verify-suite.sh                    # default 5s stagger, 300s inactivity timeout
#   VERIFY_STAGGER_SECONDS=10 ./verify-suite.sh
#   VERIFY_INACTIVITY_TIMEOUT_SECONDS=120 ./verify-suite.sh
#   ./verify-suite.sh verify-insights.ts verify-journal.ts   # run a subset
set -uo pipefail
cd "$(dirname "$0")"
set -m  # job control: each backgrounded script gets its own process group,
        # so `kill -- -$pid` on inactivity takes the whole vite-node/node
        # tree with it, not just the immediate child.

STAGGER_SECONDS="${VERIFY_STAGGER_SECONDS:-5}"
INACTIVITY_TIMEOUT_SECONDS="${VERIFY_INACTIVITY_TIMEOUT_SECONDS:-300}"
POLL_SECONDS=5

SCRIPTS=("$@")
if [ ${#SCRIPTS[@]} -eq 0 ]; then
  # verify-*.ts also matches vitest specs like verify-harness.test.ts (see
  # header). Vitest specs run under `npm run test`, not this suite; exclude
  # *.test.ts explicitly rather than relying on the glob to not collide
  # with future test filenames.
  SCRIPTS=()
  for f in verify-*.ts; do
    [[ "$f" == *.test.ts ]] && continue
    SCRIPTS+=("$f")
  done
fi

PASSED=0
FAILED=()
FAILREASONS=()
TOTAL=${#SCRIPTS[@]}
i=0

# Runs one script with an inactivity watchdog. Streams output live to the
# terminal (via `tail -f` on the same file the script writes to) while a
# separate loop watches that file's size — no growth for
# INACTIVITY_TIMEOUT_SECONDS means the script is killed (whole process
# group) and treated as a failure. Sets $LAST_EXIT_REASON on timeout.
run_one() {
  local script="$1"
  local outfile
  outfile=$(mktemp "${TMPDIR:-/tmp}/verify-suite.XXXXXX")
  LAST_EXIT_REASON=""

  npx vite-node "$script" > "$outfile" 2>&1 &
  local pid=$!
  tail -f -n +1 "$outfile" &
  local tail_pid=$!

  local last_size=-1
  local stalled_for=0
  local exit_code=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep "$POLL_SECONDS"
    local cur_size
    cur_size=$(wc -c < "$outfile" 2>/dev/null | tr -d ' ')
    cur_size=${cur_size:-0}
    if [ "$cur_size" = "$last_size" ]; then
      stalled_for=$((stalled_for + POLL_SECONDS))
    else
      stalled_for=0
      last_size=$cur_size
    fi
    if [ "$stalled_for" -ge "$INACTIVITY_TIMEOUT_SECONDS" ]; then
      echo ""
      echo "  ⚠ INACTIVITY TIMEOUT: no output for ${INACTIVITY_TIMEOUT_SECONDS}s — killing $script"
      kill -- -"$pid" 2>/dev/null
      sleep 1
      kill -9 -- -"$pid" 2>/dev/null
      LAST_EXIT_REASON="inactivity timeout — no output for ${INACTIVITY_TIMEOUT_SECONDS}s"
      exit_code=124
      break
    fi
  done
  if [ -z "$LAST_EXIT_REASON" ]; then
    wait "$pid"
    exit_code=$?
  fi
  kill "$tail_pid" 2>/dev/null
  wait "$tail_pid" 2>/dev/null
  rm -f "$outfile"
  return $exit_code
}

for f in "${SCRIPTS[@]}"; do
  i=$((i + 1))
  if [ "$f" = "verify-harness.ts" ]; then
    TOTAL=$((TOTAL - 1))
    continue
  fi
  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo "  [$i/${#SCRIPTS[@]}] $f"
  echo "════════════════════════════════════════════════════════════════"
  if run_one "$f"; then
    PASSED=$((PASSED + 1))
  else
    FAILED+=("$f")
    FAILREASONS+=("${LAST_EXIT_REASON:-non-zero exit}")
  fi
  if [ "$i" -lt "${#SCRIPTS[@]}" ]; then
    sleep "$STAGGER_SECONDS"
  fi
done

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  $PASSED/$TOTAL passed"
if [ ${#FAILED[@]} -gt 0 ]; then
  for idx in "${!FAILED[@]}"; do
    echo "  FAILED: ${FAILED[$idx]} — ${FAILREASONS[$idx]}"
  done
  exit 1
fi
echo "  ALL GREEN ✅"
