#!/usr/bin/env bash
# ONE-TIME droplet setup for MyDay staging. Run as root on the droplet:
#   bash bootstrap-droplet.sh
# Creates the myday Postgres role + database inside Opsentra's Postgres
# container (with NEW credentials — never Opsentra's), and writes
# /opt/myday/.env with generated secrets. Prints no secret values.
# Safe to re-run: it skips anything that already exists.
set -euo pipefail

REMOTE_DIR=/opt/myday
ENV_FILE=$REMOTE_DIR/.env
PG_CONTAINER=${PG_CONTAINER:-deploy-postgres-1}
PG_SUPERUSER=${PG_SUPERUSER:-opsentra}

mkdir -p "$REMOTE_DIR"

if [ -f "$ENV_FILE" ]; then
  echo "$ENV_FILE exists — leaving it alone."
else
  DB_PW=$(openssl rand -hex 24)
  # Local socket inside the container: no Opsentra password needed or copied.
  docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_SUPERUSER" -d postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'myday') THEN
    CREATE ROLE myday LOGIN PASSWORD '$DB_PW';
  ELSE
    ALTER ROLE myday PASSWORD '$DB_PW';
  END IF;
END \$\$;
SQL
  if ! docker exec "$PG_CONTAINER" psql -U "$PG_SUPERUSER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='myday'" | grep -q 1; then
    docker exec "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_SUPERUSER" -d postgres -c "CREATE DATABASE myday OWNER myday"
  fi
  docker exec "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_SUPERUSER" -d postgres -c "REVOKE CONNECT ON DATABASE myday FROM PUBLIC; GRANT CONNECT ON DATABASE myday TO myday;"

  umask 077
  cat > "$ENV_FILE" <<ENV
NODE_ENV=production
PORT=4000
TZ_HOUSEHOLD=America/Chicago
PUBLIC_URL=https://staging.conquermyday.app
DATABASE_URL=postgresql://myday:$DB_PW@postgres:5432/myday
SESSION_SECRET=$(openssl rand -hex 32)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
ALLOWED_EMAILS=
# TEMPORARY — verification only. Blank this line once Google sign-in works.
DEV_LOGIN_TOKEN=$(openssl rand -hex 24)
ENV
  chmod 600 "$ENV_FILE"
  echo "Wrote $ENV_FILE (mode 600). Read the dev token on the droplet with: grep DEV_LOGIN_TOKEN $ENV_FILE"
fi

echo "Bootstrap done. Next: add the Caddy block (deploy/Caddyfile.snippet) and push to main."
