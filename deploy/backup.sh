#!/usr/bin/env bash
# Nightly encrypted backup of the MyDay database, shipped OFF the droplet.
#
#   1. pg_dump (custom format) — run in a throwaway postgres:16 container on
#      Opsentra's docker network, so the droplet needs no Postgres tools.
#   2. Encrypt with AES-256 (openssl, PBKDF2) using /opt/myday/backup.key.
#   3. Upload to S3-compatible storage (e.g. DigitalOcean Spaces) via the
#      aws-cli container. Refuses to call it a success if nothing left the box.
#   4. Keep the last BACKUP_KEEP_DAYS days locally too (fast restores).
#
# Config comes from /opt/myday/.env (never git). See docs/BACKUP-RESTORE.md.
# Prints no secrets. Exit codes: 0 ok, 1 config, 2 not shipped off-droplet.
set -euo pipefail
umask 077

ENV_FILE="${ENV_FILE:-/opt/myday/.env}"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
: "${DATABASE_URL:?DATABASE_URL is not set}"
KEY_FILE="${BACKUP_KEY_FILE:-/opt/myday/backup.key}"
DIR="${BACKUP_DIR:-/opt/myday/backups}"
NET="${BACKUP_DOCKER_NETWORK:-deploy_default}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
PG_IMAGE="${BACKUP_PG_IMAGE:-postgres:16-alpine}"

[ -s "$KEY_FILE" ] || { echo "backup: missing encryption key $KEY_FILE (see docs/BACKUP-RESTORE.md)" >&2; exit 1; }
mkdir -p "$DIR"

TS=$(date -u +%Y%m%dT%H%M%SZ)
NAME="myday-$TS.dump.enc"
OUT="$DIR/$NAME"

# The tables use FORCE row-level security, which applies to the owner role too:
# app.system=on is the policy's "see every household" switch, and
# --enable-row-security lets pg_dump run under the policy instead of failing.
docker run --rm -i --network "$NET" -e PGURL="$DATABASE_URL" -e PGOPTIONS='-c app.system=on' "$PG_IMAGE" \
  sh -c 'pg_dump --format=custom --no-owner --no-acl --enable-row-security --dbname="$PGURL"' \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$KEY_FILE" -out "$OUT.part"
mv "$OUT.part" "$OUT"
( cd "$DIR" && sha256sum "$NAME" > "$NAME.sha256" )
echo "backup: wrote $NAME ($(wc -c < "$OUT") bytes)"

if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  : "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT is not set}"
  for f in "$NAME" "$NAME.sha256"; do
    docker run --rm --network "${BACKUP_S3_NETWORK:-bridge}" -v "$DIR:/b:ro" \
      -e AWS_ACCESS_KEY_ID="${BACKUP_S3_KEY:?}" -e AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET:?}" \
      -e AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-us-east-1}" \
      amazon/aws-cli --only-show-errors --endpoint-url "$BACKUP_S3_ENDPOINT" \
      s3 cp "/b/$f" "s3://$BACKUP_S3_BUCKET/${BACKUP_S3_PREFIX:-myday}/$f"
  done
  echo "backup: shipped to s3://$BACKUP_S3_BUCKET/${BACKUP_S3_PREFIX:-myday}/"
elif [ "${BACKUP_ALLOW_LOCAL_ONLY:-}" != "1" ]; then
  echo "backup: BACKUP_S3_BUCKET not set — this backup is NOT off the droplet" >&2
  exit 2
fi

find "$DIR" -name 'myday-*.dump.enc*' -mtime +"$KEEP_DAYS" -delete
echo "backup: ok"
