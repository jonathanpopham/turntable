#!/usr/bin/env bash
# Live smoke: exercises the DEPLOYED app end to end through its authenticated
# routes, then independently proves zero managed services remain via the GQL
# API. The only test allowed to spend money; it spends cents.
#
# Required env:
#   APP_URL            deployed roundhouse base url (no trailing slash)
#   APP_PASSWORD       basic auth password
#   RAILWAY_API_TOKEN  account or project token for the independent cleanup check
#   TARGET_PROJECT_ID  the managed project
#   TARGET_ENVIRONMENT_ID
set -euo pipefail

: "${APP_URL:?APP_URL is required}"
: "${APP_PASSWORD:?APP_PASSWORD is required}"
: "${RAILWAY_API_TOKEN:?RAILWAY_API_TOKEN is required}"
: "${TARGET_PROJECT_ID:?TARGET_PROJECT_ID is required}"
: "${TARGET_ENVIRONMENT_ID:?TARGET_ENVIRONMENT_ID is required}"

DEADLINE=$(( $(date +%s) + 300 ))   # hard budget: five minutes wall clock
AUTH_HEADER="Authorization: Bearer ${APP_PASSWORD}"

app() { # method path
  curl -sS -m 15 -H "$AUTH_HEADER" -X "$1" "${APP_URL}$2"
}

gql() {
  curl -sS -m 15 https://backboard.railway.com/graphql/v2 \
    -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
    -H "Content-Type: application/json" -d "$1"
}

remaining_services() {
  gql "{\"query\":\"query { project(id: \\\"$TARGET_PROJECT_ID\\\") { services { edges { node { id name } } } } }\"}" \
    | jq '[.data.project.services.edges[].node | select(.name == "roundhouse-managed")] | length'
}

cleanup() {
  # Unconditional: even if the smoke failed, no managed container survives.
  echo "cleanup: forcing teardown of any surviving managed service"
  IDS=$(gql "{\"query\":\"query { project(id: \\\"$TARGET_PROJECT_ID\\\") { services { edges { node { id name } } } } }\"}" \
    | jq -r '.data.project.services.edges[].node | select(.name == "roundhouse-managed") | .id')
  for id in $IDS; do
    gql "{\"query\":\"mutation { serviceDelete(id: \\\"$id\\\", environmentId: \\\"$TARGET_ENVIRONMENT_ID\\\") }\"}" >/dev/null
    echo "cleanup: delete requested for $id"
  done
}
trap cleanup EXIT

check_deadline() {
  if [ "$(date +%s)" -gt "$DEADLINE" ]; then
    echo "FAIL: smoke exceeded the five minute budget" >&2
    exit 1
  fi
}

wait_for_state() { # target-state
  while true; do
    check_deadline
    STATE=$(app GET /api/status | jq -r '.view.state')
    echo "observed: $STATE"
    [ "$STATE" = "$1" ] && return 0
    sleep 3
  done
}

echo "== health =="
curl -sS -m 15 "${APP_URL}/healthz" | jq -e '.ok == true' >/dev/null
echo "ok"

echo "== auth boundary: unauthenticated status is refused =="
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -m 15 "${APP_URL}/api/status")
[ "$CODE" = "401" ] || { echo "FAIL: expected 401, got $CODE" >&2; exit 1; }
echo "ok"

echo "== spin up =="
app POST /api/up | jq -c
wait_for_state running

echo "== spin down =="
app POST /api/down | jq -c
wait_for_state idle

echo "== independent proof: zero managed services remain =="
LEFT=$(remaining_services)
[ "$LEFT" = "0" ] || { echo "FAIL: $LEFT managed service(s) remain" >&2; exit 1; }
echo "PASS: full deployed-app cycle green, nothing leaked"
