#!/usr/bin/env bash
# Watch all CI runs for a commit: discover them (with registration-lag
# polling), wait for the latest run of each workflow, report pass/fail with
# failing-job log excerpts.
# Usage: watch-ci.sh [<full-sha>]   (defaults to HEAD)
# Exit 0: the latest run of every workflow passed (event-condition skips
# count as pass; older re-triggered runs are reported as superseded, never
# judged). 1: at least one workflow's latest run ended with any non-success,
# non-skipped conclusion (e.g. failure/cancelled/timed_out). 2: no runs
# registered, or gh itself failed (discovery or status checks).
set -euo pipefail

# Full SHA required: gh run list --commit silently matches nothing for short SHAs.
sha="${1:-$(git rev-parse HEAD)}"

# --limit 100: the default page is 20 runs, and heavy retriggering can fill
# it with one workflow, pushing another workflow off the page so it would
# never be judged at all.
# The "=" prefix keeps the workflow-id field non-empty: tab is IFS
# whitespace, so read would otherwise collapse an empty id and shift the
# name into its place, silently mis-grouping the runs.
discover() {
  gh run list --commit "$sha" --limit 100 --json databaseId,workflowDatabaseId,workflowName --jq '.[] | "\(.databaseId)\t=\(.workflowDatabaseId)\t\(.workflowName)"'
}

# The unit of judgment is the workflow, not the run: re-triggers (e.g. a
# pull_request `edited` event) stack several runs of one workflow on the same
# SHA and a concurrency group cancels all but the newest, so judging every
# run would report a green pipeline as red. select_latest reads run_lines and
# sets run_ids to the newest run per workflow id (run ids are monotonic,
# hence the numeric sort); older runs of the same workflow are informational
# only ($1 = 1 prints them as superseded) and never affect the exit code.
# Grouping is by workflowDatabaseId, not display name: two workflow files can
# share a name, and one must never supersede the other.
select_latest() {
  run_ids=""
  seen_wfids=$'\n'
  while IFS=$'\t' read -r id wfid name; do
    [ -n "$id" ] || continue
    wfid="${wfid#=}"
    # Ruleset/unnamed runs can lack a workflow id (jq renders it "null");
    # judge each individually rather than collapsing them into one bogus
    # group.
    case "$wfid" in
      "" | null)
        run_ids="$run_ids $id"
        continue
        ;;
    esac
    case "$seen_wfids" in
      *$'\n'"$wfid"$'\n'*)
        if [ "$1" = "1" ]; then
          echo "superseded: $name ($id)"
        fi
        ;;
      *)
        seen_wfids="$seen_wfids$wfid"$'\n'
        run_ids="$run_ids $id"
        ;;
    esac
  done <<EOF
$(printf '%s\n' "$run_lines" | sort -rn)
EOF
}

run_lines=""
for attempt in 1 2 3 4 5; do
  # || true: a gh failure (auth, non-GitHub remote) must not masquerade as
  # a red pipeline via set -e; it falls through to the exit-2 path below.
  run_lines="$(discover || true)"
  [ -n "$run_lines" ] && break
  [ "$attempt" -lt 5 ] && sleep 3
done

if [ -z "$run_lines" ]; then
  echo "no workflow runs registered for $sha after ~15s (or gh failed; check stderr above, gh auth status, and the remote)" >&2
  exit 2
fi

# The first selection is silent: it only picks what to wait on. "Latest" is
# decided again after the wait, and printing superseded lines in both passes
# would duplicate them.
select_latest 0

for id in $run_ids; do
  # The watch only waits; classification comes from the conclusion query in
  # the judgment loop below, so a watch aborted by a gh/network error cannot
  # misreport.
  gh run watch "$id" >/dev/null 2>&1 || true
done

# "Latest" was only latest at the discovery snapshot: a re-trigger DURING the
# wait supersedes a selected run, and its concurrency cancellation must not
# read as FAIL. One re-discovery re-selects against the post-wait reality.
# || true and keeping the old lines: a re-discovery hiccup must not kill the
# report that the already-watched runs can still provide.
fresh_lines="$(discover || true)"
[ -n "$fresh_lines" ] && run_lines="$fresh_lines"
select_latest 1

# Discovery found runs, so an empty selection here means the grouping pipe
# itself broke; that must surface as tooling trouble, never as green.
if [ -z "$run_ids" ]; then
  echo "internal: no runs selected from the discovery output for $sha" >&2
  exit 2
fi

# Run outcome (fail) and gh health (gherr) are tracked separately so an
# auth/network failure is never reported as a red pipeline, and vice versa.
fail=0
gherr=0
for id in $run_ids; do
  # A no-op wait for runs already watched above; a real wait for a run that
  # appeared during the first watch and was selected by the re-discovery.
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
    skipped)
      # Event-condition skips (workflow_run fan-out, duplicate triggers) are
      # not failures; mapping them to FAIL trains readers to discount exit 1.
      echo "skip: $name ($id)"
      ;;
    "" | null)
      # Watch returned but the run has no conclusion: the watch was cut short.
      # gh normalizes a null conclusion to "" in --json output; "null" guards
      # any path where jq renders the raw JSON null instead.
      echo "run $id ($name) is not concluded; the watch aborted early (gh or network?)" >&2
      gherr=1
      ;;
    *)
      # Every other conclusion (failure, cancelled, timed_out, neutral,
      # action_required, stale, startup_failure, ...) is a FAIL - including a
      # cancelled LATEST run: with no newer run to supersede it, cancellation
      # means the pipeline never delivered a verdict.
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
