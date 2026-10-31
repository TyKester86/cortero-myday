#!/usr/bin/env bash
# Installs MyDay's Plaid PRODUCTION keys on the staging server (Q11 — MyDay runs real finances).
# Run it yourself in Git Bash (not PowerShell, not WSL):
#   bash /c/dev/MyDay-v2/cortero-myday/scripts/set-plaid-keys.sh
# Keys are read hidden, checked against Plaid production first, sent over SSH stdin into
# /opt/myday/.env (backed up first), and only the MyDay app is recreated. Nothing is printed but
# lengths. There is no sandbox mode: MyDay refuses any Plaid environment but production.
set -euo pipefail
K_SSH="$HOME/.ssh/myday_deploy"; HOST=root@159.223.163.99
REDIRECT=https://staging.conquermyday.app/money
echo "Installing MyDay's Plaid production keys on staging."

read -rsp "Plaid client_id (input hidden), then Enter: " CID; echo
read -rsp "Plaid production secret (input hidden), then Enter: " SEC; echo
CID=$(printf '%s' "$CID" | tr -d '[:space:]'); SEC=$(printf '%s' "$SEC" | tr -d '[:space:]')
if ! [[ "$CID" =~ ^[0-9a-f]{24}$ && "$SEC" =~ ^[0-9a-f]{30}$ ]]; then
  echo "Those don't look like Plaid keys (client_id: 24 hex characters, secret: 30 hex characters). Nothing changed."; exit 1
fi
read -rp "Is $REDIRECT added under Allowed redirect URIs in the Plaid dashboard (Developers > API)? (y/N): " RD
[[ "$RD" =~ ^[Yy]$ ]] || REDIRECT=""

CODE=$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d "{\"client_id\":\"$CID\",\"secret\":\"$SEC\",\"count\":1,\"offset\":0,\"country_codes\":[\"US\"]}" https://production.plaid.com/institutions/get)
if [ "$CODE" != "200" ]; then echo "Plaid production refused those keys (HTTP $CODE). Nothing changed."; exit 1; fi
echo "Plaid production accepts the keys. Installing on staging..."

printf '%s\n%s\n%s\n' "$CID" "$SEC" "$REDIRECT" | ssh -i "$K_SSH" "$HOST" '
  set -euo pipefail
  read -r CID; read -r SEC; read -r REDIRECT || true
  cd /opt/myday
  cp -p .env ".env.bak.$(date +%Y%m%d%H%M%S)"
  cp -p .env .env.new
  [ -n "$(tail -c1 .env.new)" ] && echo >> .env.new
  setkv() {
    K="$1" V="$2" awk '"'"'BEGIN{done=0} index($0, ENVIRON["K"] "=")==1 {print ENVIRON["K"] "=" ENVIRON["V"]; done=1; next} {print} END{if(!done) print ENVIRON["K"] "=" ENVIRON["V"]}'"'"' .env.new > .env.tmp && mv .env.tmp .env.new
  }
  setkv PLAID_CLIENT_ID "$CID"; setkv PLAID_SECRET "$SEC"; setkv PLAID_ENV production; setkv PLAID_REDIRECT_URI "$REDIRECT"
  # Bank access tokens are encrypted with MONEY_TOKEN_KEY: made here only if it is missing (changing it would orphan linked banks).
  if ! grep -qE "^MONEY_TOKEN_KEY=[0-9a-fA-F]{64}$" .env.new; then setkv MONEY_TOKEN_KEY "$(openssl rand -hex 32)"; echo "MONEY_TOKEN_KEY was missing - created"; fi
  # No demo data on a real server.
  grep -v "^MONEY_PROVIDER=" .env.new > .env.tmp && mv .env.tmp .env.new
  chmod --reference=.env .env.new; mv .env.new .env
  docker compose up -d --force-recreate myday-api >/dev/null 2>&1
  for i in $(seq 1 40); do [ "$(docker inspect -f "{{.State.Health.Status}}" myday-api 2>/dev/null)" = healthy ] && break; sleep 3; done
  for v in PLAID_CLIENT_ID PLAID_SECRET PLAID_ENV PLAID_REDIRECT_URI MONEY_TOKEN_KEY; do
    L=$(docker exec myday-api printenv $v 2>/dev/null | tr -d "\n" | wc -c); echo "$v inside myday-api: $L chars"
  done
  echo "Plaid environment: $(docker exec myday-api printenv PLAID_ENV) · app: $(docker inspect -f "{{.State.Health.Status}}" myday-api)"
'
echo "Done. Open https://staging.conquermyday.app/money and tap Link a bank (a real bank — there is no sandbox)."
