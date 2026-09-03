#!/usr/bin/env bash
# Watch all CI runs for a commit: discover them (with registration-lag
# polling), wait for the latest run of each workflow, report pass/fail with
# failing-job log excerpts.
# Usage: watch-ci.sh [--expect-workflow <name>]... [<full-sha>]   (SHA defaults
# to HEAD; flags go before the SHA, and anything after the SHA is an error)
# Exit 0: the latest run of every workflow passed AND every expected workflow
# (default "CI"; --expect-workflow overrides, repeatable or comma-separated)
# is among the discovered runs (event-condition skips count as pass; older
# re-triggered runs are reported as superseded, never judged). 1: at least
# one workflow's latest run ended with any non-success, non-skipped
# conclusion (e.g. failure/cancelled/timed_out). 2: no runs registered, gh
# itself failed (discovery or status checks), an expected workflow never
# registered a run on the SHA, or any unexpected internal failure (routed
# there by the ERR trap below, never to 1). Transient gh/network errors
# between the watch and the verdict are retried (3 attempts, short backoff)
# before any exit-2 conclusion.
set -Eeuo pipefail

# Exit 1 means a judged red pipeline, so every UNHANDLED failure exits 2 here.
# bash 3.2 fires the -E trap inside guarded $(...) too, so subshells only
# re-raise; the top level prints once, to the pre-redirect stderr saved as fd 3.
exec 3>&2
# shellcheck disable=SC2329 # invoked by the ERR trap below
on_unhandled_failure() {
  [ "$BASH_SUBSHELL" -eq 0 ] || exit "$1"
  echo "watch-ci.sh: unexpected command failure around line $2; tooling trouble, not a pipeline verdict" >&3
  exit 2
}
trap 'on_unhandled_failure $? $LINENO' ERR

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
# gh run watch refreshes every 3 s by default; parallel watchers at that rate
# drained GitHub's 5000-requests-per-hour REST bucket and blinded every CI
# verdict for 45 minutes. One refresh per minute per watched run instead.
watch_interval=60
# The flag loop stops at the first non-flag word, so anything after the SHA
# (a misplaced --expect-workflow, a typo) would otherwise be dropped silently
# - and a dropped expectation flag lets a green bystander run read as the
# gate, the exact vacuous green that flag exists to prevent.
if [ "$#" -gt 1 ]; then
  shift
  echo "unexpected argument(s) after the SHA: $* (usage: watch-ci.sh [--expect-workflow <name>]... [<full-sha>])" >&2
  exit 2
fi

# --limit 100: the default page is 20 runs, and heavy retriggering can fill
# it with one workflow, pushing another workflow off the page so it would
# never be judged at all.
# attempt is part of each line because GitHub RE-RUNS keep the run id and
# increment attempt; convergence below must see a mid-watch re-run as change.
# The "=" prefixes keep the attempt and workflow-id fields non-empty: tab is
# IFS whitespace, so read would otherwise collapse an empty field and shift
# the later fields into the wrong slots, silently mis-grouping the runs.
# A failed gh call prints NOTHING, even when gh emitted partial output before
# dying: a partial snapshot judged as complete would leave the omitted runs
# unmeasured, so every call site's emptiness check must see failure as "no
# output" - retried during registration polling, exit 2 at judgment time.
discover() {
  local listed
  listed="$(gh run list --commit "$sha" --limit 100 --json databaseId,attempt,workflowDatabaseId,workflowName --jq '.[] | "\(.databaseId)\t=\(.attempt)\t=\(.workflowDatabaseId)\t\(.workflowName)"')" || return 1
  printf '%s\n' "$listed"
}

# Sets `missing` to the comma-joined expected names absent from run_lines,
# and `discovered_names` to the unique names present. Used twice: to keep the
# registration-lag polling alive while the gate workflow is still absent, and
# to refuse a vacuous green at judgment time. The quoted "$want" in the case
# pattern keeps glob metacharacters in workflow names literal. The expected
# names are transformed in an assignment, never inline in the heredoc: a
# substitution failing inside a heredoc only exits its own subshell, and the
# silently empty expectation list would read as "nothing missing" - the
# assignment routes the failure to the ERR trap instead.
compute_missing() {
  local expected_lines
  discovered_names="$(printf '%s\n' "$run_lines" | cut -f4- | sort -u)"
  expected_lines="$(printf '%s\n' "$expected_csv" | tr ',' '\n')"
  missing=""
  while IFS= read -r want; do
    [ -n "$want" ] || continue
    case $'\n'"$discovered_names"$'\n' in
      *$'\n'"$want"$'\n'*) ;;
      *) missing="${missing:+$missing, }$want" ;;
    esac
  done <<EOF
$expected_lines
EOF
}

# Transient gh/network errors mid-watch (a dropped connection, a rate-limit
# blip) must not conclude anything from a single failed read, so the gh calls
# between the watch and the verdict get a bounded retry: 3 attempts with a
# short backoff. All exit semantics are preserved - a persistent failure
# still lands in the same exit-2 paths with the same messages; only the
# single-blip false conclusion is retired.
discover_with_retry() {
  local attempt out=""
  for attempt in 1 2 3; do
    if out="$(discover)" && [ -n "$out" ]; then
      printf '%s\n' "$out"
      return 0
    fi
    out=""
    [ "$attempt" -lt 3 ] && sleep 2
  done
  # Still nothing after the retries: emit the empty reading and let the call
  # site's stale-snapshot check refuse it, exactly as before.
  printf '%s\n' "$out"
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
  # Sorted in an assignment, not inline in the heredoc, for the same reason
  # as compute_missing: a sort dying inside the heredoc substitution would
  # silently select nothing instead of reaching the ERR trap.
  local sorted_lines
  sorted_lines="$(printf '%s\n' "$run_lines" | sort -rn)"
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
$sorted_lines
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
for _ in 1 2 3 4 5; do
  for id in $run_ids; do
    # The watch only waits; classification comes from the conclusion query in
    # the judgment loop below, so a watch aborted by a gh/network error
    # cannot misreport.
    gh run watch "$id" --interval "$watch_interval" >/dev/null 2>&1 || true
  done
  # A failed or empty re-discovery is tooling trouble, same as at first
  # discovery; silently judging the stale snapshot instead could re-report a
  # now-superseded cancellation as a real FAIL. Retried (bounded, above)
  # before it is allowed to conclude.
  run_lines="$(discover_with_retry)"
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

# A selection that never converged is only as fresh as the last discovery: a
# run registering after that snapshot would never be judged, so a failing
# newest run could read as green. Watch the current selection out, then
# re-discover ONCE more immediately before judgment; only a confirmed-stable
# selection is judged, anything else refuses - never a verdict on a snapshot
# known to be stale.
if [ "$converged" -ne 1 ]; then
  for id in $run_ids; do
    gh run watch "$id" --interval "$watch_interval" >/dev/null 2>&1 || true
  done
  run_lines="$(discover_with_retry)"
  if [ -z "$run_lines" ]; then
    echo "re-discovery after the watch returned nothing for $sha (gh failed, or the runs vanished); refusing to judge a stale snapshot" >&2
    exit 2
  fi
  prev_sig="$run_sig"
  select_latest 0
  if [ "$run_sig" != "$prev_sig" ]; then
    echo "retriggering was still active after 5 discovery rounds and the final re-discovery changed the selection again; refusing to judge a stale snapshot - re-run once the retriggering settles" >&2
    exit 2
  fi
  echo "note: retriggering was still active after 5 discovery rounds; the final re-discovery confirmed the judged selection"
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

# Run outcome (fail) and gh health (gherr) are tracked separately so an
# auth/network failure is never reported as a red pipeline, and vice versa.
# Every selected run was already watched to completion above, so this loop
# only classifies; a blanket re-wait here would reopen the supersession race
# the fixed-point loop just closed. The bounded retry below re-watches a
# single run only after a transient read failure, and because ANY wait
# reopens that race, a retried judgment must survive the selection-stability
# re-check after this loop before it stands.
fail=0
gherr=0
rewatched=0
# Judgment output is buffered and released only after the selection-stability
# re-check below: a conclusion retry can re-watch (a wait), a retrigger during
# that wait voids these verdict lines, and a report must never carry a verdict
# about a superseded selection - a stability refusal exits 2 with no verdict
# lines at all. The trap is installed before the mktemp calls so a failed
# second mktemp cannot strand the first file. A mktemp failure is tooling
# trouble, so it must exit 2 like every other tooling failure, never ride
# set -e into the exit 1 that means "red pipeline".
judgment_out=""
judgment_err=""
trap 'rm -f "$judgment_out" "$judgment_err"' EXIT
if ! judgment_out="$(mktemp)" || ! judgment_err="$(mktemp)"; then
  echo "mktemp failed while preparing the judgment buffer (tmpdir full or unwritable?); cannot judge safely" >&2
  exit 2
fi
for id in $run_ids; do
  # The conclusion read gets the same bounded retry as re-discovery: a failed
  # view is re-read, and a missing conclusion (the watch was cut short) is
  # re-watched first so a re-read cannot judge a still-running attempt. Only
  # a failure that survives all 3 attempts reaches the gherr paths below.
  line=""
  conclusion=""
  viewfail=0
  for attempt in 1 2 3; do
    if [ "$attempt" -gt 1 ]; then
      sleep 2
      gh run watch "$id" --interval "$watch_interval" >/dev/null 2>&1 || true
      rewatched=1
    fi
    if ! line="$(gh run view "$id" --json name,conclusion --jq '"\(.conclusion)\t\(.name)"' 2>/dev/null)"; then
      viewfail=1
      continue
    fi
    viewfail=0
    conclusion="${line%%$'\t'*}"
    case "$conclusion" in
      "" | null) ;;
      *) break ;;
    esac
  done
  if [ "$viewfail" -eq 1 ]; then
    echo "gh failed while checking run $id (auth or network?)" >&2
    gherr=1
    continue
  fi
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
      # Still no conclusion after the bounded re-watch retries: the watch was
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
done > "$judgment_out" 2> "$judgment_err"

# A retry above re-watched a run, and ANY wait can let a retrigger supersede
# the judged selection - the same stale-selection race the fixed-point loop
# closes. Re-discover once and require the selection unchanged before any
# verdict built on it is allowed to stand; a red verdict on a superseded run
# is exactly the misreport the fixed-point loop exists to prevent.
if [ "$rewatched" -eq 1 ]; then
  run_lines="$(discover_with_retry)"
  if [ -z "$run_lines" ]; then
    echo "re-discovery after the conclusion retries returned nothing for $sha (gh failed, or the runs vanished); refusing to judge a stale snapshot" >&2
    exit 2
  fi
  prev_sig="$run_sig"
  select_latest 0
  if [ "$run_sig" != "$prev_sig" ]; then
    echo "a run was retriggered while the conclusion retries waited; refusing to judge a stale snapshot - re-run once the retriggering settles" >&2
    exit 2
  fi
fi

# The selection stood (or nothing waited): the buffered verdict lines are
# current, so release them.
cat "$judgment_out"
cat "$judgment_err" >&2

# "Every discovered workflow passed" is vacuous when the workflow that
# carries the required gate is not among the discovered runs at all. Computed
# only after the stability re-check, against the freshest snapshot: a gate
# workflow that registered mid-watch heals here, while one registering during
# a conclusion-retry wait changes the selection signature and trips the
# stability refusal above (exit 2) before this check runs - either way a
# refusal never carries a stale "not found". Absence is missing evidence and
# exits 2 below, never a pass.
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

# A real red run outranks a missing expected workflow, which outranks a gh
# hiccup; only a fully-evidenced green exits 0.
[ "$fail" -eq 1 ] && exit 1
[ -n "$missing" ] && exit 2
[ "$gherr" -eq 1 ] && exit 2
exit 0
