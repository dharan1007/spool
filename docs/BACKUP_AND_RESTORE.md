# Backup and restore

SPOOL durable state is three kinds of SQLite database, all in WAL mode:

| State | Location | Written by |
| --- | --- | --- |
| Enterprise registry (organizations, workspaces, memberships, API key hashes, migration records, activity journal) | `$SPOOL_STATE_DIR/registry.db` | `spoold-v2` |
| Per-migration checkpoints, leases and run state | `<workspace>/migrations/<migrationId>/state.db` | the engine |
| Migration target databases | wherever the workspace declares | the engine |

## What is verified

`node scripts/drill-backup-restore.js` performs a real drill on this machine and
prints retained evidence (`SPOOL_EVIDENCE_JSON=...`):

1. Creates a live registry with an organization, workspace, membership, issued
   API key, migration record and activity journal, plus a WAL target database
   with committed rows.
2. Backs both up **while their writers are still open**, through SQLite's online
   backup API (`src/platform/sqlite-backup.js`), never a filesystem copy.
3. Restores the copies into a fresh root and opens them with the real application
   code: workspace, membership role, API key hash resolution, migration terminal
   status, every activity entry and every target row must match.
4. Compares schema hashes and per-table content digests (`verifyRestore`).
5. Proves the negative: a backup with one committed row deleted is rejected.

`tests/backup-restore.test.js` keeps those properties under test in `npm test`.

## Operator procedure

```bash
# 1. Quiesce writes (stop spoold-v2 or scale the deployment to zero).
# 2. Back up every database with the online API, e.g.:
node -e "import('./src/platform/sqlite-backup.js').then(async m => console.log(await m.backupDatabase({ source: process.argv[1], destination: process.argv[2] })))" \
  /var/lib/spool/registry.db /backup/registry-$(date +%Y%m%dT%H%M%S).db

# 3. Verify the copy before trusting it.
node -e "import('./src/platform/sqlite-backup.js').then(m => console.log(m.verifyRestore({ source: process.argv[1], restored: process.argv[2] })))" \
  /var/lib/spool/registry.db /backup/registry-20260101T000000.db

# 4. Restore by putting the verified copy at the original path with the daemon
#    stopped, then start the daemon and confirm /v2/ready and a registry list.
```

## Not covered (do not claim otherwise)

- Off-host, object-storage or cross-region copies.
- Encryption at rest or in transit for backup media.
- Point-in-time recovery beyond the moment of the online backup snapshot.
- Restore onto different hardware or into a different cluster.
- Customer-owned target databases: their backup path is the customer's
  responsibility (`docs/AUTHORIZATION_TEMPLATE.md`).
