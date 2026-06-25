## 1.2.0

### Live Boot (new)

- **Sandbox stage**: boot your new HA OS in parallel inside a Docker-in-Docker environment to verify your backup restored correctly before swapping the disk
- Automatic backup restore via the onboarding API — no manual steps needed
- Sandbox proxy on port 8124 for isolated browser access to the inner HA instance
- Enabled by default (can be toggled off in the backup selection screen)
- Non-fatal: if sandbox fails, the disk is still fully usable for normal first-boot restore

### Improvements

- **Backup progress tracking**: estimate progress from backup file size growth instead of the Supervisor's 0→100 jump
- **Code quality**: consolidate duplicated types between frontend and server via shared `@shared/` alias, extract shared `formatBytes` utility, deduplicate backup name lookup, clean up redundant error handling
- **Inject stage**: always format data partition with fresh ext4 to prevent stale state from previous runs
- **Sandbox proxy**: add try-catch to prevent connection resets, explicit `0.0.0.0` bind
- **Sandbox auto-restore**: retry on non-JSON responses (HTML error pages), fail fast on 401
- **Supervisor API**: add 30s timeout to all calls to prevent indefinite hangs
- **Frontend**: connectivity probe before showing sandbox iframe, "See detailed logs" link in progress card
- **Injector**: cancel reader stream on abort to prevent memory leak
- **Job persistence**: log errors instead of silently swallowing write failures
- **Job resume**: persist `skipFlash` and `sandboxEnabled` so resumed jobs show correct stage labels
- **Security**: add `sandbox` attribute to inner HA iframe

### Bug fixes

- Fix `SupervisorBackup` type missing `size_bytes` field
- Fix `StartCloneRequest` type missing `skip_sandbox` field
- Fix `ImageCacheStatus` shared type having required fields that are optional when not cached

## 1.0.1

- Fix inject: drop kernel page cache after mkfs to prevent stale reads on freshly flashed devices

## 1.0.0

First stable release.

- Clone your Home Assistant to a USB device directly from the HA UI
- 4-stage pipeline: backup, download, flash, inject
- Auto-restore on first boot via `.HA_RESTORE`
- Real-time progress with speed and ETA
- Cancel and resume at any stage
- OS image caching (skip re-download)
- Backup selection (existing or new)
- Protection mode detection with direct link to settings

## 0.5.23

- Auto-restore on first boot: inject `.HA_RESTORE` file so HA Core automatically restores configuration, accounts, automations, and database when the cloned device boots for the first time
- Hard-link backup to `homeassistant/backups/` for HA Core access (no extra disk space)
- Updated completion screen with clear two-section instructions: boot steps + app restore path
- Thread backup name through to the completion UI

## 0.5.22

- Fix device card selection: override default ring color so only the selected device shows a highlight ring

## 0.5.20

- Fix device selection: compare devices by path instead of serial to avoid duplicate selection

## 0.5.17

- Fix inject: clear stale filesystem signatures with `wipefs` before `mkfs` to prevent corrupted ext4
- Flush block device cache after creating filesystem
- Fix backup file lookup: search all tars by reading `backup.json` when slug-based filename doesn't match
- Add "Start Over" button on failure screen

## 0.5.16

- Create ext4 filesystem on hassos-data partition if not present (HA OS normally creates this on first boot)

## 0.5.15

- Fix inject: use PARTLABEL instead of LABEL to find hassos-data partition
- Skip flash stage if target device already has HA OS (reflash toggle in UI)

## 0.5.14

- Fix inject: add abort signal support for cancellation during backup copy
- Ensure mount point directory exists before mounting
- Clean unmount on cancel (via finally block)

## 0.5.13

- Fix flash cancel: use `setsid` to create new process group so entire `xz | pv | dd` pipeline can be killed
- Pass abort signal through flash stage

## 0.5.12

- Fix stage descriptions not restoring after page refresh/reconnection

## 0.5.11

- Move ETA calculation to backend for accuracy (compute from total size and current speed)

## 0.5.10

- Add ETA display next to "Running" badge during download and flash
- Add "safe to navigate away" note during clone

## 0.5.9

- Fix speed indicator flashing: always show during in_progress, display 0 MB/s when idle

## 0.5.8

- Fix flash: use `oflag=direct` instead of `conv=fdatasync,sync` so dd stays killable during cancel
- Add real-time speed display (MB/s) during download and flash stages
- Allow canceling clone during flash/inject (shows warning instead of blocking)
- Detect protection mode: show warning banner with direct link to addon settings

## 0.5.7

- Add flash error capture: non-numeric stderr lines from xz/pv/dd are collected and shown on failure
- AppArmor: add capability rules for block device access
- Add SYS_RAWIO and SYS_ADMIN privileged capabilities

## 0.5.3

- Image cache status: show "cached" badge for downloaded OS image with version, board, and size
- Discard cached image: add button to re-download
- Relative time display for backups using date-fns
- Sort backups newest first

## 0.5.1

- Reorder flow: erase confirmation before backup selection

## 0.5.0

- Cancel operation: abort running clone and return to device selection
- Backup selection: choose from existing HA backups or create a new one
- Stage descriptions: each pipeline step shows explanatory text; download links to GitHub release
- Image caching: skip re-download when OS image already exists on disk
- Include database in backup
- Skip checksum verification when `.sha256` file unavailable

## 0.4.0

- Use manager Supervisor role for `/jobs/*` polling access
- Use `backup: hot` so Supervisor doesn't stop addon during clone
- Pipeline debug logging and crash handlers
- WebSocket fix: normalize double-slash paths from HA ingress
- Persist clone state across page navigation
- Add refresh button to device list

## 0.3.0

- Full clone pipeline: backup, download, flash, inject
- Real-time WebSocket progress for all stages
- Fix overlay rootfs detection in getBootDisk
- Add mount/e2fsprogs packages for ext4 support

## 0.1.0

- Initial release
- Add-on repository structure with ingress web UI
- Block device enumeration
- HA OS image download
