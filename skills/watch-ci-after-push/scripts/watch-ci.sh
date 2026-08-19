#!/usr/bin/env bash
# Watch all CI runs for a commit: discover them (with registration-lag
# polling), wait for each, report pass/fail with failing-job log excerpts.
# Usage: watch-ci.sh [<full-sha>]   (defaults to HEAD)
# Exit 0: all runs passed. 1: at least one run concluded non-success.
# 2: no runs registered, or gh itself failed (discovery or status checks).
set -euo pipefail

# Full SHA required: gh run list --commit silently matches nothing for short SHAs.
sha="${1:-$(git rev-parse HEAD)}"

run_ids=""
for attempt in 1 2 3 4 5; do
  # || true: a gh failure (auth, non-GitHub remote) must not masquerade as
  # a red pipeline via set -e; it falls through to the exit-2 path below.
  run_ids="$(gh run list --commit "$sha" --json databaseId --jq '.[].databaseId' || true)"
  [ -n "$run_ids" ] && break
  [ "$attempt" -lt 5 ] && sleep 3
done

if [ -z "$run_ids" ]; then
  echo "no workflow runs registered for $sha after ~15s (or gh failed; check stderr above, gh auth status, and the remote)" >&2
  exit 2
fi

# Run outcome (fail) and gh health (gherr) are tracked separately so an
# auth/network failure is never reported as a red pipeline, and vice versa.
fail=0
gherr=0
for id in $run_ids; do
  # The watch only waits; classification comes from the conclusion query
  # below, so a watch aborted by a gh/network error cannot misreport.
  gh run watch "$id" >/dev/null 2>&1 || true
  if ! line="$(gh run view "$id" --json name,conclusion --jq '"\(.conclusion)\t\(.name)"' 2>/dev/null)"; then
    echo "gh failed while checking run $id (auth or network?)" >&2
    gherr=1
    continue
  fi
  conclusion="${line%%$'\t'*}"
  name="${line#*$'\t'}"
  case "$conclusion" in
    success)
      echo "pass: $name ($id)"
      ;;
    "" | null)
      # Watch returned but the run has no conclusion: the watch was cut short.
      # gh normalizes a null conclusion to "" in --json output; "null" guards
      # any path where jq renders the raw JSON null instead.
      echo "run $id ($name) is not concluded; the watch aborted early (gh or network?)" >&2
      gherr=1
      ;;
    *)
      fail=1
      echo "FAIL($conclusion): $name ($id)"
      # || true: --log-failed exits non-zero for expired logs or runs with no
      # failed step; that must not kill the loop before the remaining runs.
      gh run view "$id" --log-failed 2>&1 | tail -80 || true
      ;;
  esac
done

# A real red run outranks a gh hiccup; a gh hiccup outranks "all green".
[ "$fail" -eq 1 ] && exit 1
[ "$gherr" -eq 1 ] && exit 2
exit 0
