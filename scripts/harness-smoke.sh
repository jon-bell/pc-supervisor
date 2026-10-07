#!/usr/bin/env bash
# Minimal end-to-end check of the harness: seed one PC, one submitted paper,
# reviews, a metareviewer, and an actas comment; then read them back through
# the API the app depends on. Replaced by the real seeder's `golden` scenario
# once it exists, but kept as a fast canary for HotCRP version bumps.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a; . "${PCS_ENV_OUT:-$ROOT/.env.test}"; set +a
# This script writes. Only ever to the local harness (AGENTS.md rules 2-3).
case "${PCS_HOTCRP_URL:-}" in
  *@*) echo "harness-smoke: refusing: PCS_HOTCRP_URL carries userinfo (@)" >&2; exit 1 ;;
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "harness-smoke: refusing: PCS_HOTCRP_URL is not http://127.0.0.1:<port> or http://localhost:<port>" >&2; exit 1 ;;
esac
dc() { docker compose -p "${HOTCRP_COMPOSE_PROJECT:-pcs}" -f "$ROOT/hotcrp/compose.yaml" "$@"; }
api() { curl -fsS -H "Authorization: Bearer $PCS_HOTCRP_TOKEN" "$@"; }
U="$PCS_HOTCRP_URL/api"
TMP="$(mktemp -d)"; trap 'rm -rf -- "$TMP"' EXIT

dc exec -T hotcrp php batch/settings.php save -e '{"review_open":true,"review":[{"id":1,"name":"","soft":"2099-01-01","done":"2099-01-02"}],"comment_allow_always":true}' >/dev/null
dc exec -T hotcrp php batch/saveusers.php -e '[{"email":"ac1@example.org","roles":"pc"},{"email":"r1@example.org","roles":"pc"},{"email":"r2@example.org","roles":"pc"}]' >/dev/null
dc exec -T hotcrp cp test/sample50pg.pdf /tmp/smoke.pdf
echo '[{"pid":1,"title":"Smoke Paper","abstract":"x","authors":[{"email":"au@example.org"}],"status":"submitted","submission":{"content_file":"smoke.pdf","mimetype":"application/pdf"}}]' > "$TMP/p.json"
dc cp "$TMP/p.json" hotcrp:/tmp/smoke.json >/dev/null 2>&1
dc exec -T hotcrp php batch/savepapers.php /tmp/smoke.json >/dev/null
printf 'paper,action,user\n1,metareview,ac1@example.org\n1,primary,r1@example.org\n1,primary,r2@example.org\n' \
  | dc exec -T hotcrp php batch/assign.php >/dev/null

rids="$(api "$U/reviews?p=1&pretty=0" | python3 -c 'import json,sys; print(" ".join(str(r["rid"]) for r in json.load(sys.stdin)["reviews"] if r["rtype"]==4))')"
set -- $rids
api -X POST -H 'Content-Type: application/json' "$U/reviews?notify=0&pretty=0" \
  -d "[{\"pid\":1,\"rid\":$1,\"OveMer\":1,\"RevExp\":3,\"PapSum\":\"a\",\"ComAut\":\"b\",\"submitted\":true},{\"pid\":1,\"rid\":$2,\"OveMer\":4,\"RevExp\":2,\"PapSum\":\"a\",\"ComAut\":\"b\",\"submitted\":true}]" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["ok"] and all(s["valid"] for s in d["status_list"]), d'
api -X POST -H 'Content-Type: application/json' "$U/1/comment?actas=ac1@example.org&notify=0&pretty=0" \
  -d '{"text":"@r2@example.org what convinced you?","visibility":"rev"}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["ok"], d'

# Time-warp: shift request times back a week. HotCRP omits a review's
# modified_at unless reviewModified > timeRequested, so same-second seeding
# would otherwise hide it. The real seeder shifts whole timelines this way.
dc exec -T db mariadb -uroot -proot "${HOTCRP_DB_NAME:-hotcrp}" \
  -e "update PaperReview set timeRequested = timeRequested - 7*86400"

api "$U/searchaction?action=get/pcassignments&q=all" | grep -q '^1,metareview,ac1@example.org'
api "$U/reviews?q=all&pretty=0" | python3 -c '
import json,sys
rs=json.load(sys.stdin)["reviews"]
assert sorted(r["rtype"] for r in rs)==[4,4,5], rs
assert sum(r["status"]=="complete" for r in rs)==2, rs
assert all("modified_at" in r for r in rs if r["status"]=="complete"), rs'
api "$U/comments?q=all&pretty=0" | python3 -c '
import json,sys
cs=json.load(sys.stdin)["comments"]
assert len(cs)==1 and cs[0]["author_email"]=="ac1@example.org" and "modified_at" in cs[0], cs'
echo "harness-smoke: ok"
