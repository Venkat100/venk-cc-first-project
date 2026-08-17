#!/usr/bin/env bash
# Runs the full verify-*.ts regression suite, one script at a time, with a
# stagger delay between scripts.
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
# Usage:
#   ./verify-suite.sh                    # default 5s stagger
#   VERIFY_STAGGER_SECONDS=10 ./verify-suite.sh
#   ./verify-suite.sh verify-insights.ts verify-journal.ts   # run a subset
set -uo pipefail
cd "$(dirname "$0")"

STAGGER_SECONDS="${VERIFY_STAGGER_SECONDS:-5}"
SCRIPTS=("$@")
if [ ${#SCRIPTS[@]} -eq 0 ]; then
  SCRIPTS=(verify-*.ts)
fi

PASSED=0
FAILED=()
TOTAL=${#SCRIPTS[@]}
i=0

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
  if npx vite-node "$f"; then
    PASSED=$((PASSED + 1))
  else
    FAILED+=("$f")
  fi
  if [ "$i" -lt "${#SCRIPTS[@]}" ]; then
    sleep "$STAGGER_SECONDS"
  fi
done

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  $PASSED/$TOTAL passed"
if [ ${#FAILED[@]} -gt 0 ]; then
  printf '  FAILED: %s\n' "${FAILED[@]}"
  exit 1
fi
echo "  ALL GREEN ✅"
