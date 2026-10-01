#!/usr/bin/env bash
# The federation drill (PRDCT-1370) — internal/federation.md "The federation
# drill". The FIRST automated test of the hub ↔ Hackathon Starter seam: it boots the
# two-instance harness (docker-compose.federation.yml + the drill overlay),
# runs both setups and a headless SSO login, and asserts on the HUB DATABASE
# — the only place the grant-family consequences are visible.
#
# What it proves (each leg = named assertions):
#
#   1. AUTH-3 — Hackathon Starter never hands a caller its provider grant: the
#      provider-grant routes answer 403 on the cloud edition.
#   2. CLOUD-2 — a hub that is SLOW BUT ALIVE (a delay hop past
#      Hackathon Starter's 5 s token timeout) commits a rotation Hackathon Starter never
#      hears about; the next Hackathon Starter demand PROBES (RFC 7662) instead of
#      re-presenting, marks its own grant dead, and the hub-side family —
#      the CLI grant shares it — is NOT torn down (rows before/after).
#   3. Per-client audiences (PRDCT-1376) — a second registry tool's
#      credential cannot mint a token audienced at Hackathon Starter's /mcp.
#   4. Post-rotation grace (PRDCT-1376/1370) — a token rotated out seconds
#      ago is re-armed on re-presentation (fresh pair, family intact, the
#      unused successor retired), and presenting that retired successor
#      tears the family down as reuse detection always did.
#   5. OIDC audit (PRDCT-1376) — the hub's audit log carries rows for the
#      authorize, token, revoke and consent surfaces the drill exercised.
#   6. Workspace creation (PRDCT-2443, Phase 3b) — the login's grant carries
#      orgs:create, POST /workspaces creates the organization AT THE HUB as
#      the user and projects it (owner, hubOrigin), the hub's audit row names
#      the tool client, a ytk_ key is refused; and the deploy-order fact:
#      the hub refuses a sign-in that requests a scope it does not list.
#   7. The placeholder tool on the cloud edition — the four legs a tool cut
#      from this template must keep: LOGIN (Phase 3), RECONCILE (the login
#      projection in Phase 3, the live one in Phase 3c), the tool's own
#      resource in a hub-origin workspace (Phase 3c: POST/GET /items by the
#      session and by a ytk_ key, membership mutations refused hub_managed),
#      the cloud closures of every non-hub credential entrance (Phase 4b),
#      CLI CONNECT (Phase 8: hub CLI key → POST /sso/tool-token → POST
#      /sso/cli-connect → a user-scoped ytk_ key that reads the item, the
#      exchange token refused on replay, the dead browser grant healed) and
#      LOGOUT (Phase 9: DELETE /cli/auth/key self-revoke → the same key 401;
#      the hub-side CLI logout cascades onto the offline grant; POST
#      /sso/logout ends the browser session).
#   8. The billing rail, phases 1 to 3 (Phase 8b) — one metered item per
#      surface lands at the hub exactly once; the price book, a 402 on an empty
#      balance, fail-open; the free plan's caps refused, lifted by staff.
#
# The browser sign-in on this pair starts on http://starter.ant.localhost:<port>,
# never on http://localhost:<port> (Slideless PRDCT-2645): the hub sends the
# browser back to starter.ant.localhost, so the state cookie set on one host
# cannot be read on the other and a sign-in started on localhost ends on
# /login?error=state_mismatch. Browsers resolve *.localhost to the loopback on
# their own; curl and Node do not, which is why the curl calls below pin the
# names with --resolve. Not a defect of the sign-in: a browser opened on the
# wrong host.
#
# Usage: ./scripts/federation-drill.sh
#   FEDERATION_HUB_DIR=<path>  hub checkout to build (default ../../../hub, see the compose file)
#   DRILL_SKIP_BUILD=1         reuse antasphere-hub:federation-dev + starter:federation-dev (CI pre-builds)
#   DRILL_KEEP=1               leave the stack up after a PASS (inspect; `down -v` yourself)
#
# A second copy beside a busy machine's standing stacks (PRDCT-2443): every
# fixed value is an env variable the compose files read too, today's value
# as the default — unset, CI's run is byte-for-byte what it always was.
#   FEDERATION_PROJECT=starter-federation         compose project name
#   FEDERATION_HUB_PORT=3300                        hub port (host = PORT = hostname port)
#   FEDERATION_SL_PORT=3310                         Hackathon Starter port (same rule)
#     Neither port may be on the Fetch standard's blocked-port list (6000,
#     6566, 6665-6669, 6697, 10080, ...): Node's fetch refuses every URL on
#     one with "bad port", and Hackathon Starter's own discovery call to the hub
#     dies before the SSO leg (found at Slideless with the hub on 6000).
#   FEDERATION_HOP_PORT=8474                        the delay hop's admin port
#   FEDERATION_MAIL_PORT=8030                       Mailpit UI host port
#   FEDERATION_SUBNET_PREFIX=172.30.250             the /24's first three octets
#   FEDERATION_HUB_IMAGE=antasphere-hub:federation-dev
#   FEDERATION_SL_IMAGE=starter:federation-dev
#
# Everything else is throwaway: the compose project's volumes go with
# `down -v` on exit, pass or fail.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT=${FEDERATION_PROJECT:-starter-federation}
HUB_PORT=${FEDERATION_HUB_PORT:-3300}
SL_PORT=${FEDERATION_SL_PORT:-3310}
HOP_PORT=${FEDERATION_HOP_PORT:-8474}
MAIL_PORT=${FEDERATION_MAIL_PORT:-8030}
HUB_IMAGE=${FEDERATION_HUB_IMAGE:-antasphere-hub:federation-dev}
SL_IMAGE=${FEDERATION_SL_IMAGE:-starter:federation-dev}
HUB=http://hub.ant.localhost:$HUB_PORT
SL=http://starter.ant.localhost:$SL_PORT
HOP=http://127.0.0.1:$HOP_PORT
# Mailpit's API: the hub's CLI sign-in code (Phase 8) is read from it.
MAIL=http://127.0.0.1:$MAIL_PORT
SL_CLIENT_ID=tool-starter-cloud
SL_CLIENT_SECRET=federation-dev-client-secret-0001
SECOND_CLIENT_ID=tool-drill-second
SECOND_CLIENT_SECRET=federation-dev-client-secret-0002
SECOND_RESOURCE=http://second.localhost:3320/mcp
SECOND_REDIRECT=http://second.localhost:3320/callback
SL_RESOURCE=http://starter.ant.localhost:$SL_PORT/mcp
PASS_COUNT=0

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
note() { printf '    · %s\n' "$*"; }
pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '  \033[32mPASS\033[0m %s\n' "$*"
}
fail() {
  printf '  \033[31mFAIL\033[0m %s\n' "$*" >&2
  exit 1
}

for bin in docker jq curl openssl; do
  command -v "$bin" >/dev/null || fail "required tool missing: $bin"
done
for port in "$HUB_PORT" "$SL_PORT" "$HOP_PORT" "$MAIL_PORT"; do
  if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$port/" 2>/dev/null; then
    fail "port $port already answers — refusing to run (the harness needs $HUB_PORT, $SL_PORT, $HOP_PORT and $MAIL_PORT)"
  fi
done

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/federation-drill.XXXXXX")"
# The claim credential Hackathon Starter's POST /setup requires (PRDCT-1347); the drill
# overlay hands it to the app container.
export FEDERATION_DRILL_SETUP_TOKEN="$(openssl rand -hex 16)"
HUB_JAR="$SCRATCH/hub.cookies"
SL_JAR="$SCRATCH/sl.cookies"

dc() {
  docker compose -p "$PROJECT" \
    -f "$REPO/docker-compose.federation.yml" -f "$REPO/docker-compose.federation.drill.yml" "$@"
}
# *.localhost resolves in browsers by RFC 6761 but not in every curl: pin both names.
CURL=(curl -sS --max-time 60 --resolve "hub.ant.localhost:$HUB_PORT:127.0.0.1" --resolve "starter.ant.localhost:$SL_PORT:127.0.0.1")
hubdb() { dc exec -T hub-db psql -U antasphere -d antasphere -v ON_ERROR_STOP=1 -Atc "$1"; }
sldb() { dc exec -T db psql -U app -d app -v ON_ERROR_STOP=1 -Atc "$1"; }
applogs() { dc logs --no-log-prefix "$1" 2>/dev/null || true; }

wait_ready() { # service url timeout_s
  local i=0
  until "${CURL[@]}" -o /dev/null -f "$2" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -ge "$3" ] && {
      applogs "$1" | tail -30 >&2
      fail "$1 ($2) not ready after $3 s"
    }
    sleep 1
  done
  return 0
}

dump_logs() {
  for svc in hub app hubhop; do
    echo "── logs: $svc ──────────────────────────────────────────────" >&2
    applogs "$svc" | tail -40 >&2
  done
}

CLEANED=0
cleanup() {
  local status=$?
  [ "$CLEANED" = 1 ] && exit "$status"
  CLEANED=1
  [ "$status" != 0 ] && dump_logs
  if [ "$status" = 0 ] && [ "${DRILL_KEEP:-}" = "1" ]; then
    echo "  DRILL_KEEP=1: stack left up (project $PROJECT)"
  else
    say "Teardown"
    dc down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$SCRATCH"
  if [ "$status" = 0 ]; then
    printf '\n\033[32m✔ federation drill passed — %s assertions\033[0m\n' "$PASS_COUNT"
  else
    printf '\n\033[31m✘ federation drill FAILED (after %s passing assertions)\033[0m\n' "$PASS_COUNT" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
# Family rows of (client, user) at the hub: "<total> <live> <retired-at-epoch>".
family() { # client_id user_id
  hubdb "SELECT count(*) || ' ' || count(*) FILTER (WHERE revoked IS NULL) || ' ' || count(*) FILTER (WHERE revoked = timestamp '1970-01-01 00:00:00') FROM oauth_refresh_token WHERE client_id = '$1' AND user_id = '$2'"
}

# ── Phase 0 — images ─────────────────────────────────────────────────────────
say "Phase 0 — images (hub from ${FEDERATION_HUB_DIR:-../../../hub}, Hackathon Starter from this repo)"
if [ "${DRILL_SKIP_BUILD:-}" = "1" ] \
  && docker image inspect "$HUB_IMAGE" >/dev/null 2>&1 \
  && docker image inspect "$SL_IMAGE" >/dev/null 2>&1; then
  note "DRILL_SKIP_BUILD=1 and both images exist — reusing"
else
  dc build
fi

# ── Phase 1 — up ─────────────────────────────────────────────────────────────
say "Phase 1 — bring the two-instance stack up"
dc down -v --remove-orphans >/dev/null 2>&1 || true
dc up -d --no-build
wait_ready hubhop "$HOP/version" 60
wait_ready hub "$HUB/healthz" 300
wait_ready app "$SL/healthz" 300
pass "hub, Hackathon Starter (cloud) and the delay hop are up"

# ── Phase 2 — setups ─────────────────────────────────────────────────────────
say "Phase 2 — both setups"
OWNER_EMAIL=drill-owner@drill.test
OWNER_PASSWORD="drill-owner-password-$(openssl rand -hex 6)"
hub_setup=$("${CURL[@]}" -X POST "$HUB/api/v1/setup" -H 'content-type: application/json' \
  -d "{\"instanceName\":\"Drill Hub\",\"owner\":{\"email\":\"$OWNER_EMAIL\",\"name\":\"Drill Owner\",\"password\":\"$OWNER_PASSWORD\"}}")
HUB_USER_ID=$(echo "$hub_setup" | jq -r '.ownerUserId // empty')
[ -n "$HUB_USER_ID" ] || fail "hub setup did not answer an ownerUserId: $hub_setup"
sl_setup=$("${CURL[@]}" -X POST "$SL/api/v1/setup" -H 'content-type: application/json' \
  -d "{\"instanceName\":\"Drill Hackathon Starter\",\"setupToken\":\"$FEDERATION_DRILL_SETUP_TOKEN\",\"owner\":{\"email\":\"sl-operator@drill.test\",\"name\":\"SL Operator\",\"password\":\"$OWNER_PASSWORD\"}}")
# ownerUserId first: a refusal body has no workspaceId either, so the null check
# alone passed on a 403 and the instance was never claimed.
echo "$sl_setup" | jq -e '(.ownerUserId // "") != "" and .workspaceId == null' >/dev/null || fail "Hackathon Starter cloud setup should mint no workspace: $sl_setup"
seeded=$(applogs hub | grep -c 'tool registry: client seeded' || true)
[ "$seeded" -ge 2 ] || fail "expected the hub to seed 2 registry clients, saw $seeded log lines"
pass "hub setup (owner $HUB_USER_ID), Hackathon Starter cloud setup (no workspace), two registry clients seeded"

# The hub owner's browser session.
"${CURL[@]}" -f -o /dev/null -c "$HUB_JAR" -X POST "$HUB/api/v1/auth/sign-in/email" \
  -H 'content-type: application/json' -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}"
me=$("${CURL[@]}" -b "$HUB_JAR" "$HUB/api/v1/me")
echo "$me" | jq -e --arg e "$OWNER_EMAIL" '.user.email == $e' >/dev/null || fail "hub sign-in did not yield a session: $me"
pass "hub owner signed in (session cookie)"

# ── Phase 3 — headless SSO login at Hackathon Starter ────────────────────────────────
say "Phase 3 — headless 'Sign in with Antasphere' (registry tools skip the consent screen)"
initiate=$("${CURL[@]}" -c "$SL_JAR" -X POST "$SL/api/v1/auth/sign-in/oauth2" -H 'content-type: application/json' \
  -d '{"providerId":"antasphere","callbackURL":"/"}')
AUTHZ_URL=$(echo "$initiate" | jq -r '.url // empty')
[ -n "$AUTHZ_URL" ] || fail "Hackathon Starter did not answer an authorize URL: $initiate"
# The authorize hop runs on the hub owner's session; a registry client
# short-circuits straight to the code redirect.
location=$("${CURL[@]}" -b "$HUB_JAR" -o /dev/null -w '%{redirect_url}' "$AUTHZ_URL")
case "$location" in
  "$SL/api/v1/auth/oauth2/callback/antasphere?"*code=*) ;;
  *) fail "authorize did not redirect to the Hackathon Starter callback with a code: $location" ;;
esac
cb_status=$("${CURL[@]}" -b "$SL_JAR" -c "$SL_JAR" -o /dev/null -w '%{http_code}' "$location")
[ "$cb_status" = 302 ] || fail "Hackathon Starter callback answered $cb_status"
sl_me=$("${CURL[@]}" -b "$SL_JAR" "$SL/api/v1/me")
echo "$sl_me" | jq -e --arg e "$OWNER_EMAIL" '.user.email == $e' >/dev/null || fail "no Hackathon Starter session after the callback: $sl_me"
SL_USER_ID=$(echo "$sl_me" | jq -r '.user.id')
grant_row=$(sldb "SELECT (refresh_token IS NOT NULL)::int FROM account WHERE provider_id = 'antasphere' AND user_id = '$SL_USER_ID'")
[ "$grant_row" = 1 ] || fail "Hackathon Starter holds no hub grant on the account row after login"
read -r fam_total fam_live _ <<<"$(family "$SL_CLIENT_ID" "$HUB_USER_ID")"
[ "$fam_total" = 1 ] && [ "$fam_live" = 1 ] || fail "expected exactly one live refresh row at the hub after login, got total=$fam_total live=$fam_live"
pass "SSO login through the proxy hop: Hackathon Starter session + encrypted grant; hub family = 1 live row"
# The login reconcile (fail-closed, as the user): what the hub lists for the
# person is exactly what the login projected — one hub-origin membership per
# organization, no more, no fewer.
hub_org_ids=$("${CURL[@]}" -b "$HUB_JAR" "$HUB/api/v1/orgs" | jq -r '.orgs[].id' | LC_ALL=C sort | paste -sd, -)
[ -n "$hub_org_ids" ] || fail "the hub lists no organization for the owner — the login reconcile has nothing to prove"
projected_ids=$(sldb "SELECT w.central_account_id FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = '$SL_USER_ID' AND m.origin = 'hub' AND m.is_active" | LC_ALL=C sort | paste -sd, -)
[ "$projected_ids" = "$hub_org_ids" ] || fail "the login reconcile projected '$projected_ids', the hub lists '$hub_org_ids'"
pass "login reconcile: the hub-origin memberships project exactly the hub's organizations for the user ($hub_org_ids)"

# ── Phase 3b — workspace creation through the hub (PRDCT-2443) ──────────────
say "Phase 3b — a signed-in person creates a workspace: an organization at the hub, as them"
# The deploy-order fact first (CLAUDE.md: THE HUB DEPLOYS FIRST). The hub's
# authorize endpoint validates every requested scope against the CLIENT's
# registered scopes, so a Hackathon Starter that requests a scope the hub does not
# list for it fails the WHOLE sign-in — recorded here with a scope no hub
# knows, on the same client, the same session and the same redirect URI the
# real sign-in used. The redirect is read, never followed: Hackathon Starter sees
# nothing of it.
unknown_scope_authz="$HUB/api/v1/auth/oauth2/authorize?response_type=code&client_id=$SL_CLIENT_ID&redirect_uri=$(printf '%s' "$SL/api/v1/auth/oauth2/callback/antasphere" | jq -sRr @uri)&scope=openid%20drill%3Aunknown-scope&state=drill-unknown-scope"
unknown_status=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/unknown-scope.out" -w '%{http_code} %{redirect_url}' "$unknown_scope_authz")
note "authorize with an unknown scope: $unknown_status"
case "$unknown_status" in
  *invalid_scope*) ;;
  *) grep -q invalid_scope "$SCRATCH/unknown-scope.out" \
    || fail "the hub did not refuse an unknown requested scope with invalid_scope: $unknown_status $(head -c 400 "$SCRATCH/unknown-scope.out")" ;;
esac
pass "deploy order: a sign-in requesting a scope the hub does not list for the client is refused whole (invalid_scope)"

# What the hub granted this login, and what the registry row allows — the
# facts a failed creation is diagnosed against.
grant_scopes=$(hubdb "SELECT array_to_string(scopes, ' ') FROM oauth_refresh_token WHERE client_id = '$SL_CLIENT_ID' AND user_id = '$HUB_USER_ID' AND revoked IS NULL")
client_scopes=$(hubdb "SELECT array_to_string(scopes, ' ') FROM oauth_client WHERE client_id = '$SL_CLIENT_ID'")
note "hub grant scopes: $grant_scopes"
note "registry client scopes: $client_scopes"
case " $grant_scopes " in
  *" orgs:create "*) ;;
  *) fail "the login's grant carries no orgs:create at the hub (grant='$grant_scopes', client='$client_scopes')" ;;
esac
pass "the login's hub grant carries orgs:create"

me_before=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/me-before.json" -w '%{http_code}' "$SL/api/v1/me")
[ "$me_before" = 200 ] && jq -e '.canCreateWorkspace == true' "$SCRATCH/me-before.json" >/dev/null \
  || fail "GET /me before creation: $me_before $(cat "$SCRATCH/me-before.json")"
ws_before=$(jq -r '.workspaces | length' "$SCRATCH/me-before.json")
pass "GET /me: canCreateWorkspace is true ($ws_before workspace(s) listed before)"

create_status=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/ws-create.json" -w '%{http_code}' -X POST "$SL/api/v1/workspaces" \
  -H "Origin: $SL" -H 'content-type: application/json' -d '{"name":"Drill Workspace"}')
if [ "$create_status" != 201 ]; then
  echo "    hub-side diagnosis — grant scopes: '$grant_scopes'; client scopes: '$client_scopes'" >&2
  echo "    hub access tokens for the client: $(hubdb "SELECT count(*) || ' rows, scopes: ' || string_agg(array_to_string(scopes, ' '), ' | ') FROM oauth_access_token WHERE client_id = '$SL_CLIENT_ID' AND user_id = '$HUB_USER_ID'")" >&2
  fail "POST /workspaces answered $create_status (expected 201): $(cat "$SCRATCH/ws-create.json")"
fi
WS_ID=$(jq -r '.workspace.id // empty' "$SCRATCH/ws-create.json")
[ -n "$WS_ID" ] || fail "201 without a workspace id: $(cat "$SCRATCH/ws-create.json")"
jq -e '.workspace.name == "Drill Workspace"' "$SCRATCH/ws-create.json" >/dev/null || fail "201 with the wrong name: $(cat "$SCRATCH/ws-create.json")"
pass "POST /workspaces {name: Drill Workspace} → 201, local workspace $WS_ID"

me_after=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/me-after.json" -w '%{http_code}' "$SL/api/v1/me")
[ "$me_after" = 200 ] || fail "GET /me after creation answered $me_after: $(cat "$SCRATCH/me-after.json")"
jq -e --arg id "$WS_ID" '.workspaces[] | select(.id == $id) | (.hubOrigin == true and .role == "owner" and .name == "Drill Workspace")' \
  "$SCRATCH/me-after.json" >/dev/null || fail "GET /me does not list $WS_ID as a hub-origin workspace owned by the caller: $(jq -c '.workspaces' "$SCRATCH/me-after.json")"
[ "$(jq -r '.workspaces | length' "$SCRATCH/me-after.json")" = "$((ws_before + 1))" ] \
  || fail "GET /me lists $(jq -r '.workspaces | length' "$SCRATCH/me-after.json") workspaces, expected $((ws_before + 1))"
pass "GET /me lists the new workspace: hubOrigin true, role owner"

members_status=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/members.json" -w '%{http_code}' -H "X-Workspace-Id: $WS_ID" "$SL/api/v1/members")
[ "$members_status" = 200 ] || fail "GET /members in the new workspace answered $members_status: $(cat "$SCRATCH/members.json")"
jq -e --arg u "$SL_USER_ID" '.members[] | select(.userId == $u) | (.role == "owner" and .isActive == true)' "$SCRATCH/members.json" >/dev/null \
  || fail "the caller is not the active owner of $WS_ID: $(jq -c '.members' "$SCRATCH/members.json")"
[ "$(jq -r '.members | length' "$SCRATCH/members.json")" = 1 ] || fail "expected exactly one member, got $(jq -c '.members' "$SCRATCH/members.json")"
pass "a workspace-scoped read (X-Workspace-Id: $WS_ID, GET /members) → 200, the caller its only member, owner"

# The hub side, read AS THE USER through the hub session: the organization
# is theirs, and its genesis audit row names the tool client as the channel.
hub_orgs=$("${CURL[@]}" -b "$HUB_JAR" "$HUB/api/v1/orgs")
HUB_ORG_ID=$(echo "$hub_orgs" | jq -r '[.orgs[] | select(.name == "Drill Workspace" and .role == "owner")][0].id // empty')
[ -n "$HUB_ORG_ID" ] || fail "the hub does not list 'Drill Workspace' owned by the user: $hub_orgs"
projected=$(sldb "SELECT central_account_id FROM workspaces WHERE id = '$WS_ID'")
[ "$projected" = "$HUB_ORG_ID" ] || fail "the local workspace projects hub org '$projected', the hub says '$HUB_ORG_ID'"
pass "the hub lists the organization ($HUB_ORG_ID) for the user as owner, and the local workspace projects exactly it"
read -r audit_via audit_client audit_tool <<<"$(hubdb "SELECT actor_via || ' ' || coalesce(metadata->>'oauthClientId', '-') || ' ' || coalesce(metadata->>'viaTool', '-') FROM audit_log WHERE action = 'workspace.create' AND workspace_id = '$HUB_ORG_ID'")"
[ "$audit_via" = oauth ] && [ "$audit_client" = "$SL_CLIENT_ID" ] && [ "$audit_tool" = true ] \
  || fail "the hub's workspace.create row for $HUB_ORG_ID does not name the tool client: actor_via='$audit_via' oauthClientId='$audit_client' viaTool='$audit_tool'"
pass "the hub's audit log: workspace.create for $HUB_ORG_ID, actor_via oauth, oauthClientId $SL_CLIENT_ID"

# A machine credential never creates a workspace: a ytk_ key minted in the
# new workspace by its owner is refused (POST /workspaces is unlisted in the
# fail-closed allowlist).
key_status=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/key.json" -w '%{http_code}' -X POST "$SL/api/v1/api-keys" \
  -H "Origin: $SL" -H "X-Workspace-Id: $WS_ID" -H 'content-type: application/json' \
  -d '{"name":"drill key","scopes":["items:read","items:write"]}')
[ "$key_status" = 201 ] || fail "minting an API key in the new workspace answered $key_status: $(cat "$SCRATCH/key.json")"
MINTED_KEY=$(jq -r '.key' "$SCRATCH/key.json")
case "$MINTED_KEY" in ytk_*) ;; *) fail "the minted key does not carry the ytk_ prefix" ;; esac
key_create=$("${CURL[@]}" -o "$SCRATCH/key-create.json" -w '%{http_code}' -X POST "$SL/api/v1/workspaces" \
  -H "Authorization: Bearer $MINTED_KEY" -H 'content-type: application/json' -d '{"name":"Key Workspace"}')
[ "$key_create" = 403 ] || fail "POST /workspaces with a ytk_ key answered $key_create (expected 403): $(cat "$SCRATCH/key-create.json")"
! grep -q '"workspace"' "$SCRATCH/key-create.json" || fail "the 403 carries a workspace: $(cat "$SCRATCH/key-create.json")"
pass "POST /workspaces with a ytk_ key → 403 ($(jq -r '.error.code' "$SCRATCH/key-create.json"))"

# ── Phase 3c — the placeholder tool in the hub-origin workspace ─────────────
say "Phase 3c — the tool's own resource (items) in the projected workspace, and the live reconcile"
item_status=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/item.json" -w '%{http_code}' -X POST "$SL/api/v1/items" \
  -H "Origin: $SL" -H "X-Workspace-Id: $WS_ID" -H 'content-type: application/json' \
  -d '{"name":"Drill item","note":"created by the SSO session"}')
[ "$item_status" = 201 ] || fail "POST /items in the hub-origin workspace answered $item_status: $(cat "$SCRATCH/item.json")"
ITEM_ID=$(jq -r '.item.id // empty' "$SCRATCH/item.json")
[ -n "$ITEM_ID" ] || fail "201 without an item id: $(cat "$SCRATCH/item.json")"
jq -e --arg w "$WS_ID" --arg u "$SL_USER_ID" '.item.workspaceId == $w and .item.createdBy == $u and .item.name == "Drill item"' \
  "$SCRATCH/item.json" >/dev/null || fail "the created item is not the caller's, in $WS_ID: $(cat "$SCRATCH/item.json")"
pass "the SSO session creates an item in the hub-origin workspace: POST /items → 201 ($ITEM_ID)"
list_status=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/items.json" -w '%{http_code}' -H "X-Workspace-Id: $WS_ID" "$SL/api/v1/items")
[ "$list_status" = 200 ] && jq -e --arg id "$ITEM_ID" '[.items[].id] == [$id]' "$SCRATCH/items.json" >/dev/null \
  || fail "GET /items does not list exactly the created item: $list_status $(cat "$SCRATCH/items.json")"
# Tenancy: the person's OTHER hub-origin workspace (the hub's genesis
# organization, projected at login) holds no item.
OTHER_WS_ID=$(jq -r --arg id "$WS_ID" '[.workspaces[] | select(.id != $id)][0].id // empty' "$SCRATCH/me-after.json")
[ -n "$OTHER_WS_ID" ] || fail "GET /me lists no second workspace to read the item from"
other_status=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/items-other.json" -w '%{http_code}' -H "X-Workspace-Id: $OTHER_WS_ID" "$SL/api/v1/items")
[ "$other_status" = 200 ] && jq -e '.items == []' "$SCRATCH/items-other.json" >/dev/null \
  || fail "the item leaked into workspace $OTHER_WS_ID: $other_status $(cat "$SCRATCH/items-other.json")"
pass "GET /items lists it back in $WS_ID and nothing in the person's other workspace ($OTHER_WS_ID)"
# The ytk_ key minted above carries items:read + items:write: the scope
# allowlist opens /items to it, and nothing else of the tool.
key_read=$("${CURL[@]}" -o "$SCRATCH/key-item.json" -w '%{http_code}' -H "Authorization: Bearer $MINTED_KEY" -H "X-Workspace-Id: $WS_ID" "$SL/api/v1/items/$ITEM_ID")
[ "$key_read" = 200 ] && jq -e --arg id "$ITEM_ID" '.id == $id' "$SCRATCH/key-item.json" >/dev/null \
  || fail "GET /items/$ITEM_ID with the ytk_ key answered $key_read: $(cat "$SCRATCH/key-item.json")"
key_patch=$("${CURL[@]}" -o "$SCRATCH/key-patch.json" -w '%{http_code}' -X PATCH "$SL/api/v1/items/$ITEM_ID" \
  -H "Authorization: Bearer $MINTED_KEY" -H "X-Workspace-Id: $WS_ID" -H 'content-type: application/json' -d '{"note":"patched by the ytk_ key"}')
[ "$key_patch" = 200 ] && jq -e '.note == "patched by the ytk_ key"' "$SCRATCH/key-patch.json" >/dev/null \
  || fail "PATCH /items/$ITEM_ID with the ytk_ key answered $key_patch: $(cat "$SCRATCH/key-patch.json")"
pass "the ytk_ key (items:read, items:write) reads and patches the item"

# P7: the projected workspace's roster is the hub's. A local membership
# mutation is refused with the pointer; the read stays.
invite_status=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/invite.json" -w '%{http_code}' -X POST "$SL/api/v1/invitations" \
  -H "Origin: $SL" -H "X-Workspace-Id: $WS_ID" -H 'content-type: application/json' -d '{"email":"invitee@drill.test","role":"member"}')
[ "$invite_status" = 403 ] && jq -e --arg hub "$HUB" '.error.code == "hub_managed" and (.error.details.manageUrl | startswith($hub))' "$SCRATCH/invite.json" >/dev/null \
  || fail "POST /invitations in a hub-origin workspace answered $invite_status (expected 403 hub_managed + manageUrl at the hub): $(cat "$SCRATCH/invite.json")"
[ "$(sldb "SELECT count(*) FROM invitations WHERE workspace_id = '$WS_ID'")" = 0 ] || fail "the refused invitation left a row"
pass "POST /invitations in the hub-origin workspace → 403 hub_managed, manageUrl $(jq -r '.error.details.manageUrl' "$SCRATCH/invite.json"), no row"

# The live reconcile (ADR 019): an organization created AT THE HUB, outside
# Hackathon Starter, reaches the person's workspace list on the next demand past the
# ~10 s reconcile TTL — read as the user with the stored grant, no new login.
hub_org_status=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/hub-org.json" -w '%{http_code}' -X POST "$HUB/api/v1/orgs" \
  -H "Origin: $HUB" -H 'content-type: application/json' -d '{"name":"Hub-side Org"}')
[ "$hub_org_status" = 201 ] || fail "POST /orgs at the hub (session) answered $hub_org_status: $(cat "$SCRATCH/hub-org.json")"
[ "$(sldb "SELECT count(*) FROM workspaces WHERE name = 'Hub-side Org'")" = 0 ] || fail "'Hub-side Org' exists locally before any reconcile"
sleep 11
"${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/me-live.json" "$SL/api/v1/me"
jq -e '[.workspaces[] | select(.name == "Hub-side Org" and .hubOrigin == true and .role == "owner")] | length == 1' "$SCRATCH/me-live.json" >/dev/null \
  || fail "the live reconcile did not project 'Hub-side Org': $(jq -c '.workspaces // .' "$SCRATCH/me-live.json")"
[ "$(jq -r '.workspaces | length' "$SCRATCH/me-live.json")" = "$((ws_before + 2))" ] \
  || fail "GET /me lists $(jq -r '.workspaces | length' "$SCRATCH/me-live.json") workspaces, expected $((ws_before + 2))"
pass "live reconcile: an organization created at the hub is projected on the next demand past the TTL (hubOrigin, owner) — same session, no login"

# ── Phase 4 — AUTH-3: the provider grant is never handed out ────────────────
say "Phase 4 — AUTH-3: the provider-grant routes are closed on cloud"
for path in get-access-token refresh-token; do
  # PRDCT-1812: Better Auth's origin guard (origin trust, PRDCT-1377/1378)
  # runs BEFORE the provider-grant hook and answers MISSING_OR_NULL_ORIGIN to a
  # cookie-bearing POST without an Origin. Send the instance's own origin so
  # the request reaches the closure this leg exists to test.
  code=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/pg.json" -w '%{http_code}' -X POST "$SL/api/v1/auth/$path" \
    -H "Origin: $SL" -H 'content-type: application/json' -d '{"providerId":"antasphere"}')
  [ "$code" = 403 ] || fail "/auth/$path answered $code (expected 403)"
  grep -q provider_grant_forbidden "$SCRATCH/pg.json" || fail "/auth/$path 403 lacks provider_grant_forbidden"
  ! grep -qE 'accessToken|refreshToken|access_token' "$SCRATCH/pg.json" || fail "/auth/$path leaked token material"
done
pass "/auth/get-access-token and /auth/refresh-token answer 403 provider_grant_forbidden with no token material"

# ── Phase 4b — D1/P8: no non-hub credential entrance on cloud ────────────────
say "Phase 4b — every local credential entrance but the break-glass door is closed on cloud"
closed() { # label expected_status expected_marker path json_body
  local code
  code=$("${CURL[@]}" -o "$SCRATCH/closed.json" -w '%{http_code}' -X POST "$SL/api/v1$4" \
    -H "Origin: $SL" -H 'content-type: application/json' -d "$5")
  [ "$code" = "$2" ] || fail "$1: POST $4 answered $code (expected $2): $(head -c 300 "$SCRATCH/closed.json")"
  grep -q "$3" "$SCRATCH/closed.json" || fail "$1: POST $4 answered $2 without '$3': $(head -c 300 "$SCRATCH/closed.json")"
  ! grep -qE '"(token|key|url)"' "$SCRATCH/closed.json" || fail "$1: the refusal carries a credential or a redirect: $(head -c 300 "$SCRATCH/closed.json")"
}
otp_body="{\"email\":\"$OWNER_EMAIL\",\"otp\":\"000000\"}"
closed "CLI OTP mint, request leg" 403 cli_otp_disabled /cli/auth/request "{\"email\":\"$OWNER_EMAIL\"}"
closed "CLI OTP mint, complete leg" 403 cli_otp_disabled /cli/auth/complete "$otp_body"
pass "the tool's own CLI OTP mint answers 403 cli_otp_disabled on both legs (the cloud CLI door is /sso/cli-connect)"
closed "emailOTP sign-in" 403 otp_signin_disabled /auth/sign-in/email-otp "$otp_body"
closed "emailOTP send leg" 403 otp_signin_disabled /auth/email-otp/send-verification-otp "{\"email\":\"$OWNER_EMAIL\",\"type\":\"sign-in\"}"
closed "emailOTP verify-email" 403 otp_signin_disabled /auth/email-otp/verify-email "$otp_body"
pass "the emailOTP session surface answers 403 otp_signin_disabled (sign-in, send, verify-email)"
closed "password reset request" 403 'Password reset is disabled' /auth/request-password-reset "{\"email\":\"$OWNER_EMAIL\"}"
closed "password reset" 403 'Password reset is disabled' /auth/reset-password '{"newPassword":"drill-new-password-0001","token":"drill"}'
closed "emailOTP password reset" 403 'Password reset is disabled' /auth/email-otp/reset-password "{\"email\":\"$OWNER_EMAIL\",\"otp\":\"000000\",\"password\":\"drill-new-password-0001\"}"
pass "the password-reset surface answers 403 (request, reset, the emailOTP reset)"
closed "Google social sign-in" 404 PROVIDER_NOT_FOUND /auth/sign-in/social '{"provider":"google","callbackURL":"/"}'
pass "the Google social provider is not registered on cloud (404 PROVIDER_NOT_FOUND)"
mails=$("${CURL[@]}" "$MAIL/api/v1/search?query=$(printf 'to:%s' "$OWNER_EMAIL" | jq -sRr @uri)" | jq -r '.messages | length')
[ "$mails" = 0 ] || fail "a refused entrance still mailed the owner ($mails message(s) in Mailpit)"
pass "none of the refused entrances mailed a code (Mailpit holds nothing for $OWNER_EMAIL)"

# ── Phase 5 — CLOUD-2: the slow-but-alive hub ────────────────────────────────
say "Phase 5 — CLOUD-2: a refresh that times out AFTER the hub rotated"
# Expire the stored access token and clear the in-process cache (a restart),
# so the next authenticated request must refresh through the hop.
sldb "UPDATE account SET access_token_expires_at = now() - interval '1 hour' WHERE provider_id = 'antasphere' AND user_id = '$SL_USER_ID'" >/dev/null
dc restart app >/dev/null 2>&1
wait_ready app "$SL/healthz" 300
# Latency past Hackathon Starter's 5 s token timeout — the request still completes at the hub.
"${CURL[@]}" -f -o /dev/null -X POST "$HOP/latency" -H 'content-type: application/json' -d '{"ms":7000}'
t0=$(date +%s)
slow_status=$("${CURL[@]}" --max-time 40 -b "$SL_JAR" -o "$SCRATCH/slow.json" -w '%{http_code}' "$SL/api/v1/me")
elapsed=$(( $(date +%s) - t0 ))
note "GET /me during the slow window: $slow_status after ${elapsed}s"
"${CURL[@]}" -f -o /dev/null -X DELETE "$HOP/latency"
# Give the hub's side of the aborted request time to commit its rotation.
sleep 3
read -r fam_total fam_live _ <<<"$(family "$SL_CLIENT_ID" "$HUB_USER_ID")"
[ "$fam_total" = 2 ] && [ "$fam_live" = 1 ] || fail "expected the hub to have rotated (2 rows, 1 live), got total=$fam_total live=$fam_live"
pass "the hub committed the rotation Hackathon Starter never heard about: family = 2 rows, 1 live"
presented=$(sldb "SELECT count(*) FROM hub_grant_presentations p JOIN account a ON a.id = p.account_id WHERE a.user_id = '$SL_USER_ID' AND p.refresh_token = a.refresh_token")
[ "$presented" = 1 ] || fail "Hackathon Starter holds no unanswered-presentation record for the token it presented (count=$presented)"
pass "Hackathon Starter recorded the presentation as unanswered (hub_grant_presentations)"
# The next demand: after the reconcile TTL, Hackathon Starter must PROBE, not re-present.
sleep 12
after_status=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/after.json" -w '%{http_code}' "$SL/api/v1/me")
[ "$after_status" = 401 ] || fail "expected 401 hub_grant_expired after the probe, got $after_status: $(cat "$SCRATCH/after.json")"
grep -q hub_grant_expired "$SCRATCH/after.json" || fail "401 without hub_grant_expired: $(cat "$SCRATCH/after.json")"
read -r fam_total fam_live _ <<<"$(family "$SL_CLIENT_ID" "$HUB_USER_ID")"
[ "$fam_total" = 2 ] && [ "$fam_live" = 1 ] || fail "the family was TORN DOWN at the hub (total=$fam_total live=$fam_live) — Hackathon Starter re-presented the rotated-out token"
dead=$(sldb "SELECT (refresh_token IS NULL)::int FROM account WHERE provider_id = 'antasphere' AND user_id = '$SL_USER_ID'")
[ "$dead" = 1 ] || fail "Hackathon Starter did not mark its grant dead"
probes=$(hubdb "SELECT count(*) FROM audit_log WHERE action = 'oidc.token' AND metadata->>'grantType' = 'refresh_token' AND resource_id = '$SL_CLIENT_ID'")
[ "$probes" = 1 ] || fail "expected exactly ONE refresh presentation in the hub's audit log for $SL_CLIENT_ID, saw $probes"
pass "the next demand PROBED: Hackathon Starter answers 401 hub_grant_expired, its grant is dead, and the hub family is intact (2 rows, 1 live, exactly one presentation audited)"

# ── Phase 6 — hub-side legs on the second registry tool ─────────────────────
say "Phase 6 — per-client audiences + post-rotation grace (second registry tool, own family)"
verifier=$(openssl rand -hex 32)
challenge=$(printf '%s' "$verifier" | openssl dgst -sha256 -binary | b64url)
authz="$HUB/api/v1/auth/oauth2/authorize?response_type=code&client_id=$SECOND_CLIENT_ID&redirect_uri=$SECOND_REDIRECT&scope=openid%20offline_access%20account%3Aread&code_challenge=$challenge&code_challenge_method=S256&state=drill&resource=$SECOND_RESOURCE"
location=$("${CURL[@]}" -b "$HUB_JAR" -o /dev/null -w '%{redirect_url}' "$authz")
code=$(printf '%s' "$location" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
[ -n "$code" ] || fail "no code for the second tool: $location"
token() { # extra form fields...
  "${CURL[@]}" -o "$SCRATCH/token.json" -w '%{http_code}' -X POST "$HUB/api/v1/auth/oauth2/token" \
    -u "$SECOND_CLIENT_ID:$SECOND_CLIENT_SECRET" -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode "$@"
}
status=$(token "grant_type=authorization_code" --data-urlencode "code=$code" --data-urlencode "redirect_uri=$SECOND_REDIRECT" \
  --data-urlencode "code_verifier=$verifier" --data-urlencode "resource=$SL_RESOURCE")
[ "$status" = 400 ] && grep -q invalid_target "$SCRATCH/token.json" || fail "second tool minted (or was not refused with invalid_target) for Hackathon Starter's audience: $status $(cat "$SCRATCH/token.json")"
pass "per-client audiences: the second tool's code exchange for Hackathon Starter's /mcp answers 400 invalid_target"
status=$(token "grant_type=authorization_code" --data-urlencode "code=$code" --data-urlencode "redirect_uri=$SECOND_REDIRECT" \
  --data-urlencode "code_verifier=$verifier" --data-urlencode "resource=$SECOND_RESOURCE")
[ "$status" = 200 ] || fail "second tool's own-audience exchange failed: $status $(cat "$SCRATCH/token.json")"
T0=$(jq -r '.refresh_token' "$SCRATCH/token.json")
status=$(token "grant_type=refresh_token" --data-urlencode "refresh_token=$T0" --data-urlencode "resource=$SL_RESOURCE")
[ "$status" = 400 ] && grep -q invalid_target "$SCRATCH/token.json" || fail "refresh into a foreign audience was not refused: $status"
pass "per-client audiences: the refresh grant is scoped the same way (400 invalid_target, token untouched)"
status=$(token "grant_type=refresh_token" --data-urlencode "refresh_token=$T0" --data-urlencode "resource=$SECOND_RESOURCE")
[ "$status" = 200 ] || fail "own-audience refresh failed: $status"
T1=$(jq -r '.refresh_token' "$SCRATCH/token.json")
read -r total live retired <<<"$(family "$SECOND_CLIENT_ID" "$HUB_USER_ID")"
[ "$total" = 2 ] && [ "$live" = 1 ] || fail "after one rotation expected 2 rows / 1 live, got $total / $live"
# The timed-out client re-presents T0 seconds later.
status=$(token "grant_type=refresh_token" --data-urlencode "refresh_token=$T0" --data-urlencode "resource=$SECOND_RESOURCE")
[ "$status" = 200 ] || fail "post-rotation grace did not re-arm T0: $status $(cat "$SCRATCH/token.json")"
T2=$(jq -r '.refresh_token' "$SCRATCH/token.json")
read -r total live retired <<<"$(family "$SECOND_CLIENT_ID" "$HUB_USER_ID")"
[ "$total" = 3 ] && [ "$live" = 1 ] && [ "$retired" = 1 ] || fail "after the grace expected 3 rows / 1 live / 1 retired-at-epoch, got $total / $live / $retired"
pass "post-rotation grace: T0 re-presented within the window → fresh pair; family = 3 rows, 1 live, the unused successor retired at the epoch"
status=$(token "grant_type=refresh_token" --data-urlencode "refresh_token=$T2" --data-urlencode "resource=$SECOND_RESOURCE")
[ "$status" = 200 ] || fail "the graced pair does not work: $status"
status=$(token "grant_type=refresh_token" --data-urlencode "refresh_token=$T1" --data-urlencode "resource=$SECOND_RESOURCE")
[ "$status" = 400 ] && grep -q invalid_grant "$SCRATCH/token.json" || fail "the retired successor was not refused: $status"
read -r total live retired <<<"$(family "$SECOND_CLIENT_ID" "$HUB_USER_ID")"
[ "$total" = 0 ] || fail "presenting the retired successor should tear the family down; $total rows remain"
pass "the retired successor (a chase signature) tears the family down: 0 rows"
# The Hackathon Starter family was never touched by any of this.
read -r fam_total fam_live _ <<<"$(family "$SL_CLIENT_ID" "$HUB_USER_ID")"
[ "$fam_total" = 2 ] && [ "$fam_live" = 1 ] || fail "the Hackathon Starter family changed during the second tool's legs (total=$fam_total live=$fam_live)"
pass "the Hackathon Starter user's family is untouched by the second tool's legs"

# ── Phase 7 — OIDC audit rows ────────────────────────────────────────────────
say "Phase 7 — the hub audited what the drill exercised"
for action in oidc.authorize oidc.token; do
  n=$(hubdb "SELECT count(*) FROM audit_log WHERE action = '$action' AND workspace_id IS NULL")
  [ "$n" -ge 1 ] || fail "no instance-attributed audit row for $action"
done
n=$(hubdb "SELECT count(*) FROM audit_log WHERE action = 'oidc.token' AND metadata->>'outcome' = 'error:invalid_target'")
[ "$n" -ge 2 ] || fail "expected ≥2 audited invalid_target refusals, saw $n"
n=$(hubdb "SELECT count(*) FROM audit_log WHERE action = 'oidc.token' AND (metadata->>'rotationGrace')::boolean")
[ "$n" = 1 ] || fail "expected exactly one audited rotation grace, saw $n"
pass "audit rows: oidc.authorize + oidc.token present, instance-attributed; the refusals and the grace are on the record"

# ── Phase 8 — CLI connect: one hub login, the tool's key without a second sign-in ──
say "Phase 8 — CLI connect (antasphere login → POST /sso/tool-token → POST /sso/cli-connect)"
# Rows of the CLI offline-grant family of (client, user) at the hub — the
# hub's own discriminator (platform/offline-grants.ts): the root the exchange
# stamped with the minting key, plus its session-less rotations without openid.
offline_family() { # client_id user_id
  hubdb "SELECT count(*) FROM oauth_refresh_token WHERE client_id = '$1' AND user_id = '$2' AND (api_key_id IS NOT NULL OR (session_id IS NULL AND 'offline_access' = ANY(scopes) AND NOT 'openid' = ANY(scopes)))"
}
# What `antasphere login` does, headless: the hub mails a code, the code buys
# the person's ACCOUNT key (sso:exchange). The code is read from Mailpit.
otp_req=$("${CURL[@]}" -o "$SCRATCH/otp-req.json" -w '%{http_code}' -X POST "$HUB/api/v1/cli/auth/request" \
  -H 'content-type: application/json' -d "{\"email\":\"$OWNER_EMAIL\"}")
[ "$otp_req" = 200 ] || fail "the hub's POST /cli/auth/request answered $otp_req: $(cat "$SCRATCH/otp-req.json")"
OTP=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  OTP=$("${CURL[@]}" "$MAIL/api/v1/search?query=$(printf 'to:%s' "$OWNER_EMAIL" | jq -sRr @uri)" \
    | jq -r '.messages[0].Subject // ""' | sed -n 's/^\([0-9]\{4,10\}\) .*/\1/p')
  [ -n "$OTP" ] && break
  sleep 1
done
[ -n "$OTP" ] || fail "no sign-in code for $OWNER_EMAIL reached Mailpit ($MAIL)"
hubkey_status=$("${CURL[@]}" -o "$SCRATCH/hub-key.json" -w '%{http_code}' -X POST "$HUB/api/v1/cli/auth/complete" \
  -H 'content-type: application/json' -d "{\"email\":\"$OWNER_EMAIL\",\"otp\":\"$OTP\",\"keyName\":\"drill cli\"}")
[ "$hubkey_status" = 201 ] || fail "the hub's POST /cli/auth/complete answered $hubkey_status: $(jq -c '.error // .' "$SCRATCH/hub-key.json")"
HUB_KEY=$(jq -r '.key' "$SCRATCH/hub-key.json")
jq -e '.apiKey.scopes | index("sso:exchange")' "$SCRATCH/hub-key.json" >/dev/null || fail "the hub CLI key carries no sso:exchange: $(jq -c '.apiKey.scopes' "$SCRATCH/hub-key.json")"
pass "hub CLI login (emailed code from Mailpit) → an account key carrying sso:exchange"

tt_status=$("${CURL[@]}" -o "$SCRATCH/tool-token.json" -w '%{http_code}' -X POST "$HUB/api/v1/sso/tool-token" \
  -H "Authorization: Bearer $HUB_KEY" -H 'content-type: application/json' -d "{\"resource\":\"$SL_RESOURCE\"}")
[ "$tt_status" = 200 ] || fail "POST /sso/tool-token answered $tt_status: $(jq -c '.error // .' "$SCRATCH/tool-token.json")"
jq -e '(.token | length > 0) and (.hubRefreshToken | length > 0)' "$SCRATCH/tool-token.json" >/dev/null || fail "the exchange answered no token pair"
[ "$(offline_family "$SL_CLIENT_ID" "$HUB_USER_ID")" = 1 ] || fail "expected one offline-grant row at the hub after the exchange, got $(offline_family "$SL_CLIENT_ID" "$HUB_USER_ID")"
pass "POST /sso/tool-token (resource $SL_RESOURCE) → a 120 s exchange token + the offline grant (one row at the hub)"

# The browser session is still the one Phase 5 left: its grant is dead.
"${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/pre-connect.json" "$SL/api/v1/me"
grep -q hub_grant_expired "$SCRATCH/pre-connect.json" || fail "expected the browser session to still answer hub_grant_expired before the connect: $(cat "$SCRATCH/pre-connect.json")"
jq '{token, hubRefreshToken}' "$SCRATCH/tool-token.json" >"$SCRATCH/connect-body.json"
connect_status=$("${CURL[@]}" -o "$SCRATCH/connect.json" -w '%{http_code}' -X POST "$SL/api/v1/sso/cli-connect" \
  -H 'content-type: application/json' -d @"$SCRATCH/connect-body.json")
[ "$connect_status" = 201 ] || fail "POST /sso/cli-connect answered $connect_status: $(jq -c '.error // .' "$SCRATCH/connect.json")"
CLI_KEY=$(jq -r '.key' "$SCRATCH/connect.json")
CLI_KEY_ID=$(jq -r '.apiKey.id' "$SCRATCH/connect.json")
case "$CLI_KEY" in ytk_*) ;; *) fail "the connect minted no ytk_ key" ;; esac
jq -e --arg e "$OWNER_EMAIL" --arg u "$SL_USER_ID" \
  '.user.email == $e and .user.id == $u and .apiKey.workspaceId == null and .workspaceId == null and (.apiKey.scopes | sort) == ["items:read", "items:write"]' \
  "$SCRATCH/connect.json" >/dev/null || fail "the connect's key is not the SAME user's unpinned items key: $(jq -c '{user, apiKey}' "$SCRATCH/connect.json")"
pass "POST /sso/cli-connect → 201: a user-scoped ytk_ key (no workspace pin; items:read + items:write, never data:export) for the same local user as the browser login"
audit_via=$(sldb "SELECT metadata->>'via' || ' ' || (metadata->>'grantChannel') FROM audit_log WHERE action = 'apikey.create' AND resource_id = '$CLI_KEY_ID'")
[ "$audit_via" = "sso_cli_connect h3_exchange" ] || fail "the connect's apikey.create audit row reads '$audit_via'"
pass "the tool's audit log: apikey.create via sso_cli_connect, grant channel h3_exchange"

replay_status=$("${CURL[@]}" -o "$SCRATCH/replay.json" -w '%{http_code}' -X POST "$SL/api/v1/sso/cli-connect" \
  -H 'content-type: application/json' -d @"$SCRATCH/connect-body.json")
[ "$replay_status" = 401 ] && jq -e '.error.code == "invalid_token" and (has("key") | not)' "$SCRATCH/replay.json" >/dev/null \
  || fail "the replayed exchange token answered $replay_status: $(cat "$SCRATCH/replay.json")"
[ "$(sldb "SELECT count(*) FROM api_keys WHERE created_by = '$SL_USER_ID' AND name LIKE 'Antasphere CLI %'")" = 1 ] || fail "the replay minted a second CLI key"
pass "the same exchange token a second time → 401 invalid_token, no second key (the jti is one-time-use)"

# The key works in the workspace the request names, on the tool's resource.
cli_read=$("${CURL[@]}" -o "$SCRATCH/cli-items.json" -w '%{http_code}' -H "Authorization: Bearer $CLI_KEY" -H "X-Workspace-Id: $WS_ID" "$SL/api/v1/items")
[ "$cli_read" = 200 ] && jq -e --arg id "$ITEM_ID" '[.items[].id] == [$id] and .items[0].note == "patched by the ytk_ key"' "$SCRATCH/cli-items.json" >/dev/null \
  || fail "GET /items with the CLI key answered $cli_read: $(cat "$SCRATCH/cli-items.json")"
cli_write=$("${CURL[@]}" -o "$SCRATCH/cli-item.json" -w '%{http_code}' -X POST "$SL/api/v1/items" \
  -H "Authorization: Bearer $CLI_KEY" -H "X-Workspace-Id: $WS_ID" -H 'content-type: application/json' -d '{"name":"CLI item"}')
[ "$cli_write" = 201 ] || fail "POST /items with the CLI key answered $cli_write: $(cat "$SCRATCH/cli-item.json")"
cli_export=$("${CURL[@]}" -o "$SCRATCH/cli-export.json" -w '%{http_code}' -H "Authorization: Bearer $CLI_KEY" -H "X-Workspace-Id: $WS_ID" "$SL/api/v1/members")
[ "$cli_export" = 403 ] || fail "GET /members with the CLI key answered $cli_export (expected 403: outside the key's scopes' allowlist)"
pass "the CLI key reads the session's item in $WS_ID (X-Workspace-Id), creates one, and is refused outside /items (GET /members → 403 $(jq -r '.error.code' "$SCRATCH/cli-export.json"))"

# The connect stored the exchange's offline grant on the account row: the
# browser session Phase 5 left dead is healed without a browser.
healed=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/healed.json" -w '%{http_code}' "$SL/api/v1/me")
[ "$healed" = 200 ] && jq -e --arg e "$OWNER_EMAIL" '.user.email == $e' "$SCRATCH/healed.json" >/dev/null \
  || fail "the browser session after the connect answered $healed: $(cat "$SCRATCH/healed.json")"
read -r fam_total fam_live _ <<<"$(family "$SL_CLIENT_ID" "$HUB_USER_ID")"
note "hub rows for ($SL_CLIENT_ID, user) after the connect: total=$fam_total live=$fam_live, of which offline family=$(offline_family "$SL_CLIENT_ID" "$HUB_USER_ID")"
pass "the connect's grant replaced the dead one: the browser session answers 200 again"

# ── Phase 8b — the billing rail, phases 1 to 3 ───────────────────────────────
say "Phase 8b — the billing rail: one metered item per surface lands at the hub exactly once"
# The legs before this one metered items already (Phase 3c: one create by the
# session; Phase 8: one by the CLI key) and their events may still be in
# flight: every baseline below is taken on a drained queue, and every figure
# is a DELTA over it.
drain_usage() { # label → waits up to 60 s for the usage queue to empty
  local i pending=0
  for i in $(seq 1 60); do
    pending=$(sldb "SELECT count(*) FROM pgboss.job WHERE name = 'usage-events' AND state NOT IN ('completed', 'failed', 'cancelled')")
    [ "$pending" = 0 ] && return 0
    sleep 1
  done
  fail "the usage queue did not drain in 60 s $1 ($pending pending); is the poster reaching the hub?"
}
hub_events() { hubdb "SELECT count(*) FROM usage_events"; }
item_create() { # label name curl-auth-args → POST /items in the drill workspace; prints the status, the body in $SCRATCH/bill-item-<label>.json
  local label=$1 name=$2; shift 2
  "${CURL[@]}" "$@" -o "$SCRATCH/bill-item-$label.json" -w '%{http_code}' -X POST "$SL/api/v1/items" \
    -H "X-Workspace-Id: $WS_ID" -H 'content-type: application/json' -d "{\"name\":\"$name\"}"
}
file_upload() { # label bytes → POST /files by the session with a body of that many bytes; prints the status, the body in $SCRATCH/bill-file-<label>.json
  local label=$1 bytes=$2
  head -c "$bytes" /dev/zero | tr '\0' 'x' >"$SCRATCH/bill-file-$label.txt"
  "${CURL[@]}" -b "$SL_JAR" -H "Origin: $SL" -o "$SCRATCH/bill-file-$label.json" -w '%{http_code}' -X POST \
    "$SL/api/v1/files?name=drill-$label.txt" -H "X-Workspace-Id: $WS_ID" -H 'content-type: text/plain' \
    --data-binary @"$SCRATCH/bill-file-$label.txt"
}
mcp_create() { # id name → the MCP tool create_item with the OAuth bearer; prints the JSON-RPC answer
  local call
  call=$(jq -nc --arg ws "$WS_ID" --arg name "$2" --argjson id "$1" \
    '{jsonrpc:"2.0",id:$id,method:"tools/call",params:{name:"starter_create_item",arguments:{workspace:$ws,name:$name}}}')
  "${CURL[@]}" -X POST "$SL/mcp" -H "Authorization: Bearer $MCP_BEARER" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' -d "$call"
}

drain_usage "before the first leg's baseline"
jobs_before=$(sldb "SELECT count(*) FROM pgboss.job WHERE name = 'usage-events'")
before_rows=$(hub_events)
leg_start=$(sldb "SELECT now()")

# 1. the dashboard: the browser session.
status=$(item_create session "Drill billing item (session)" -b "$SL_JAR" -H "Origin: $SL")
[ "$status" = 201 ] || fail "POST /items by the session answered $status: $(cat "$SCRATCH/bill-item-session.json")"
# 2. the CLI's credential: the ytk_ key Phase 3b minted in the drill workspace.
status=$(item_create api_key "Drill billing item (key)" -H "Authorization: Bearer $MINTED_KEY")
[ "$status" = 201 ] || fail "POST /items with the ytk_ key answered $status: $(cat "$SCRATCH/bill-item-api_key.json")"
# 3. an agent: an OAuth bearer from the tool's OWN authorization server
#    (dynamic registration + PKCE + consent, the MCP connector's dance), then
#    the MCP endpoint itself creates an item.
mcp_redirect='http://127.0.0.1:19999/callback'
register=$("${CURL[@]}" -X POST "$SL/api/v1/auth/oauth2/register" -H 'content-type: application/json' \
  -d "{\"client_name\":\"drill-mcp\",\"redirect_uris\":[\"$mcp_redirect\"],\"token_endpoint_auth_method\":\"none\",\"grant_types\":[\"authorization_code\",\"refresh_token\"],\"response_types\":[\"code\"]}")
MCP_CLIENT=$(echo "$register" | jq -r '.client_id // empty')
[ -n "$MCP_CLIENT" ] || fail "dynamic registration at Hackathon Starter failed: $register"
mcp_verifier=$(openssl rand -hex 32)
mcp_challenge=$(printf '%s' "$mcp_verifier" | openssl dgst -sha256 -binary | b64url)
mcp_scope=$("${CURL[@]}" "$SL/.well-known/oauth-authorization-server" | jq -r '.scopes_supported | join(" ")')
mcp_authz="$SL/api/v1/auth/oauth2/authorize?response_type=code&client_id=$MCP_CLIENT&redirect_uri=$(printf '%s' "$mcp_redirect" | jq -sRr @uri)&scope=$(printf '%s' "$mcp_scope" | jq -sRr @uri)&state=drill-mcp&code_challenge=$mcp_challenge&code_challenge_method=S256&resource=$(printf '%s' "$SL/mcp" | jq -sRr @uri)"
consent_url=$("${CURL[@]}" -b "$SL_JAR" -o /dev/null -w '%{redirect_url}' "$mcp_authz")
case "$consent_url" in
  *"/oauth/consent?"*)
    consent=$("${CURL[@]}" -b "$SL_JAR" -X POST "$SL/api/v1/auth/oauth2/consent" -H 'content-type: application/json' -H "Origin: $SL" \
      -d "{\"accept\":true,\"oauth_query\":\"${consent_url#*consent?}\"}")
    code_url=$(echo "$consent" | jq -r '.url // .redirect_uri // empty') ;;
  *) code_url=$consent_url ;;
esac
mcp_code=$(printf '%s' "$code_url" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
[ -n "$mcp_code" ] || fail "no authorization code for the MCP client: $consent_url"
"${CURL[@]}" -o "$SCRATCH/mcp-token.json" -f -X POST "$SL/api/v1/auth/oauth2/token" -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=authorization_code --data-urlencode "code=$mcp_code" --data-urlencode "redirect_uri=$mcp_redirect" \
  --data-urlencode "client_id=$MCP_CLIENT" --data-urlencode "code_verifier=$mcp_verifier" --data-urlencode "resource=$SL/mcp" \
  || fail "the MCP client's token exchange failed"
MCP_BEARER=$(jq -r '.access_token' "$SCRATCH/mcp-token.json")
mcp_answer=$(mcp_create 1 "Drill MCP item")
MCP_ITEM=$(echo "$mcp_answer" | jq -r 'if .result.isError == true then empty else (.result.content[0].text | fromjson | .item.id // empty) end' 2>/dev/null || true)
[ -n "$MCP_ITEM" ] || fail "the MCP item creation failed: $(echo "$mcp_answer" | head -c 400)"
# The per-call action's allowed check is now cached for 30 s: the refusals of
# the second leg must wait until it has turned over.
LEG1_LAST_CREATE=$(date +%s)
# 4. the chassis's upload route, priced by the tool in bytes: one file by the session.
status=$(file_upload billing 64)
[ "$status" = 201 ] || fail "POST /files by the session answered $status: $(cat "$SCRATCH/bill-file-billing.json")"
SESSION_BYTES=$(jq -r '.file.sizeBytes' "$SCRATCH/bill-file-billing.json")
pass "one metered action per surface: POST /items by the dashboard session, the ytk_ key and an OAuth bearer over MCP ($MCP_ITEM), plus one upload by the session ($SESSION_BYTES bytes)"

jobs_after=$(sldb "SELECT count(*) FROM pgboss.job WHERE name = 'usage-events'")
[ "$((jobs_after - jobs_before))" = 4 ] || fail "expected exactly 4 new usage jobs (3 creates + 1 upload), the queue grew by $((jobs_after - jobs_before))"
drain_usage "after the first leg's actions"
failed=$(sldb "SELECT count(*) FROM pgboss.job WHERE name = 'usage-events' AND state = 'failed'")
[ "$failed" = 0 ] || fail "$failed usage job(s) FAILED at the poster: $(applogs app | grep -i 'usage poster' | tail -3)"
pass "the poster drained the queue to the hub (4 new events, none failed)"

landed=$(hub_events)
[ "$landed" = "$((before_rows + 4))" ] \
  || fail "the hub holds $landed events, expected $((before_rows + 4)); the poster's log: $(applogs app | grep -i 'usage poster' | tail -3 | cut -c1-300); the hub's: $(hubdb "SELECT metadata::text FROM audit_log WHERE action = 'usage.ingest' ORDER BY created_at DESC LIMIT 2")"
LEG_IDS=$(sldb "SELECT string_agg(quote_literal(data->>'id'), ',') FROM pgboss.job WHERE name = 'usage-events' AND created_on >= '$leg_start'")
[ -n "$LEG_IDS" ] || fail "no usage job of this leg in the queue"
TOOL_SLUG=$(hubdb "SELECT metadata->'tool'->>'slug' FROM oauth_client WHERE client_id = '$SL_CLIENT_ID'")
row() { hubdb "SELECT count(*) FROM usage_events WHERE id IN ($LEG_IDS) AND via = '$1' AND action_key = '$2' AND quantity = $3 AND user_id = '$HUB_USER_ID' AND tool_slug = '$TOOL_SLUG' AND workspace_id = '$WS_ID'"; }
[ "$(row session items.create 1)" = 1 ] || fail "no session row for items.create by $HUB_USER_ID"
[ "$(row api_key items.create 1)" = 1 ] || fail "no api_key row for items.create by $HUB_USER_ID"
[ "$(row oauth items.create 1)" = 1 ] || fail "no oauth row for items.create by $HUB_USER_ID"
[ "$(row session files.upload "$SESSION_BYTES")" = 1 ] || fail "no session row for files.upload of $SESSION_BYTES bytes by $HUB_USER_ID"
pass "usage_events: items.create 1 call via session / api_key / oauth + files.upload $SESSION_BYTES bytes via session, user $HUB_USER_ID, workspace $WS_ID, the registry slug $TOOL_SLUG"

# At-least-once from the tool, exactly once at the hub: every event the tool
# ever queued, posted again by hand with its own machine token, answers duplicate.
machine=$("${CURL[@]}" -o "$SCRATCH/machine.json" -w '%{http_code}' -X POST "$HUB/api/v1/auth/oauth2/token" \
  -u "$SL_CLIENT_ID:$SL_CLIENT_SECRET" -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=client_credentials --data-urlencode scope=usage:write --data-urlencode "resource=$HUB/mcp")
[ "$machine" = 200 ] || fail "the tool's client_credentials mint answered $machine: $(cat "$SCRATCH/machine.json")"
MACHINE_TOKEN=$(jq -r '.access_token' "$SCRATCH/machine.json")
sldb "SELECT json_agg(data)::text FROM pgboss.job WHERE name = 'usage-events'" | jq '{events: .}' >"$SCRATCH/replay-events.json"
all_jobs=$(jq -r '.events | length' "$SCRATCH/replay-events.json")
"${CURL[@]}" -o "$SCRATCH/replay-answer.json" -f -X POST "$HUB/api/v1/usage/events" -H "Authorization: Bearer $MACHINE_TOKEN" \
  -H 'content-type: application/json' -d @"$SCRATCH/replay-events.json" || fail "the hand replay of the batch failed: $(cat "$SCRATCH/replay-answer.json")"
jq -e --argjson n "$all_jobs" '.duplicate == $n and .accepted == 0 and .rejected == 0' "$SCRATCH/replay-answer.json" >/dev/null \
  || fail "the replay should answer duplicate for all $all_jobs: $(cat "$SCRATCH/replay-answer.json")"
[ "$(hub_events)" = "$landed" ] || fail "the replay wrote rows"
pass "every queued event posted again with the tool's machine token: $all_jobs duplicate, 0 accepted, no new row"

# The organization's owner reads the consumption per person.
org_events=$(hubdb "SELECT count(*) FROM usage_events WHERE account_id = (SELECT central_account_id FROM workspaces WHERE id = '$HUB_ORG_ID')")
usage=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/billing-usage.json" -w '%{http_code}' -H "X-Workspace-Id: $HUB_ORG_ID" "$HUB/api/v1/billing/usage")
[ "$usage" = 200 ] || fail "GET /billing/usage as the owner answered $usage: $(cat "$SCRATCH/billing-usage.json")"
jq -e --arg u "$HUB_USER_ID" --argjson n "$org_events" '.byUser | length == 1 and .[0].userId == $u and .[0].events == $n' "$SCRATCH/billing-usage.json" >/dev/null \
  || fail "the per-person view does not show $org_events events for $HUB_USER_ID: $(jq -c '.byUser' "$SCRATCH/billing-usage.json")"
pass "GET /billing/usage as the owner: one person, $HUB_USER_ID, $org_events events (the hub's count for the organization's account)"

# ── Phase 8b, second leg — the billing rail, phase 2 ──
say "Phase 8b — phase 2: the hub prices, the chassis asks before an action and refuses on the balance, the debit lands"
SL_METRICS_TOKEN=federation-dev-metrics-token-0001 # the drill overlay's
idem() { printf 'Idempotency-Key: drill-%s' "$(openssl rand -hex 8)"; }
metrics() { "${CURL[@]}" -f -H "Authorization: Bearer $SL_METRICS_TOKEN" "$SL/metrics"; }

# Staff seeds the price book and the plan entitlements from the tool's own
# discovery. The hub owner is on SUPERADMIN_EMAILS in the drill overlay, and
# the price book was EMPTY until now, as on production (BILLING_SEED_TOOLS_AT_BOOT
# off): the first leg's events were priced 0 and debited nothing.
seed_status=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/seed.json" -w '%{http_code}' -X POST "$HUB/api/v1/admin/billing/prices/seed" \
  -H "Origin: $HUB" -H "$(idem)" -H 'content-type: application/json' -d '{"toolSlug":"starter-cloud"}')
if [ "$seed_status" = 404 ]; then
  # A hub without phase 2 has no price book: the chassis fails open on its 404
  # and meters as phase 1 did. The legs need a hub with the price book; the
  # hub deploys first, and this run says so.
  note "the hub answers 404 on POST /admin/billing/prices/seed: no price book on this hub — the second and third legs are skipped"
  pass "second and third legs skipped: this hub carries no price book (deploy a hub with the billing rail's phase 2 first)"
else
[ "$seed_status" = 200 ] || fail "POST /admin/billing/prices/seed as the hub owner (staff) answered $seed_status: $(cat "$SCRATCH/seed.json")"
jq -e '.tools[] | select(.toolSlug == "starter-cloud") | .ok == true' "$SCRATCH/seed.json" >/dev/null \
  || fail "the seed did not read the tool's discovery: $(cat "$SCRATCH/seed.json")"
prices_status=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/prices.json" -w '%{http_code}' "$HUB/api/v1/admin/billing/prices?toolSlug=starter-cloud")
[ "$prices_status" = 200 ] || fail "GET /admin/billing/prices answered $prices_status: $(cat "$SCRATCH/prices.json")"
jq -e '[.prices[] | select(.actionKey == "items.create")] | length == 1 and .[0].creditsPerUnit == 1 and ((.[0].per // 1) == 1)' "$SCRATCH/prices.json" >/dev/null \
  || fail "the price book does not carry items.create at 1 credit per call: $(jq -c '.prices' "$SCRATCH/prices.json")"
jq -e '[.prices[] | select(.actionKey == "files.upload")] | length == 1 and .[0].creditsPerUnit == 5 and .[0].per == 1048576' "$SCRATCH/prices.json" >/dev/null \
  || fail "the price book does not carry files.upload at 5 credits per 1,048,576 bytes: $(jq -c '.prices' "$SCRATCH/prices.json")"
n_prices=$(jq -r '.prices | length' "$SCRATCH/prices.json")
[ "$n_prices" = 2 ] || fail "expected exactly the two declared prices, the book holds $n_prices"
seed2=$("${CURL[@]}" -b "$HUB_JAR" -X POST "$HUB/api/v1/admin/billing/prices/seed" -H "Origin: $HUB" -H "$(idem)" \
  -H 'content-type: application/json' -d '{"toolSlug":"starter-cloud"}')
echo "$seed2" | jq -e '.inserted == 0' >/dev/null || fail "a second seed inserted rows: $seed2"
pass "staff seeded the price book from the tool's discovery ($n_prices prices; items.create 1 credit per call, files.upload 5 credits per 1,048,576 bytes); a second seed inserted nothing"

# The organization's account holds the sign-up grant.
acct=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/account.json" -w '%{http_code}' -H "X-Workspace-Id: $HUB_ORG_ID" "$HUB/api/v1/billing/account")
[ "$acct" = 200 ] || fail "GET /billing/account as the owner answered $acct: $(cat "$SCRATCH/account.json")"
ACCOUNT_ID=$(jq -r '.accountId // empty' "$SCRATCH/account.json")
[ -n "$ACCOUNT_ID" ] && jq -e '.balance == 5000 and .plan == "free"' "$SCRATCH/account.json" >/dev/null \
  || fail "the account should hold the 5,000 sign-up grant on the free plan: $(cat "$SCRATCH/account.json")"
pass "GET /billing/account: account $ACCOUNT_ID, balance 5000 (the sign-up grant), plan free"

# The check by hand, with the tool's machine token: priced, allowed, the top-up link on the answer.
check=$("${CURL[@]}" -o "$SCRATCH/check.json" -w '%{http_code}' -X POST "$HUB/api/v1/usage/check" -H "Authorization: Bearer $MACHINE_TOKEN" \
  -H 'content-type: application/json' -d "{\"accountRef\":\"$HUB_ORG_ID\",\"actionKey\":\"items.create\",\"quantity\":1}")
[ "$check" = 200 ] || fail "POST /usage/check answered $check: $(cat "$SCRATCH/check.json")"
jq -e --arg top "$HUB/billing/top-up?org=$HUB_ORG_ID" \
  '.allowed == true and .credits == 1 and .balance == 5000 and .priced == true and .reason == null and (.topUpUrl | startswith($top))' "$SCRATCH/check.json" >/dev/null \
  || fail "the check's answer is not the contract's: $(cat "$SCRATCH/check.json")"
pass "POST /usage/check with the machine token: one item create is 1 credit, allowed, balance 5000, the top-up link names the organization"

# Staff drives the balance to zero: a negative manual grant, the reason on the ledger.
grant=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/grant.json" -w '%{http_code}' -X POST "$HUB/api/v1/admin/billing/accounts/$ACCOUNT_ID/grant" \
  -H "Origin: $HUB" -H "$(idem)" -H 'content-type: application/json' -d '{"credits":-5000,"reason":"drill: exhaust the balance"}')
[ "$grant" = 201 ] && jq -e '.balance == 0' "$SCRATCH/grant.json" >/dev/null || fail "the negative grant answered $grant: $(cat "$SCRATCH/grant.json")"
pass "staff grant of -5000 with a reason: balance 0"

# One create per surface refused 402 with the top-up link. The chassis caches
# an ALLOWED answer for 30 s and serves it to any smaller or equal quantity of
# the same action, and a per-call action always asks for 1: the first leg's
# allowed answer must have turned over before the refusals are asked.
hold=$((LEG1_LAST_CREATE + 32 - $(date +%s)))
if [ "$hold" -gt 0 ]; then
  note "waiting ${hold} s for the first leg's allowed items.create answer to leave the check's cache"
  sleep "$hold"
fi
refused() { # label → asserts 402 entitlement_denied with the details on $SCRATCH/bill-item-<label>.json
  jq -e --arg top "$HUB/billing/top-up?org=$HUB_ORG_ID" \
    '.error.code == "entitlement_denied" and .error.details.credits == 1 and .error.details.balance == 0 and (.error.details.topUpUrl | startswith($top))' \
    "$SCRATCH/bill-item-$1.json" >/dev/null || fail "the 402 ($1) does not carry the details: $(cat "$SCRATCH/bill-item-$1.json")"
}
status=$(item_create refused-session "Drill refused item" -b "$SL_JAR" -H "Origin: $SL")
[ "$status" = 402 ] || fail "POST /items (session) with an empty balance answered $status, expected 402: $(cat "$SCRATCH/bill-item-refused-session.json")"
refused refused-session
status=$(item_create refused-key "Drill refused item" -H "Authorization: Bearer $MINTED_KEY")
[ "$status" = 402 ] || fail "POST /items (ytk_ key) with an empty balance answered $status, expected 402: $(cat "$SCRATCH/bill-item-refused-key.json")"
refused refused-key
mcp_refused=$(mcp_create 2 "Drill refused item")
# The gate's own message carries the link ("top up at <url>"), exactly once.
echo "$mcp_refused" | jq -e --arg top "top up at $HUB/billing/top-up?org=$HUB_ORG_ID" \
  '.result.isError == true and (.result.content[0].text | (test("entitlement_denied") and contains($top)))' >/dev/null \
  || fail "the MCP tool result does not carry the refusal and the top-up link: $(echo "$mcp_refused" | head -c 500)"
pass "with the balance at 0, POST /items answers 402 entitlement_denied (1 credit, balance 0) with the top-up link on every surface: the dashboard session, the ytk_ key, the MCP tool's text"
before_refused=$(hub_events)

# The balance restored: a denial is cached five seconds, so a create lands
# after the hold, the hub prices it, and its debit is on the ledger.
grant=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/grant2.json" -w '%{http_code}' -X POST "$HUB/api/v1/admin/billing/accounts/$ACCOUNT_ID/grant" \
  -H "Origin: $HUB" -H "$(idem)" -H 'content-type: application/json' -d '{"credits":5000,"reason":"drill: restore the balance"}')
[ "$grant" = 201 ] && jq -e '.balance == 5000' "$SCRATCH/grant2.json" >/dev/null || fail "the restoring grant answered $grant: $(cat "$SCRATCH/grant2.json")"
sleep 6
status=$(item_create landed "Drill billing item (landed)" -b "$SL_JAR" -H "Origin: $SL")
[ "$status" = 201 ] || fail "POST /items (session) after the restoring grant answered $status: $(cat "$SCRATCH/bill-item-landed.json")"
drain_usage "after the restored create"
LANDED_EVENT=$(sldb "SELECT data->>'id' FROM pgboss.job WHERE name = 'usage-events' AND data->>'actionKey' = 'items.create' AND data->>'via' = 'session' ORDER BY created_on DESC LIMIT 1")
[ -n "$LANDED_EVENT" ] || fail "no queued items.create event via session"
[ "$(hub_events)" = "$((before_refused + 1))" ] \
  || fail "the refused creates must write no event and the landed one exactly one (before $before_refused, now $(hub_events))"
[ "$(hubdb "SELECT credits FROM usage_events WHERE id = '$LANDED_EVENT'")" = 1 ] || fail "the landed event was not priced 1 credit at the hub"
ledger=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/ledger.json" -w '%{http_code}' -H "X-Workspace-Id: $HUB_ORG_ID" "$HUB/api/v1/billing/ledger?kind=debit")
[ "$ledger" = 200 ] || fail "GET /billing/ledger answered $ledger: $(cat "$SCRATCH/ledger.json")"
jq -e --arg id "$LANDED_EVENT" '[.entries[] | select(.sourceRef == $id)] | length == 1 and .[0].amount == -1 and .[0].kind == "debit"' "$SCRATCH/ledger.json" >/dev/null \
  || fail "the ledger holds no debit of 1 for event $LANDED_EVENT: $(jq -c '.entries' "$SCRATCH/ledger.json")"
"${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/account2.json" -f -H "X-Workspace-Id: $HUB_ORG_ID" "$HUB/api/v1/billing/account" || fail "GET /billing/account failed after the debit"
jq -e '.balance == 4999' "$SCRATCH/account2.json" >/dev/null || fail "the balance should read 4999 after one 1-credit debit: $(cat "$SCRATCH/account2.json")"
pass "balance restored: a create by the session lands (event $LANDED_EVENT), priced 1 credit at the hub, its debit on GET /billing/ledger, the balance 4999; the refusals wrote nothing"

# The hub slow beyond the check's budget: the action still lands (fail-open),
# the posture reads 1 on /metrics, and a check the hub answers heals it. On
# UPLOADS: an allowed answer is cached 30 s for any smaller or equal quantity
# and a create always asks for 1, so only a LARGER upload asks the hub again.
"${CURL[@]}" -f -o /dev/null -X POST "$HOP/latency" -H 'content-type: application/json' -d '{"ms":7000}' || fail "could not set the hop's latency"
status=$(file_upload slow 3072)
"${CURL[@]}" -f -o /dev/null -X DELETE "$HOP/latency" || fail "could not clear the hop's latency"
[ "$status" = 201 ] || fail "the upload with the hub slow answered $status, expected 201 (fail-open): $(cat "$SCRATCH/bill-file-slow.json")"
metrics | grep -q '^usage_check_posture 1' || fail "usage_check_posture should read 1 (failing open) after a check the hub did not answer in time: $(metrics | grep usage_check)"
metrics | grep -Eq '^usage_check_total\{outcome="fail_open"\} [1-9]' || fail "no fail_open outcome counted: $(metrics | grep usage_check_total)"
# The check leaves the hub alone for five seconds after a failed call, so the
# healing check is asked once the hold has passed.
sleep 6
status=$(file_upload healed 3073)
[ "$status" = 201 ] || fail "the upload after the hub healed answered $status: $(cat "$SCRATCH/bill-file-healed.json")"
metrics | grep -q '^usage_check_posture 0' || fail "usage_check_posture should read 0 once the hub answers again: $(metrics | grep usage_check_posture)"
pass "hub slow beyond the check's budget: the upload (3072 bytes) still lands, usage_check_posture 1 and a fail_open outcome on /metrics; the next answered check (3073 bytes) heals it to 0"

# ── Phase 8b, third leg — the billing rail, phase 3: free is limited ──
say "Phase 8b — phase 3: the free workspace is refused what pro unlocks, at the tool's door and at the hub's"
# The plan entitlements were seeded from the tool's discovery with the price
# book above (items.perWorkspace 100 and workspace.members 3 on free), so the
# Drill Workspace is a free workspace with every limit declared. Fill it to the cap.
drain_usage "before the third leg"
cap_status=0
for n in $(seq 1 120); do
  cap_status=$(item_create cap "Drill cap item $n" -H "Authorization: Bearer $MINTED_KEY")
  [ "$cap_status" = 403 ] && break
  [ "$cap_status" = 201 ] || fail "filling the workspace: POST /items #$n answered $cap_status: $(cat "$SCRATCH/bill-item-cap.json")"
done
[ "$cap_status" = 403 ] || fail "120 creates and the free cap never refused one"
cap_count=$(sldb "SELECT count(*) FROM items WHERE workspace_id = '$WS_ID'")
[ "$cap_count" = 100 ] || fail "the cap refused at $cap_count items in the workspace, expected 100"
pass "the drill workspace filled to the free cap: the create after the 100th item answers 403 ($((n - 1)) creates by the ytk_ key)"
drain_usage "after filling the workspace"
before_cap=$(hub_events)
refusal_start=$(sldb "SELECT now()")

plan_refused() { # file key → asserts a 403 plan_required body on the key, free → pro, with the hub's upgrade page carrying both
  local file=$1 key=$2
  jq -e --arg key "$key" --arg up "$HUB/billing/upgrade?org=$HUB_ORG_ID" \
    '.error.code == "plan_required" and .error.details.key == $key and .error.details.plan == "free" and .error.details.requiredPlan == "pro"
     and (.error.details.upgradeUrl | startswith($up)) and (.error.details.upgradeUrl | contains("key=" + $key)) and (.error.details.upgradeUrl | contains("requiredPlan=pro"))' \
    "$file" >/dev/null || fail "not a 403 plan_required on $key with the upgrade link: $(cat "$file")"
}
status=$(item_create capped-session "Drill capped item" -b "$SL_JAR" -H "Origin: $SL")
[ "$status" = 403 ] || fail "POST /items at the cap (session) answered $status, expected 403: $(cat "$SCRATCH/bill-item-capped-session.json")"
plan_refused "$SCRATCH/bill-item-capped-session.json" items.perWorkspace
status=$(item_create capped-key "Drill capped item" -H "Authorization: Bearer $MINTED_KEY")
[ "$status" = 403 ] || fail "POST /items at the cap (ytk_ key) answered $status, expected 403: $(cat "$SCRATCH/bill-item-capped-key.json")"
plan_refused "$SCRATCH/bill-item-capped-key.json" items.perWorkspace
mcp_capped=$(mcp_create 3 "Drill capped item")
echo "$mcp_capped" | jq -e --arg up "Upgrade: $HUB/billing/upgrade?org=$HUB_ORG_ID" \
  '.result.isError == true and (.result.content[0].text | (test("plan_required") and contains($up) and contains("key=items.perWorkspace")))' >/dev/null \
  || fail "the MCP tool result does not carry the plan refusal and the upgrade link: $(echo "$mcp_capped" | head -c 500)"
# The plan answers before the credit check and before the handler: no event is queued, none lands.
[ "$(sldb "SELECT count(*) FROM pgboss.job WHERE name = 'usage-events' AND data->>'actionKey' = 'items.create' AND created_on >= '$refusal_start'")" = 0 ] \
  || fail "a refused create at the cap queued an items.create event"
[ "$(hub_events)" = "$before_cap" ] || fail "the three refusals wrote usage_events at the hub (before $before_cap, now $(hub_events))"
pass "a create at the free cap: 403 plan_required (items.perWorkspace, free → pro) with the hub's upgrade page on the dashboard session, the ytk_ key and the MCP tool's text; nothing queued, nothing landed"

# The hub's own door: the member cap on the Drill Workspace (one member, Drill Owner).
hub_invite() { # email label → POST /invitations at the hub as the owner; prints the status, the body in $SCRATCH/hub-invite-<label>.json
  local email=$1 label=$2
  "${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/hub-invite-$label.json" -w '%{http_code}' -X POST "$HUB/api/v1/invitations" \
    -H "Origin: $HUB" -H "X-Workspace-Id: $HUB_ORG_ID" -H "$(idem)" -H 'content-type: application/json' -d "{\"email\":\"$email\",\"role\":\"member\"}"
}
status=$(hub_invite drill-m2@drill.test m2); [ "$status" = 201 ] || fail "the second seat's invitation answered $status: $(cat "$SCRATCH/hub-invite-m2.json")"
status=$(hub_invite drill-m3@drill.test m3); [ "$status" = 201 ] || fail "the third seat's invitation answered $status: $(cat "$SCRATCH/hub-invite-m3.json")"
status=$(hub_invite drill-m4@drill.test m4); [ "$status" = 403 ] || fail "the fourth seat's invitation answered $status, expected 403: $(cat "$SCRATCH/hub-invite-m4.json")"
plan_refused "$SCRATCH/hub-invite-m4.json" workspace.members
jq -e '.error.details.upgradeUrl | contains("tool=starter-cloud")' "$SCRATCH/hub-invite-m4.json" >/dev/null \
  || fail "the hub's upgrade page does not name the tool whose cap bound the account: $(cat "$SCRATCH/hub-invite-m4.json")"
pass "at the hub, the second and third invitations are accepted (201) and the fourth answers 403 plan_required (workspace.members, free → pro) with the upgrade page naming starter-cloud"

# Staff lifts the account above free: overrides of both caps to unlimited,
# the way an enterprise deal is served.
override() { # body → PUT /admin/billing/entitlements as staff; prints the row id
  local body=$1
  local st
  st=$("${CURL[@]}" -b "$HUB_JAR" -o "$SCRATCH/override.json" -w '%{http_code}' -X PUT "$HUB/api/v1/admin/billing/entitlements" \
    -H "Origin: $HUB" -H "$(idem)" -H 'content-type: application/json' -d "$body")
  [ "$st" = 201 ] || fail "PUT /admin/billing/entitlements answered $st: $(cat "$SCRATCH/override.json")"
  jq -r '.id' "$SCRATCH/override.json"
}
ITEMS_OVERRIDE=$(override "{\"toolSlug\":\"starter-cloud\",\"accountId\":\"$ACCOUNT_ID\",\"key\":\"items.perWorkspace\",\"kind\":\"limit\",\"value\":null}")
CAP_OVERRIDE=$(override "{\"toolSlug\":\"starter-cloud\",\"accountId\":\"$ACCOUNT_ID\",\"key\":\"workspace.members\",\"kind\":\"limit\",\"value\":null}")
status=$(hub_invite drill-m4@drill.test m4b); [ "$status" = 201 ] || fail "with the cap lifted, the fourth seat's invitation answered $status: $(cat "$SCRATCH/hub-invite-m4b.json")"
pass "staff override of workspace.members to unlimited for the account: the fourth invitation passes at the hub"
# The tool serves an account's plan from a thirty-second cache and refreshes
# it behind the request once stale, so the lifted account is felt on the
# create after the window; every refused attempt costs nothing (the plan
# answers before the credit check), the one that lands costs 1 credit.
status=0
for i in $(seq 1 20); do
  status=$(item_create lifted "Drill lifted item" -b "$SL_JAR" -H "Origin: $SL")
  [ "$status" = 201 ] && break
  [ "$status" = 403 ] || fail "the create on the lifted account answered $status: $(cat "$SCRATCH/bill-item-lifted.json")"
  sleep 3
done
[ "$status" = 201 ] || fail "the create still answers 403 a minute after the override: $(cat "$SCRATCH/bill-item-lifted.json")"
drain_usage "after the lifted create"
LIFTED_EVENT=$(sldb "SELECT data->>'id' FROM pgboss.job WHERE name = 'usage-events' AND data->>'actionKey' = 'items.create' ORDER BY created_on DESC LIMIT 1")
[ -n "$LIFTED_EVENT" ] || fail "no queued items.create event for the lifted create"
[ "$(hub_events)" = "$((before_cap + 1))" ] \
  || fail "the lifted create must land exactly one event (before $before_cap, now $(hub_events))"
[ "$(hubdb "SELECT credits FROM usage_events WHERE id = '$LIFTED_EVENT'")" = 1 ] || fail "the lifted create was not priced 1 credit at the hub"
pass "the account lifted by staff creates its 101st item on the tool (201) once its plan cache has turned over; one event landed for it (priced 1), none for the refusals"
# The overrides removed: the account is back on free (what it already holds stays).
for id in "$ITEMS_OVERRIDE" "$CAP_OVERRIDE"; do
  "${CURL[@]}" -b "$HUB_JAR" -o /dev/null -f -X DELETE "$HUB/api/v1/admin/billing/entitlements/$id" -H "Origin: $HUB" -H "$(idem)" \
    || fail "DELETE /admin/billing/entitlements/$id failed"
done
# Felt again once the plan cache turns over: the create at the cap is refused as before.
status=0
for i in $(seq 1 20); do
  status=$(item_create relocked "Drill relocked item" -b "$SL_JAR" -H "Origin: $SL")
  [ "$status" = 403 ] && break
  [ "$status" = 201 ] || fail "the create after the overrides were removed answered $status: $(cat "$SCRATCH/bill-item-relocked.json")"
  sleep 3
done
[ "$status" = 403 ] || fail "a minute after the overrides were removed the create at the cap still lands"
plan_refused "$SCRATCH/bill-item-relocked.json" items.perWorkspace
pass "the two overrides removed: the create at the cap is refused again once the plan cache has turned over (the creates that landed meanwhile stay)"
fi # the second and third legs

# ── Phase 9 — logout ─────────────────────────────────────────────────────────
say "Phase 9 — logout: the CLI key revokes itself, the browser session ends, the hub logout takes the grant"
sess_revoke=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/sess-revoke.json" -w '%{http_code}' -X DELETE "$SL/api/v1/cli/auth/key" -H "Origin: $SL")
[ "$sess_revoke" = 403 ] || fail "DELETE /cli/auth/key with a SESSION answered $sess_revoke (expected 403): $(cat "$SCRATCH/sess-revoke.json")"
revoke_status=$("${CURL[@]}" -o "$SCRATCH/revoke.json" -w '%{http_code}' -X DELETE "$SL/api/v1/cli/auth/key" -H "Authorization: Bearer $CLI_KEY")
[ "$revoke_status" = 200 ] && jq -e --arg id "$CLI_KEY_ID" '.revoked == true and .id == $id' "$SCRATCH/revoke.json" >/dev/null \
  || fail "DELETE /cli/auth/key with the CLI key answered $revoke_status: $(cat "$SCRATCH/revoke.json")"
after_revoke=$("${CURL[@]}" -o "$SCRATCH/after-revoke.json" -w '%{http_code}' -H "Authorization: Bearer $CLI_KEY" -H "X-Workspace-Id: $WS_ID" "$SL/api/v1/items")
[ "$after_revoke" = 401 ] || fail "the revoked CLI key still answers $after_revoke on GET /items: $(cat "$SCRATCH/after-revoke.json")"
! grep -q '"items"' "$SCRATCH/after-revoke.json" || fail "the 401 carries items"
pass "CLI logout: DELETE /cli/auth/key (the presenting key) → 200 revoked; the same key on GET /items → 401 ($(jq -r '.error.code' "$SCRATCH/after-revoke.json")); a session is refused the route (403)"
other_key=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $MINTED_KEY" -H "X-Workspace-Id: $WS_ID" "$SL/api/v1/items")
[ "$other_key" = 200 ] || fail "the self-revoke reached another key of the same user: GET /items with the dashboard key answered $other_key"
[ "$(sldb "SELECT count(*) FROM api_keys WHERE created_by = '$SL_USER_ID' AND revoked_at IS NOT NULL")" = 1 ] || fail "expected exactly one revoked key"
pass "the self-revoke killed exactly itself: the user's other ytk_ key still reads /items"

# The browser: POST /sso/logout revokes the local session server-side and
# hands back the hub's end-session URL (null when the hub leg cannot be built).
logout_status=$("${CURL[@]}" -b "$SL_JAR" -c "$SL_JAR" -o "$SCRATCH/logout.json" -w '%{http_code}' -X POST "$SL/api/v1/sso/logout" \
  -H "Origin: $SL" -H 'content-type: application/json' -d '{}')
[ "$logout_status" = 200 ] && jq -e 'has("url")' "$SCRATCH/logout.json" >/dev/null || fail "POST /sso/logout answered $logout_status: $(cat "$SCRATCH/logout.json")"
note "hub end-session URL: $(jq -r '.url // "null"' "$SCRATCH/logout.json" | cut -c1-120)"
gone=$("${CURL[@]}" -b "$SL_JAR" -o "$SCRATCH/gone.json" -w '%{http_code}' "$SL/api/v1/me")
[ "$gone" = 401 ] || fail "GET /me after the logout answered $gone: $(cat "$SCRATCH/gone.json")"
[ "$(sldb "SELECT count(*) FROM session WHERE user_id = '$SL_USER_ID'")" = 0 ] || fail "the logout left a session row"
key_logout=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "$SL/api/v1/sso/logout" -H "Authorization: Bearer $MINTED_KEY" -H 'content-type: application/json' -d '{}')
[ "$key_logout" = 403 ] || fail "POST /sso/logout with a ytk_ key answered $key_logout (expected 403: a credential never ends its user's sessions)"
pass "browser logout: POST /sso/logout → 200, the session row is gone, GET /me → 401; a ytk_ key is refused the route (403)"

# `antasphere logout` at the hub: the account key revokes itself and the hub
# cascades onto the offline grant that key minted (PRDCT-1387). The tool's
# stored grant is then dead. The hub-audienced ACCESS token the tool already
# holds is a JWT the hub verifies statelessly, so it lives out its own TTL;
# the drill ends that TTL the way Phase 5 does (expire the stored token,
# restart to drop the in-process cache) and the next demand must refresh.
hub_logout=$("${CURL[@]}" -o "$SCRATCH/hub-logout.json" -w '%{http_code}' -X DELETE "$HUB/api/v1/cli/auth/key" -H "Authorization: Bearer $HUB_KEY")
[ "$hub_logout" = 200 ] || fail "the hub's DELETE /cli/auth/key answered $hub_logout: $(cat "$SCRATCH/hub-logout.json")"
hub_after=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $HUB_KEY" "$HUB/api/v1/me")
[ "$hub_after" = 401 ] || fail "the revoked hub key still answers $hub_after"
[ "$(offline_family "$SL_CLIENT_ID" "$HUB_USER_ID")" = 0 ] || fail "the hub logout left $(offline_family "$SL_CLIENT_ID" "$HUB_USER_ID") offline-grant row(s) for $SL_CLIENT_ID"
pass "hub CLI logout: the account key → 401, and the offline grant it minted for $SL_CLIENT_ID is gone (0 rows)"
sldb "UPDATE account SET access_token_expires_at = now() - interval '1 hour' WHERE provider_id = 'antasphere' AND user_id = '$SL_USER_ID'" >/dev/null
dc restart app >/dev/null 2>&1
wait_ready app "$SL/healthz" 300
dead_status=$("${CURL[@]}" -o "$SCRATCH/dead.json" -w '%{http_code}' -H "Authorization: Bearer $MINTED_KEY" -H "X-Workspace-Id: $WS_ID" "$SL/api/v1/items")
[ "$dead_status" = 401 ] && grep -q hub_grant_expired "$SCRATCH/dead.json" \
  || fail "after the hub logout, the user's remaining key answered $dead_status (expected 401 hub_grant_expired): $(cat "$SCRATCH/dead.json")"
! grep -q '"items"' "$SCRATCH/dead.json" || fail "the 401 carries items"
dead=$(sldb "SELECT (refresh_token IS NULL)::int FROM account WHERE provider_id = 'antasphere' AND user_id = '$SL_USER_ID'")
[ "$dead" = 1 ] || fail "Hackathon Starter did not mark the logged-out grant dead"
pass "the tool follows: once its hub access token is spent the refresh is refused, the grant is marked dead, and the user's remaining ytk_ key answers 401 hub_grant_expired"
