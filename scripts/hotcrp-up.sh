#!/usr/bin/env bash
# Start a disposable HotCRP, create a chair account, mint an API token, and
# write the connection settings to .env.test (or $PCS_ENV_OUT).
#
#   scripts/hotcrp-up.sh            # project "pcs", port 8080
#   COMPOSE_PROJECT_NAME=pcs-ci HOTCRP_PORT=18080 scripts/hotcrp-up.sh
#
# Tear down with: docker compose -p "${COMPOSE_PROJECT_NAME:-pcs}" -f hotcrp/compose.yaml down -v
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-pcs}"
export HOTCRP_PORT="${HOTCRP_PORT:-8080}"
ADMIN="${HOTCRP_ADMIN_EMAIL:-admin@example.org}"
OUT="${PCS_ENV_OUT:-$ROOT/.env.test}"
dc() { docker compose -p "$COMPOSE_PROJECT_NAME" -f "$ROOT/hotcrp/compose.yaml" "$@"; }

dc up -d --build --wait
dc exec -T hotcrp php batch/saveusers.php -u "$ADMIN" -r sysadmin,chair --uname "Test Admin" >/dev/null
TOKEN="$(dc exec -T hotcrp php batch/apitoken.php create -e 7d --note pcs-test "$ADMIN" | tail -1 | tr -d '\r')"
[[ "$TOKEN" == hct_* ]] || { echo "hotcrp-up: token mint failed: $TOKEN" >&2; exit 1; }

URL="http://127.0.0.1:${HOTCRP_PORT}"
WHO="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$URL/api/whoami?pretty=0")"
echo "$WHO" | grep -q '"sysadmin"' || { echo "hotcrp-up: token is not a sysadmin: $WHO" >&2; exit 1; }

cat > "$OUT" <<ENV
PCS_HOTCRP_URL=$URL
PCS_HOTCRP_TOKEN=$TOKEN
HOTCRP_COMPOSE_PROJECT=$COMPOSE_PROJECT_NAME
ENV
echo "hotcrp-up: ready at $URL (chair $ADMIN); wrote $OUT"
