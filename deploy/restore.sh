#!/usr/bin/env bash
# Restore a MyDay backup into a database.
#
#   restore.sh <backup> <target-database-url>
#
#   <backup>  a local file (myday-*.dump.enc), "latest" (newest local file), or
#             "s3:<name>" to fetch that object from the backup bucket first.
#   target    a database URL for an EXISTING, EMPTY database, connected as a
#             role that can create tables and bypass row-level security
#             (the postgres superuser). Restoring over the live database is
#             refused unless RESTORE_INTO_LIVE=yes.
#
# Checks the sha256, decrypts with /opt/myday/backup.key, pg_restores, then
# prints row counts of the key tables. See docs/BACKUP-RESTORE.md.
set -euo pipefail
umask 077

ENV_FILE="${ENV_FILE:-/opt/myday/.env}"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
SRC="${1:?usage: restore.sh <backup|latest|s3:name> <target-database-url>}"
TARGET="${2:?usage: restore.sh <backup|latest|s3:name> <target-database-url>}"
KEY_FILE="${BACKUP_KEY_FILE:-/opt/myday/backup.key}"
DIR="${BACKUP_DIR:-/opt/myday/backups}"
NET="${BACKUP_DOCKER_NETWORK:-deploy_default}"
PG_IMAGE="${BACKUP_PG_IMAGE:-postgres:16-alpine}"

if [ -n "${DATABASE_URL:-}" ] && [ "$TARGET" = "$DATABASE_URL" ] && [ "${RESTORE_INTO_LIVE:-}" != "yes" ]; then
  echo "restore: target is the LIVE database — refusing (set RESTORE_INTO_LIVE=yes if you really mean it)" >&2
  exit 1
fi
[ -s "$KEY_FILE" ] || { echo "restore: missing key $KEY_FILE" >&2; exit 1; }
mkdir -p "$DIR"

case "$SRC" in
  latest) FILE=$(ls -1t "$DIR"/myday-*.dump.enc | head -1) ;;
  s3:*)
    NAME="${SRC#s3:}"
    for f in "$NAME" "$NAME.sha256"; do
      docker run --rm --network "${BACKUP_S3_NETWORK:-bridge}" -v "$DIR:/b" \
        -e AWS_ACCESS_KEY_ID="${BACKUP_S3_KEY:?}" -e AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET:?}" \
        -e AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-us-east-1}" \
        amazon/aws-cli --only-show-errors --endpoint-url "${BACKUP_S3_ENDPOINT:?}" \
        s3 cp "s3://$BACKUP_S3_BUCKET/${BACKUP_S3_PREFIX:-myday}/$f" "/b/$f"
    done
    FILE="$DIR/$NAME" ;;
  *) FILE="$SRC" ;;
esac
[ -s "$FILE" ] || { echo "restore: no backup at $FILE" >&2; exit 1; }
if [ -f "$FILE.sha256" ]; then
  ( cd "$(dirname "$FILE")" && sha256sum -c "$(basename "$FILE").sha256" >/dev/null ) || { echo "restore: checksum mismatch" >&2; exit 1; }
  echo "restore: checksum ok"
fi

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$KEY_FILE" -in "$FILE" \
  | docker run --rm -i --network "$NET" -e PGURL="$TARGET" "$PG_IMAGE" \
      sh -c 'pg_restore --no-owner --no-acl --exit-on-error --dbname="$PGURL"'
echo "restore: restored $(basename "$FILE")"

docker run --rm --network "$NET" -e PGURL="$TARGET" "$PG_IMAGE" sh -c 'psql "$PGURL" -Atc "
  SELECT '"'"'households='"'"' || count(*) FROM households UNION ALL
  SELECT '"'"'members='"'"' || count(*) FROM household_members UNION ALL
  SELECT '"'"'meals='"'"' || count(*) FROM meals UNION ALL
  SELECT '"'"'events='"'"' || count(*) FROM events"'
