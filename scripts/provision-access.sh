#!/usr/bin/env bash
# Provision Agent CRM Cloudflare Access apps and service tokens.
# Secrets are stored in 1Password; this script prints only non-secret IDs/AUD tags.
set -euo pipefail

ACCOUNT_ID="e1e48237580e2796c8d53a089e8eab02"
TEAM="labountylabs.cloudflareaccess.com"
CF_IDP="475c75eb-88c7-4b17-a8dc-4d485e59a39e"
ADMIN_EMAIL="admin@labountylabs.com"
DASHBOARD_HOST="crm.services.c18h.net"
AGENT_HOST="crm-agent.services.c18h.net"
CALLBACK="https://${AGENT_HOST}/callback"
ARTIFACT="/tmp/crm-access-provision.json"

cf_api() {
  local method="$1" path="$2"
  shift 2
  curl -sS -X "$method" \
    -H "Authorization: Bearer ${API_TOKEN}" \
    -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4${path}" \
    "$@"
}

require_success() {
  python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('success') else 1)" || {
    echo "API error: $1" >&2
    exit 1
  }
}

echo "Creating dashboard Access app..."
DASH_RESP=$(cf_api POST "/accounts/${ACCOUNT_ID}/access/apps" --data @- <<EOF
{
  "name": "Agent CRM dashboard",
  "type": "self_hosted",
  "domain": "${DASHBOARD_HOST}",
  "self_hosted_domains": ["${DASHBOARD_HOST}"],
  "session_duration": "8h",
  "allowed_idps": ["${CF_IDP}"],
  "auto_redirect_to_identity": true,
  "policies": [{
    "name": "Allow account members",
    "decision": "allow",
    "include": [{"email": {"email": "${ADMIN_EMAIL}"}}]
  }]
}
EOF
)
echo "$DASH_RESP" | require_success "dashboard app"
AUD_DASH=$(echo "$DASH_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['aud'])")
DASH_ID=$(echo "$DASH_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['id'])")

echo "Creating API Access app..."
API_RESP=$(cf_api POST "/accounts/${ACCOUNT_ID}/access/apps" --data @- <<EOF
{
  "name": "Agent CRM API",
  "type": "self_hosted",
  "domain": "${AGENT_HOST}/v1/*",
  "self_hosted_domains": ["${AGENT_HOST}/v1/*"],
  "destinations": [{"type": "public", "uri": "${AGENT_HOST}/v1/*"}],
  "session_duration": "24h",
  "auto_redirect_to_identity": false,
  "policies": []
}
EOF
)
echo "$API_RESP" | require_success "api app"
AUD_API=$(echo "$API_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['aud'])")
API_ID=$(echo "$API_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['id'])")

echo "Creating MCP OAuth SaaS app..."
SAAS_RESP=$(cf_api POST "/accounts/${ACCOUNT_ID}/access/apps" --data @- <<EOF
{
  "name": "Agent CRM MCP OAuth",
  "type": "saas",
  "saas_app": {
    "auth_type": "oidc",
    "redirect_uris": ["${CALLBACK}"],
    "grant_type": ["authorization_code", "refresh_tokens"],
    "refresh_token_options": {"lifetime": "90d"}
  },
  "allowed_idps": ["${CF_IDP}"],
  "policies": [{
    "name": "Allow account members",
    "decision": "allow",
    "include": [{"email": {"email": "${ADMIN_EMAIL}"}}]
  }]
}
EOF
)
echo "$SAAS_RESP" | require_success "saas app"
SAAS=$(echo "$SAAS_RESP" | python3 -c "
import sys,json
r=json.load(sys.stdin)['result']
s=r.get('saas_app') or {}
print(json.dumps({
  'id': r['id'],
  'client_id': s.get('client_id',''),
  'aud': r.get('aud',''),
}))
")
SAAS_ID=$(echo "$SAAS" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
OAUTH_CLIENT_ID=$(echo "$SAAS" | python3 -c "import sys,json; print(json.load(sys.stdin)['client_id'])")

echo "Fetching SaaS client secret..."
SAAS_DETAIL=$(cf_api GET "/accounts/${ACCOUNT_ID}/access/apps/${SAAS_ID}")
echo "$SAAS_DETAIL" | require_success "saas detail"
OAUTH_CLIENT_SECRET=$(echo "$SAAS_DETAIL" | python3 -c "import sys,json; print((json.load(sys.stdin)['result'].get('saas_app') or {}).get('client_secret',''))")

AUTH_URL="https://${TEAM}/cdn-cgi/access/sso/oidc/${OAUTH_CLIENT_ID}/authorization"
TOKEN_URL="https://${TEAM}/cdn-cgi/access/sso/oidc/${OAUTH_CLIENT_ID}/token"
JWKS_URL="https://${TEAM}/cdn-cgi/access/sso/oidc/${OAUTH_CLIENT_ID}/jwks"

validate_jwks_url() {
  local url="$1"
  local status ct body
  status=$(curl -sS -o /dev/null -w "%{http_code}" "$url")
  if [ "$status" != "200" ]; then
    echo "JWKS URL returned HTTP ${status}" >&2
    exit 1
  fi
  ct=$(curl -sS -D - -o /dev/null "$url" | awk -F': ' 'tolower($1)=="content-type"{print tolower($2)}' | tr -d '\r' | head -1)
  if [[ "$ct" != *application/json* ]]; then
    echo "JWKS URL content-type is not application/json" >&2
    exit 1
  fi
  body=$(curl -sS "$url")
  python3 -c "import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if isinstance(d.get('keys'), list) and d['keys'] else 1)" "$body" || {
    echo "JWKS URL response missing keys array" >&2
    exit 1
  }
}

echo "Validating JWKS URL..."
validate_jwks_url "$JWKS_URL"

echo "Creating service token: agent-crm-pi..."
ST_RESP=$(cf_api POST "/accounts/${ACCOUNT_ID}/access/service_tokens" --data '{"name":"agent-crm-pi"}')
echo "$ST_RESP" | require_success "service token pi"
ST_PI=$(echo "$ST_RESP" | python3 -c "
import sys,json
r=json.load(sys.stdin)['result']
print(json.dumps({'id': r['id'], 'client_id': r['client_id']}))
")
ST_PI_ID=$(echo "$ST_PI" | python3 -c "import sys,json; print(json.load(sys.stdin)['client_id'])")

echo "Creating service token: agent-crm-enrichment..."
ST2_RESP=$(cf_api POST "/accounts/${ACCOUNT_ID}/access/service_tokens" --data '{"name":"agent-crm-enrichment"}')
echo "$ST2_RESP" | require_success "service token enrichment"
ST_ENR=$(echo "$ST2_RESP" | python3 -c "
import sys,json
r=json.load(sys.stdin)['result']
print(json.dumps({'id': r['id'], 'client_id': r['client_id']}))
")
ST_ENR_ID=$(echo "$ST_ENR" | python3 -c "import sys,json; print(json.load(sys.stdin)['client_id'])")

echo "Attaching service-token policy to API app..."
POLICY_RESP=$(cf_api POST "/accounts/${ACCOUNT_ID}/access/apps/${API_ID}/policies" --data @- <<EOF
{
  "name": "Service Auth tokens",
  "decision": "non_identity",
  "include": [
    {"service_token": {"token_id": "$(echo "$ST_PI" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")"}},
    {"service_token": {"token_id": "$(echo "$ST2_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['id'])")"}}
  ]
}
EOF
)
echo "$POLICY_RESP" | require_success "api service auth policy"

COOKIE_KEY=$(openssl rand -hex 32)

python3 - <<PY > "$ARTIFACT"
import json
print(json.dumps({
  "dashboard_app_id": "${DASH_ID}",
  "api_app_id": "${API_ID}",
  "saas_app_id": "${SAAS_ID}",
  "access_aud_dashboard": "${AUD_DASH}",
  "access_aud_api": "${AUD_API}",
  "oauth_client_id": "${OAUTH_CLIENT_ID}",
  "oauth_authorization_url": "${AUTH_URL}",
  "oauth_token_url": "${TOKEN_URL}",
  "oauth_jwks_url": "${JWKS_URL}",
  "service_token_pi_client_id": "${ST_PI_ID}",
  "service_token_enrichment_client_id": "${ST_ENR_ID}",
  "team_domain": "${TEAM}",
}, indent=2))
PY

# Store secrets in 1Password (never printed)
op item create \
  --category="API Credential" \
  --title="Agent CRM Cloud OAuth" \
  --vault=rails \
  "ACCESS_CLIENT_ID[password]=${OAUTH_CLIENT_ID}" \
  "ACCESS_CLIENT_SECRET[password]=${OAUTH_CLIENT_SECRET}" \
  "ACCESS_AUTHORIZATION_URL[text]=${AUTH_URL}" \
  "ACCESS_TOKEN_URL[text]=${TOKEN_URL}" \
  "ACCESS_JWKS_URL[text]=${JWKS_URL}" \
  "COOKIE_ENCRYPTION_KEY[password]=${COOKIE_KEY}" \
  >/dev/null

op item create \
  --category="API Credential" \
  --title="Agent CRM service token pi" \
  --vault=rails \
  "CF_ACCESS_CLIENT_ID[password]=$(echo "$ST_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['client_id'])")" \
  "CF_ACCESS_CLIENT_SECRET[password]=$(echo "$ST_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['client_secret'])")" \
  >/dev/null

op item create \
  --category="API Credential" \
  --title="Agent CRM service token enrichment" \
  --vault=rails \
  "CF_ACCESS_CLIENT_ID[password]=$(echo "$ST2_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['client_id'])")" \
  "CF_ACCESS_CLIENT_SECRET[password]=$(echo "$ST2_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['client_secret'])")" \
  >/dev/null

echo "Provisioned. Public metadata: $ARTIFACT"
