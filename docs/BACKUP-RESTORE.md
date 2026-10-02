# Backups and restore

The MyDay database is backed up every night by `deploy/backup.sh`:

1. `pg_dump` runs in a throwaway `postgres:16-alpine` container on Opsentra's network. It dumps every household; row-level security is respected via `app.system=on` plus `--enable-row-security`.
2. The dump is encrypted with AES-256 (`openssl enc -aes-256-cbc -pbkdf2 -iter 200000`) using `/opt/myday/backup.key`.
3. It is uploaded **off the droplet** to S3-compatible storage (DigitalOcean Spaces), along with a `.sha256` checksum.
4. The last 14 days are also kept locally in `/opt/myday/backups` for fast restores.

If no bucket is configured, the script exits with status 2. That way a "backup" that never left the box can't look like a success.

## One-time setup (on the droplet)

1. **Create a Spaces bucket.** DigitalOcean → *Spaces Object Storage* → *Create bucket*.
   - Pick a region different from the droplet's if you can, e.g. `myday-backups` in `nyc3`.
   - Leave *File listing* restricted (private).
   - Then *Settings* → *Lifecycle rules* → expire objects after **90 days**.
2. **Create a scoped key.** *API* → *Spaces Keys* → *Generate New Key*, limited to that bucket with read and write access.
3. **Generate the encryption key.** Store a copy **somewhere other than the droplet** (your password manager). Without it, the backups cannot be decrypted.
   ```sh
   openssl rand -base64 48 > /opt/myday/backup.key && chmod 600 /opt/myday/backup.key
   cat /opt/myday/backup.key   # copy into your password manager, then clear the screen
   ```
4. **Add the bucket settings** to `/opt/myday/.env`. Never put these in git.
   ```
   BACKUP_S3_BUCKET=myday-backups
   BACKUP_S3_ENDPOINT=https://nyc3.digitaloceanspaces.com
   BACKUP_S3_REGION=us-east-1
   BACKUP_S3_KEY=<spaces access key>
   BACKUP_S3_SECRET=<spaces secret>
   ```
5. **Install the nightly job** (03:15 droplet time) and run it once by hand.
   ```sh
   echo '15 3 * * * root /opt/myday/deploy/backup.sh >> /var/log/myday-backup.log 2>&1' > /etc/cron.d/myday-backup
   chmod 644 /etc/cron.d/myday-backup
   /opt/myday/deploy/backup.sh
   ```
   The paths assume the repo is checked out at `/opt/myday`. Adjust them if the deploy copies it elsewhere.

Each run logs one line per step to `/var/log/myday-backup.log`. Check it after the first night.

## Restore

`deploy/restore.sh <backup> <target-database-url>` does the following:
- **Source:** it takes a local file, `latest` (newest local file), or `s3:<name>` (downloads that object from the bucket first).
- **Checks:** it verifies the checksum and decrypts.
- **Restore:** it runs `pg_restore`, then prints row counts of the key tables.
- **Safety:** it refuses to restore over the live database unless `RESTORE_INTO_LIVE=yes`.

The target must be an **existing, empty** database. Restore as the `postgres` superuser: the tables force row-level security, so only a superuser can load every household's rows.

### Look at a backup without touching production
```sh
docker exec -it <postgres container> psql -U postgres -c "CREATE DATABASE myday_restore_check"
/opt/myday/deploy/restore.sh latest "postgresql://postgres:<pw>@<postgres host>:5432/myday_restore_check"
# …inspect…, then:
docker exec -it <postgres container> psql -U postgres -c "DROP DATABASE myday_restore_check"
```
To use a backup from the bucket instead, pick a name from `aws s3 ls` and pass it as `s3:myday-20261002T031500Z.dump.enc`.

### Replace production after data loss
1. Stop the app: `cd /opt/myday && docker compose stop myday-api`.
2. Recreate an empty database: `DROP DATABASE myday; CREATE DATABASE myday OWNER myday ENCODING 'UTF8' TEMPLATE template0;`.
3. Restore:
   ```sh
   RESTORE_INTO_LIVE=yes /opt/myday/deploy/restore.sh s3:<name> "postgresql://postgres:<pw>@<host>:5432/myday"
   ```
4. Hand ownership back to the app role, then start the app:
   ```sh
   psql -U postgres -d myday -c "REASSIGN OWNED BY postgres TO myday"
   docker compose up -d myday-api
   ```
   Migrations run on start and are no-ops on a restored database.
5. Sign in, open Today and Money, and spot-check one family.

## The drill (proven before shipping)

`scripts/restore-drill.mjs` runs the real `backup.sh` and `restore.sh` end to end against a local copy of the database. It uses an S3 stand-in (`adobe/s3mock`) in place of Spaces:
1. Back up as the app role and ship it to the bucket. Check that it is encrypted (no plaintext dump header). Check that a run with no bucket exits 2.
2. Delete every local copy. Check that restoring over the live database is refused. Restore from the bucket into a scratch database.
3. Compare row counts of **every** table, and check that row-level security and the append-only events log still hold.

Result on 2026-10-02: **77 tables, 820 rows, all matching. RLS forced on 73 tables. Events still append-only. RESTORE DRILL PASSED.**

Run it again after schema changes:
```sh
DRILL_ADMIN_URL=postgresql://<superuser>:<pw>@localhost:5432/postgres node scripts/restore-drill.mjs
```
It needs Docker and a database named `myday_e2e` (left behind by `npm run e2e`).
