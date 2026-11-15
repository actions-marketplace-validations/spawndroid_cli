#!/usr/bin/env bash
#
# SpawnDroid GitHub Action — upload → start device → test → report.
#
# One step that mirrors the documented four-call CI flow. It owns the session,
# so the result it reports is the outcome of the test command. Env for the
# test process:
#
#   SPAWNDROID_WD_URL        the session's WebDriver endpoint
#   SPAWNDROID_UDID          the device serial (appium:udid)
#   SPAWNDROID_APP_PACKAGE   the installed package (appium:appPackage)
#   SPAWNDROID_APP           the app slug
#   SPAWNDROID_SESSION_ID    the run id
#
set -euo pipefail

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "::error::This action needs '$tool' on the runner."
    exit 1
  }
done

API_URL="${INPUT_API_URL%/}"
API_KEY="${INPUT_API_KEY:-}"
APP_PATH="${INPUT_APP_PATH:-}"
APP_SLUG="${INPUT_APP_SLUG:-}"
PROFILE="${INPUT_PROFILE:-}"
REPORT_PATH="${INPUT_REPORT_PATH:-}"
COMMAND="${INPUT_COMMAND:-}"
# Boot (180s) + install (240s) are the host's own ceilings; the default leaves
# headroom instead of failing a run whose device is still legitimately starting.
READY_TIMEOUT="${INPUT_READY_TIMEOUT:-600}"

if [ -z "$API_KEY" ]; then
  echo "::error::'api-key' is required."
  exit 1
fi
if [ -z "$COMMAND" ]; then
  echo "::error::'command' is required."
  exit 1
fi

AUTH=(-H "Authorization: Bearer ${API_KEY}")
# The key lives in AUTH from here on. Do not hand it to the test command.
unset INPUT_API_KEY

# api METHOD PATH [curl args...] — one API call with retries.
#
# Sets API_STATUS and API_BODY. Connection failures and 429s are retried with a
# short backoff; 5xx too unless API_RETRY_SERVER=0 (a call that may already have
# committed, like an upload, must not be repeated blindly). Returns non-zero on
# a final non-2xx so callers can `|| fail`. The body is kept so the API's own
# message reaches the job log instead of a bare "curl: (22)".
API_STATUS=""
API_BODY=""
API_MAX_ATTEMPTS=3
API_RETRY_SERVER=1
api() {
  local method="$1" path="$2"
  shift 2
  local attempt=1 out
  while :; do
    out=$(curl --silent --show-error --write-out $'\n%{http_code}' \
      --request "$method" "${API_URL}${path}" "${AUTH[@]}" "$@" 2>/dev/null) ||
      out=$'\n000'
    API_STATUS="${out##*$'\n'}"
    API_BODY="${out%$'\n'*}"
    case "$API_STATUS" in
      2??) return 0 ;;
      000 | 429) ;;
      5??) [ "$API_RETRY_SERVER" = "1" ] || return 1 ;;
      *) return 1 ;;
    esac
    [ "$attempt" -lt "$API_MAX_ATTEMPTS" ] || return 1
    sleep $((attempt * 2))
    attempt=$((attempt + 1))
  done
}

# Print the API's explanation for the last failed call as a job error.
api_error() {
  local message
  message=$(jq --raw-output '.detail // .title // empty' <<<"$API_BODY" 2>/dev/null || true)
  if [ "$API_STATUS" = "000" ]; then
    message="could not reach ${API_URL}"
  fi
  echo "::error::$1 (HTTP ${API_STATUS}): ${message:-no details returned}"
}

# The reported result. Starts as failed and is only flipped on a clean run, so
# an unexpected exit anywhere still records an honest failure and tears down.
RESULT="failed"
SESSION_ID=""

report() {
  if [ -z "$SESSION_ID" ]; then
    return 0
  fi
  # The close is the billing stop; one transient failure would leave the
  # device running until its cap. DELETE is idempotent, so retry it like any
  # other API call instead of swallowing the error.
  API_MAX_ATTEMPTS=3
  if ! api DELETE "/api/v1/sessions/${SESSION_ID}" \
    --header "Content-Type: application/json" \
    --data "{\"result\":\"${RESULT}\"}" >/dev/null; then
    echo "::warning::Could not report the run result (HTTP ${API_STATUS}); the host will reap the session at its cap."
  fi
}
trap report EXIT

step_summary() {
  {
    echo "## SpawnDroid run: ${RESULT}"
    echo
    echo "- App: \`${APP_SLUG}\`"
    if [ -n "$SESSION_ID" ]; then
      echo "- Run: ${API_URL}/dashboard/runs/${SESSION_ID}"
    fi
  } >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
}

# ── 1. Upload the build ─────────────────────────────────────────────────────
if [ -z "$APP_SLUG" ]; then
  if [ -z "$APP_PATH" ] || [ ! -f "$APP_PATH" ]; then
    echo "::error::Provide 'app-path' (a file that exists) or 'app-slug'."
    exit 1
  fi
  echo "::group::Upload ${APP_PATH}"
  API_RETRY_SERVER=0
  if ! api POST /api/apps --form "file=@${APP_PATH}"; then
    api_error "Upload failed"
    echo "::endgroup::"
    exit 1
  fi
  API_RETRY_SERVER=1
  APP_SLUG=$(jq --raw-output '.app.slug // empty' <<<"$API_BODY")
  if [ -z "$APP_SLUG" ]; then
    echo "::error::Upload succeeded but the response had no app slug."
    echo "::endgroup::"
    exit 1
  fi
  echo "Uploaded as ${APP_SLUG}"
  echo "::endgroup::"
fi

# ── 2. Start a device ───────────────────────────────────────────────────────
echo "::group::Start device"
# Revision metadata, so the run ties back to a commit. Zero-config on GitHub;
# silently empty anywhere else.
COMMIT="${GITHUB_SHA:-}"
BRANCH="${GITHUB_REF_NAME:-}"
REPO_URL=""
if [ -n "${GITHUB_SERVER_URL:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ]; then
  REPO_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}"
fi

REQUEST=$(jq --null-input \
  --arg app "$APP_SLUG" \
  --arg profile "$PROFILE" \
  --arg commit "$COMMIT" \
  --arg branch "$BRANCH" \
  --arg repo "$REPO_URL" \
  '{artifactId: $app}
   + (if $profile == "" then {} else {profileId: $profile} end)
   + (if $commit == "" then {} else {commit: $commit} end)
   + (if $branch == "" then {} else {branch: $branch} end)
   + (if $repo == "" then {} else {repoUrl: $repo} end)')
# One key for every retry of this call, so a timeout that already provisioned a
# device resolves to it instead of booting (and billing) a second one.
IDEMPOTENCY_KEY="gha-${GITHUB_RUN_ID:-local}-$(date +%s)-${RANDOM}${RANDOM}"
if ! api POST /api/v1/sessions \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: ${IDEMPOTENCY_KEY}" \
  --data "$REQUEST"; then
  api_error "Could not start a device"
  echo "::endgroup::"
  exit 1
fi

SESSION_ID=$(jq --raw-output '.sessionId // empty' <<<"$API_BODY")
WD_URL=$(jq --raw-output '.webdriverUrl // empty' <<<"$API_BODY")
UDID=$(jq --raw-output '.device.serial // empty' <<<"$API_BODY")
APP_PACKAGE=$(jq --raw-output '.app.package // empty' <<<"$API_BODY")
if [ -z "$SESSION_ID" ] || [ -z "$WD_URL" ]; then
  echo "::error::The session response was missing a session id or WebDriver URL. Does the API key have the 'upload' scope?"
  echo "::endgroup::"
  exit 1
fi
echo "Session ${SESSION_ID}"
echo "::endgroup::"

# ── 3. Wait until the device is ready ───────────────────────────────────────
echo "::group::Wait for the device"
DEADLINE=$(( $(date +%s) + READY_TIMEOUT ))
STATE=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  API_MAX_ATTEMPTS=1
  api GET "/api/v1/sessions/${SESSION_ID}" || true
  API_MAX_ATTEMPTS=3
  # A revoked key or a vanished session will never become ready: stop now
  # instead of waiting out the whole timeout.
  case "$API_STATUS" in
    401 | 403 | 404)
      api_error "Cannot read the session"
      STATE="unreadable"
      break
      ;;
  esac
  STATE=$(jq --raw-output '.state // ""' <<<"$API_BODY" 2>/dev/null || true)
  case "$STATE" in
    ready) break ;;
    failed)
      ERROR=$(jq --raw-output '.error // "unknown error"' <<<"$API_BODY")
      echo "::error::The device failed to boot: ${ERROR}"
      break
      ;;
  esac
  sleep 3
done
echo "State: ${STATE:-timed out}"
case "$STATE" in
  ready | failed | unreadable) ;;
  *) echo "::error::The device was not ready after ${READY_TIMEOUT}s (last state: ${STATE:-unknown})." ;;
esac
echo "::endgroup::"

if [ "$STATE" != "ready" ]; then
  step_summary
  exit 1
fi

# ── 4. Run the suite ────────────────────────────────────────────────────────
echo "::group::Run tests"
export SPAWNDROID_WD_URL="$WD_URL"
export SPAWNDROID_UDID="$UDID"
export SPAWNDROID_APP_PACKAGE="$APP_PACKAGE"
export SPAWNDROID_APP="$APP_SLUG"
export SPAWNDROID_SESSION_ID="$SESSION_ID"

set +e
bash -c "$COMMAND"
TEST_CODE=$?
set -e
echo "::endgroup::"

RESULT="passed"
if [ "$TEST_CODE" -ne 0 ]; then
  RESULT="failed"
fi

# Report explicitly, then stop the trap from reporting twice.
report
trap - EXIT

# ── 5. Attach a test report (optional) ──────────────────────────────────────
# Runs before the result is reported, and even when the suite failed — a red run
# is exactly when the report matters.
if [ -n "$REPORT_PATH" ]; then
  if [ -f "$REPORT_PATH" ]; then
    echo "::group::Attach test report"
    if curl --silent --show-error --fail-with-body \
      --request POST "${API_URL}/api/v1/sessions/${SESSION_ID}/report" \
      "${AUTH[@]}" \
      --header "Content-Type: application/xml" \
      --data-binary "@${REPORT_PATH}" >/dev/null; then
      echo "Attached ${REPORT_PATH}"
    else
      echo "::warning::Could not attach the test report."
    fi
    echo "::endgroup::"
  else
    echo "::warning::report-path '${REPORT_PATH}' does not exist; skipping."
  fi
fi

# ── 6. Outputs ──────────────────────────────────────────────────────────────
{
  echo "session-id=${SESSION_ID}"
  echo "run-url=${API_URL}/dashboard/runs/${SESSION_ID}"
  echo "result=${RESULT}"
  echo "app-slug=${APP_SLUG}"
} >>"${GITHUB_OUTPUT:-/dev/null}"

step_summary

exit "$TEST_CODE"
