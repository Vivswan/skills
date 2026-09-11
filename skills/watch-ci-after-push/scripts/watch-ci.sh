#!/usr/bin/env bash
# Watch all CI runs for a commit: wait for the latest run of each workflow, report pass/fail with failing-job log excerpts.
# Usage: watch-ci.sh [--expect-workflow <name>]... [<full-sha>]
# The SHA defaults to HEAD; flags go before the SHA, and anything after the SHA is an error.
# Exit 0: the latest run of every workflow passed AND every expected workflow is among the discovered runs.
#   The expectation defaults to "CI"; --expect-workflow overrides it, repeatable or comma-separated.
#   Event-condition skips count as pass; older re-triggered runs are reported as superseded, never judged.
# Exit 1: at least one workflow's latest run ended with a non-success, non-skipped conclusion (failure, cancelled, timed_out, ...).
# Exit 2: no runs registered, gh failed, an expected workflow never registered a run, or any unexpected internal failure.
#   The ERR trap routes internal failures to 2, never to 1.
# Discovery and polling are GraphQL, one request per page of 100 check suites per poll; REST is touched only for failed-job logs.
#   The Actions REST endpoints (run list/watch/view) are throttled as a secondary bucket that locks for an hour
#   under parallel watchers while core reads 5000/5000 and GraphQL keeps answering.
#   A GraphQL failure, rate limit included, is a gh failure (exit 2); there is no fallback to REST.
# Transient gh/network errors between polls are retried (3 attempts, short backoff) before any exit-2 conclusion.
set -Eeuo pipefail

# Exit 1 means a judged red pipeline, so every UNHANDLED failure exits 2 here.
# bash 3.2 fires the -E trap inside guarded $(...) too, so subshells only re-raise.
# The top level prints once, to the pre-redirect stderr saved as fd 3.
exec 3>&2
# shellcheck disable=SC2329 # invoked by the ERR trap below
on_unhandled_failure() {
  [ "$BASH_SUBSHELL" -eq 0 ] || exit "$1"
  echo "watch-ci.sh: unexpected command failure around line $2; tooling trouble, not a pipeline verdict" >&3
  exit 2
}
trap 'on_unhandled_failure $? $LINENO' ERR

# The gate workflow can silently fail to register on a push (a dropped push/synchronize event),
# leaving only green bystanders on the SHA. A missing reading must never read as green,
# so exit 0 requires every expected workflow name among the discovered runs.
expected_csv=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --expect-workflow)
      if [ "$#" -lt 2 ]; then
        echo "--expect-workflow requires a workflow name" >&2
        exit 2
      fi
      # The list is split on commas and matched line-by-line, so a newline or an empty entry
      # ("", ",", "A,", "A,,B") would shrink the expectation set and silently disable the gate.
      # Names match the discovered workflow name exactly, so neither can be part of a real name.
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

# Full SHA required: GraphQL's object(oid:) rejects anything shorter than 40 hex characters.
sha="${1:-$(git rev-parse HEAD)}"
# gh run watch's 3 s default refresh across parallel watchers drained the REST bucket and blinded every verdict for 45 minutes.
poll_interval=60
# The flag loop stops at the first non-flag word, so a misplaced --expect-workflow after the SHA
# would otherwise be dropped silently, and a green bystander could then read as the gate.
if [ "$#" -gt 1 ]; then
  shift
  echo "unexpected argument(s) after the SHA: $* (usage: watch-ci.sh [--expect-workflow <name>]... [<full-sha>])" >&2
  exit 2
fi

# || true: a gh failure (auth, non-GitHub remote) must not masquerade as a red pipeline via set -e.
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner || true)"
case "$repo" in
  */*) ;;
  *)
    echo "cannot resolve the repository for this checkout (gh failed; check stderr above, gh auth status, and the remote)" >&2
    exit 2
    ;;
esac
owner="${repo%%/*}"
name="${repo#*/}"

# External apps (CodeQL, Semgrep, zizmor) also register check suites on the commit, without a workflowRun;
# only github-actions suites carrying one are workflow runs, which is exactly what gh run list reported.
# shellcheck disable=SC2016 # the $variables are GraphQL's, resolved by gh -f
suites_query='query($owner: String!, $name: String!, $oid: GitObjectID!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) { ... on Commit {
      checkSuites(first: 100, after: $cursor) {
        nodes {
          status conclusion app { slug }
          workflowRun { databaseId workflow { databaseId name } }
        }
        pageInfo { hasNextPage endCursor }
      }
    } }
  }
}'
# Row shape: <run id> TAB <status> TAB <conclusion> TAB <workflow id> TAB <workflow name>, enum words lowercased.
# The last line is the page marker: "end", or "next" TAB <cursor>.
# A null conclusion (still running) renders as the word null; "[]?" makes an unknown SHA an empty snapshot, not a jq error.
# shellcheck disable=SC2016 # $suites is jq's, not the shell's
suites_filter='.data.repository.object.checkSuites as $suites
| ($suites.nodes[]? | select(.app.slug == "github-actions" and .workflowRun != null)
  | "\(.workflowRun.databaseId)\t\(.status | ascii_downcase)\t\(.conclusion // "null" | ascii_downcase)\t\(.workflowRun.workflow.databaseId)\t\(.workflowRun.workflow.name)"),
  (if $suites.pageInfo.hasNextPage then "next\t\($suites.pageInfo.endCursor)" else "end" end)'
# Heavy retriggering can stack hundreds of suites on one SHA; a failed run past the first page must still be judged.
max_suite_pages=10

# One snapshot is every page of the commit's check suites, each with its run status, so the run list and the run states
# are read together. A failed gh call prints NOTHING, even after earlier pages or partial output were received:
# a partial snapshot judged as complete would leave the omitted runs unmeasured.
discover() {
  local cursor="" page out tail rows=""
  for ((page = 1; page <= max_suite_pages; page++)); do
    set --
    [ -z "$cursor" ] || set -- -f cursor="$cursor"
    out="$(gh api graphql -f query="$suites_query" -f owner="$owner" -f name="$name" -f oid="$sha" "$@" --jq "$suites_filter")" || return 1
    tail="${out##*$'\n'}"
    case "$out" in
      *$'\n'*) rows="$rows${out%$'\n'*}"$'\n' ;;
    esac
    case "$tail" in
      end)
        printf '%s' "$rows"
        return 0
        ;;
      next$'\t'?*) cursor="${tail#next$'\t'}" ;;
      *) return 1 ;;
    esac
  done
  echo "check suites for $sha span more than $max_suite_pages pages of 100; refusing to judge a partial snapshot" >&2
  return 1
}

# Sets `missing` to the comma-joined expected names absent from run_lines, and `discovered_names` to the unique names present.
# The quoted "$want" in the case pattern keeps glob metacharacters in workflow names literal.
# The expected names are transformed in an assignment, never inline in the heredoc: a substitution failing inside a heredoc
# only exits its own subshell, and the silently empty expectation list would read as "nothing missing".
compute_missing() {
  local expected_lines
  discovered_names="$(printf '%s\n' "$run_lines" | cut -f5- | sort -u)"
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

# A dropped connection or a rate-limit blip must not conclude anything from a single failed read.
# Three attempts with a short backoff; a persistent failure still lands in the exit-2 paths with the same messages.
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
  printf '%s\n' "$out"
}

# The unit of judgment is the workflow: re-triggers stack several runs of one workflow on one SHA,
# and a concurrency group cancels all but the newest, so judging every run would report a green pipeline as red.
# Grouping is by workflow id, not name: two workflow files can share a name, and one must never supersede the other.
# Run ids are monotonic, hence the numeric sort picks the newest.
# A re-run keeps its run id and flips the status away from completed, so "not completed" is the only running signal.
select_latest() {
  # Sorted in an assignment, not inline in the heredoc, for the same reason as compute_missing.
  local sorted_lines
  sorted_lines="$(printf '%s\n' "$run_lines" | sort -rn)"
  selected_lines=""
  pending=0
  seen_wfids=$'\n'
  while IFS=$'\t' read -r id status conclusion wfid wfname; do
    [ -n "$id" ] || continue
    case "$wfid" in
      # Ruleset/unnamed runs can lack a workflow id (jq renders it "null"); judge each individually.
      null) ;;
      *)
        case "$seen_wfids" in
          *$'\n'"$wfid"$'\n'*)
            if [ "$1" = "1" ]; then
              echo "superseded: $wfname ($id)"
            fi
            continue
            ;;
        esac
        seen_wfids="$seen_wfids$wfid"$'\n'
        ;;
    esac
    selected_lines="$selected_lines$id"$'\t'"$status"$'\t'"$conclusion"$'\t'"$wfname"$'\n'
    [ "$status" = completed ] || pending=$((pending + 1))
  done <<EOF
$sorted_lines
EOF
}

run_lines=""
missing=""
for attempt in 1 2 3 4 5; do
  run_lines="$(discover || true)"
  if [ -n "$run_lines" ]; then
    # Keep polling while an expected workflow is still absent: a fast bystander (e.g. an auto-assign workflow)
    # can register seconds before the gate workflow. The window stays bounded at the same ~15s.
    compute_missing
    [ -z "$missing" ] && break
  fi
  [ "$attempt" -lt 5 ] && sleep 3
done

if [ -z "$run_lines" ]; then
  echo "no workflow runs registered for $sha after ~15s (or gh failed; check stderr above, gh auth status, and the remote)" >&2
  exit 2
fi

# Each poll is a fresh snapshot, and the selection is recomputed from it, so a run registered or re-run mid-watch
# is waited on like any other. Judgment reads the snapshot in which every latest run is completed, so a
# selection can never be stale at judgment time.
select_latest 0
while [ "$pending" -gt 0 ]; do
  sleep "$poll_interval"
  run_lines="$(discover_with_retry)"
  if [ -z "$run_lines" ]; then
    echo "polling $sha returned nothing (gh failed, or the runs vanished); refusing to judge without a fresh snapshot" >&2
    exit 2
  fi
  select_latest 0
done

# Re-runs the selection on the final snapshot purely to print each older run as a superseded info line.
select_latest 1

# Discovery found runs, so an empty selection here means the grouping pipe itself broke; that is tooling trouble, never green.
if [ -z "$selected_lines" ]; then
  echo "internal: no runs selected from the discovery output for $sha" >&2
  exit 2
fi

# Run outcome (fail) and gh health (gherr) are tracked separately so tooling trouble is never reported as a red pipeline.
fail=0
gherr=0
while IFS=$'\t' read -r id status conclusion wfname; do
  [ -n "$id" ] || continue
  case "$conclusion" in
    success)
      echo "pass: $wfname ($id)"
      ;;
    skipped)
      # Event-condition skips (workflow_run fan-out, duplicate triggers) are not failures.
      echo "skip: $wfname ($id)"
      ;;
    null)
      echo "run $id ($wfname) is completed but carries no conclusion (gh or GitHub trouble?)" >&2
      gherr=1
      ;;
    *)
      # Every other conclusion is a FAIL, including a cancelled LATEST run: with no newer run to supersede it,
      # cancellation means the pipeline never delivered a verdict.
      fail=1
      echo "FAIL($conclusion): $wfname ($id)"
      # The only REST call: it is informational, so a rate-limited or expired-log answer is printed as the excerpt
      # and never changes the verdict. || true: --log-failed exits non-zero for runs with no failed step.
      gh run view "$id" --log-failed 2>&1 | tail -80 || true
      ;;
  esac
done <<EOF
$selected_lines
EOF

# "Every discovered workflow passed" is vacuous when the gate workflow is not among the discovered runs at all.
# Computed against the final snapshot, so a gate that registered mid-watch heals here.
compute_missing
if [ -n "$missing" ]; then
  found_list=""
  while IFS= read -r found; do
    [ -n "$found" ] || continue
    found_list="${found_list:+$found_list, }$found"
  done <<EOF
$discovered_names
EOF
  echo "expected workflow(s) not found for $sha: $missing; discovered only: ${found_list:-nothing}." \
    "The push event can fail to register the run; dispatch the missing workflow by hand, e.g. gh workflow run ci.yml --ref <branch>" \
    "(or override the expectation with --expect-workflow <name>)" >&2
fi

# A real red run outranks a missing expected workflow, which outranks a gh hiccup; only a fully-evidenced green exits 0.
[ "$fail" -eq 1 ] && exit 1
[ -n "$missing" ] && exit 2
[ "$gherr" -eq 1 ] && exit 2
exit 0
