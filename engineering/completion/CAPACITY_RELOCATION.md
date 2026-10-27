# Host capacity: Docker data relocation procedure

Status: PREPARED, NOT EXECUTED. Executing it changes the shared Docker Desktop
data disk, so it requires the machine owner's approval (see "Approval needed").

## Why this exists

Two release gates (B002 SQL Server conformance, B006 Kubernetes deployment)
cannot run on this host because the Docker data disk lives on `C:` and `C:` has
no room for the images:

| Measurement | Value |
| --- | --- |
| `docker_data.vhdx` | 37,476,106,240 bytes (34.9 GiB) at `%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx` |
| `C:` free before relocation | ~1.8 GB |
| `docker system df` | 25.97 GB images (15.6 GB from other projects), 2.06 GB containers, 2.26 GB volumes, 3.44 GB build cache (0.08 GB reclaimable) |
| SQL Server 2022 image | ~0.63 GB compressed, ~1.6 GB extracted |
| `kindest/node:v1.36.1` | ~0.38 GB compressed, ~1 GB extracted, plus control-plane images |
| `E:` free | ~421 GB |

Deleting other projects' images/volumes is not acceptable, and a 2-3 GB cleanup
on `C:` is not enough headroom for the images plus VHDX growth. The supported
fix is to move Docker's data disk to `E:`.

## What was ruled out

- **Editing `settings-store.json` (`dataFolder`) and restarting.** Observed
  behaviour: Docker Desktop creates a new empty disk at the new path; it does
  not migrate the existing images, volumes or containers.
- **`wsl --manage docker-desktop --move E:\...`.** This distro holds the 104 MB
  `ext4.vhdx` only. The 34.9 GiB `docker_data.vhdx` is a separate disk managed
  by Docker Desktop, so the move would not free meaningful space.
- **Copying `docker_data.vhdx` by hand.** Explicitly out of bounds: manual VHDX
  manipulation can corrupt the Docker store.
- **Pruning other projects.** The 15.6 GB of images include local-only builds
  (`nirnay-production-*`) that belong to other environments.

## Procedure A - Docker Desktop migration (supported)

Owner action, ~10-20 minutes, no CLI equivalent.

1. Confirm no unrelated Docker workload is running that must stay up:
   `docker ps` (this host currently runs `spool-pg`, `spool-mysql`,
   `spool-daemon-e2e` and other projects' containers).
2. Ensure `E:\Docker` exists (the parent must be writable by the user).
3. Docker Desktop -> Settings -> Resources -> Advanced -> **Disk image
   location** -> choose `E:\Docker\data` -> **Apply & restart**.
4. Wait for the migration to finish. Docker Desktop must report the new
   location after the restart; do not interact with the engine during the move.
5. Verify before using it:

   ```powershell
   docker system df
   docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
   docker images --format '{{.Repository}}:{{.Tag}}\t{{.Size}}'
   Get-ChildItem E:\Docker\data
   Get-PSDrive C,E | ForEach-Object { "$($_.Name): free={0:N2} GB" -f ($_.Free/1GB) }
   ```

   Expected: the same image/container/volume inventory as before the move, the
   data disk under `E:\Docker\data`, and a large increase in `C:` free space.

## Rollback

Reverse the same GUI setting to the previous location and let Docker Desktop
migrate back. If Docker Desktop fails to start after the move, quitting Docker
Desktop and starting it again re-reads the configured location; the previous
disk is left intact at the old path until the migration completes.

## After relocation (work still pending owner approval)

1. Pull SQL Server 2022 and run every `tests/conformance/mssql-*` suite with
   `SPOOL_MSSQL_URL`/credential env vars, logging to `E:\temp\spool-qual\`.
2. Create a disposable single-node `kind` cluster, build the SPOOL image at the
   exact release commit, `kind load docker-image`, deploy `helm/spool`, and run
   the deployment checks (secrets, readiness, network policy, PVC, non-root,
   authenticated migration, restart, rollback, invalid config).
3. The chart pins `replicaCount: 1`; a successful deploy proves a single-node
   installation, never multi-replica HA or failover.
