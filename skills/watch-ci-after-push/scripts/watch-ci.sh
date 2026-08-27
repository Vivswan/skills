#!/usr/bin/env bash
# Watch all CI runs for a commit: discover them (with registration-lag
# polling), wait for the latest run of each workflow, report pass/fail with
# failing-job log excerpts.
# Usage: watch-ci.sh [--expect-workflow <name>]... [<full-sha>]   (SHA defaults to HEAD)
# Exit 0: the latest run of every workflow passed AND every expected workflow
# (default "CI"; --expect-workflow overrides, repeatable or comma-separated)
# is among the discovered runs (event-condition skips count as pass; older
# re-triggered runs are reported as superseded, never judged). 1: at least
# one workflow's latest run ended with any non-success, non-skipped
# conclusion (e.g. failure/cancelled/timed_out). 2: no runs registered, gh
# itself failed (discovery or status checks), or an expected workflow never
# registered a run on the SHA.
set -euo pipefail

# The workflow carrying the required gate can silently fail to register on a
# push (a dropped push/synchronize event), leaving only bystander workflows
# on the SHA - all green, gate absent. A missing reading must never read as
# green, so the script refuses to exit 0 unless every expected workflow name
# is among the discovered runs.
expected_csv=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --expect-workflow)
      if [ "$#" -lt 2 ]; then
        echo "--expect-workflow requires a workflow name" >&2
        exit 2
      fi
      # Reject newlines and empty entries ("", ",", "A,", "A,,B"): the list
      # is split on commas and matched line-by-line, so either would shrink
      # the expectation set - a value splitting to zero names would silently
      # disable the gate this flag configures. Names match the discovered
      # workflowName exactly and case-sensitively, so a comma or newline can
      # never be part of an expected name.
      case "$2" in
        *$'\n'*)
          echo "--expect-workflow value must not contain newlines" >&2
          exit 2
          ;;
      esac
      case ",$2," in
        *,,*)
          echo "--expect-workflow requires a workflow name (empty entry in \"$2\")" >&2
          exit 2
          ;;
      esac
      expected_csv="${expected_csv:+$expected_csv,}$2"
      shift 2
      ;;
    --*)
      echo "unknown flag: $1 (usage: watch-ci.sh [--expect-workflow <name>]... [<full-sha>])" >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done
[ -n "$expected_csv" ] || expected_csv="CI"

# Full SHA required: gh run list --commit silently matches nothing for short SHAs.
sha="${1:-$(git rev-parse HEAD)}"

# --limit 100: the default page is 20 runs, and heavy retriggering can fill
# it with one workflow, pushing another workflow off the page so it would
# never be judged at all.
# attempt is part of each line because GitHub RE-RUNS keep the run id and
# increment attempt; convergence below must see a mid-watch re-run as change.
# The "=" prefixes keep the attempt and workflow-id fields non-empty: tab is
# IFS whitespace, so read would otherwise collapse an empty field and shift
# the later fields into the wrong slots, silently mis-grouping the runs.
discover() {
  gh run list --commit "$sha" --limit 100 --json databaseId,attempt,workflowDatabaseId,workflowName --jq '.[] | "\(.databaseId)\t=\(.attempt)\t=\(.workflowDatabaseId)\t\(.workflowName)"'
}

# Sets `missing` to the comma-joined expected names absent from run_lines,
# and `discovered_names` to the unique names present. Used twice: to keep the
# registration-lag polling alive while the gate workflow is still absent, and
# to refuse a vacuous green at judgment time. The quoted "$want" in the case
# pattern keeps glob metacharacters in workflow names literal.
compute_missing() {
  discovered_names="$(printf '%s\n' "$run_lines" | cut -f4- | sort -u)"
  missing=""
  while IFS= read -r want; do
    [ -n "$want" ] || continue
    case $'\n'"$discovered_names"$'\n' in
      *$'\n'"$want"$'\n'*) ;;
      *) missing="${missing:+$missing, }$want" ;;
    esac
  done <<EOF
$(printf '%s\n' "$expected_csv" | tr ',' '\n')
EOF
}

# The unit of judgment is the workflow, not the run: re-triggers (e.g. a
# pull_request `edited` event) stack several runs of one workflow on the same
# SHA and a concurrency group cancels all but the newest, so judging every
# run would report a green pipeline as red. select_latest reads run_lines and
# sets run_ids to the newest run per workflow id (run ids are monotonic,
# hence the numeric sort); older runs of the same workflow are informational
# only ($1 = 1 prints them as superseded) and never affect the exit code.
# Grouping is by workflowDatabaseId, not display name: two workflow files can
# share a name, and one must never supersede the other. run_sig additionally
# records id:attempt per selected run: it is the convergence signature, since
# a re-run changes only the attempt, never the id.
select_latest() {
  run_ids=""
  run_sig=""
  seen_wfids=$'\n'
  while IFS=$'\t' read -r id attempt wfid name; do
    [ -n "$id" ] || continue
    attempt="${attempt#=}"
    wfid="${wfid#=}"
    # Ruleset/unnamed runs can lack a workflow id (jq renders it "null");
    # judge each individually rather than collapsing them into one bogus
    # group.
    case "$wfid" in
      "" | null)
        run_ids="$run_ids $id"
        run_sig="$run_sig $id:$attempt"
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
        run_sig="$run_sig $id:$attempt"
        ;;
    esac
  done <<EOF
$(printf '%s\n' "$run_lines" | sort -rn)
EOF
}

run_lines=""
missing=""
for attempt in 1 2 3 4 5; do
  # || true: a gh failure (auth, non-GitHub remote) must not masquerade as
  # a red pipeline via set -e; it falls through to the exit-2 path below.
  run_lines="$(discover || true)"
  if [ -n "$run_lines" ]; then
    # Keep polling while an expected workflow is still absent: a fast
    # bystander (e.g. an auto-assign workflow) can register seconds before
    # the gate workflow, and breaking on the first run alone would report
    # the gate missing while it is only late. The window stays bounded at
    # the same ~15s; a gate still absent after it is judged missing below.
    compute_missing
    [ -z "$missing" ] && break
  fi
  [ "$attempt" -lt 5 ] && sleep 3
done

if [ -z "$run_lines" ]; then
  echo "no workflow runs registered for $sha after ~15s (or gh failed; check stderr above, gh auth status, and the remote)" >&2
  exit 2
fi

# Selections stay silent until the final one so each superseded line is
# printed exactly once.
select_latest 0

# "Latest" is only latest at a discovery snapshot: a re-trigger DURING a wait
# supersedes a selected run, and its concurrency cancellation must not read
# as FAIL. Iterate wait -> re-discover -> re-select to a fixed point (capped)
# so the judged runs are the latest at judgment time. Convergence compares
# id:attempt signatures, not just ids: a RE-RUN keeps the id and bumps the
# attempt, and judging it before its wait would read an in-flight attempt.
converged=0
for round in 1 2 3 4 5; do
  for id in $run_ids; do
    # The watch only waits; classification comes from the conclusion query in
    # the judgment loop below, so a watch aborted by a gh/network error
    # cannot misreport.
    gh run watch "$id" >/dev/null 2>&1 || true
  done
  # A failed or empty re-discovery is tooling trouble, same as at first
  # discovery; silently judging the stale snapshot instead could re-report a
  # now-superseded cancellation as a real FAIL.
  run_lines="$(discover || true)"
  if [ -z "$run_lines" ]; then
    echo "re-discovery after the watch returned nothing for $sha (gh failed, or the runs vanished); refusing to judge a stale snapshot" >&2
    exit 2
  fi
  prev_sig="$run_sig"
  select_latest 0
  if [ "$run_sig" = "$prev_sig" ]; then
    converged=1
    break
  fi
done

if [ "$converged" -ne 1 ]; then
  echo "note: retriggering was still active after 5 discovery rounds; judging the current selection, which may itself already be superseded"
  for id in $run_ids; do
    gh run watch "$id" >/dev/null 2>&1 || true
  done
fi

# Re-runs the selection on the final snapshot purely to print each older run
# as a superseded info line.
select_latest 1

# Discovery found runs, so an empty selection here means the grouping pipe
# itself broke; that must surface as tooling trouble, never as green.
if [ -z "$run_ids" ]; then
  echo "internal: no runs selected from the discovery output for $sha" >&2
  exit 2
fi

# "Every discovered workflow passed" is vacuous when the workflow that
# carries the required gate is not among the discovered runs at all.
# Recompute against the final snapshot (a gate that registered mid-watch
# heals here); absence is missing evidence and exits 2 below, never a pass.
compute_missing
if [ -n "$missing" ]; then
  found_list=""
  while IFS= read -r found; do
    [ -n "$found" ] || continue
    found_list="${found_list:+$found_list, }$found"
  done <<EOF
$discovered_names
EOF
  echo "expected workflow(s) not found for $sha: $missing; discovered only: ${found_list:-nothing}. The push event can fail to register the run; dispatch the missing workflow by hand, e.g. gh workflow run ci.yml --ref <branch> (or override the expectation with --expect-workflow <name>)" >&2
fi

# Run outcome (fail) and gh health (gherr) are tracked separately so an
# auth/network failure is never reported as a red pipeline, and vice versa.
# Every selected run was already watched to completion above, so this loop
# only classifies; another wait here would reopen the supersession race the
# fixed-point loop just closed.
fail=0
gherr=0
for id in $run_ids; do
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
      # The run has no conclusion although its watch returned: the watch was
      # cut short. gh normalizes a null conclusion to "" in --json output;
      # "null" guards any path where jq renders the raw JSON null instead.
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

# A real red run outranks a missing expected workflow, which outranks a gh
# hiccup; only a fully-evidenced green exits 0.
[ "$fail" -eq 1 ] && exit 1
[ -n "$missing" ] && exit 2
[ "$gherr" -eq 1 ] && exit 2
exit 0
