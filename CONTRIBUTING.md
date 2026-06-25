# Contributing to Disk Swap

## Architecture

The addon has two main parts:

- **Backend** (`disk-swap/server/`) — Bun + Hono HTTP server that orchestrates the 5-stage clone pipeline and exposes a REST API + WebSocket for real-time progress
- **Frontend** (`disk-swap/frontend/`) — React + Vite SPA with TanStack Store for state management and shadcn/ui components

Shared TypeScript types live in `disk-swap/shared/types.ts`.

### Clone Pipeline

The pipeline runs 4 stages sequentially:

| Stage | What it does | Key file |
|-------|-------------|----------|
| **Backup** | Creates a full HA backup via the Supervisor API | `server/clone.ts` → `server/supervisor.ts` |
| **Download** | Fetches the HA OS image from GitHub releases (with caching + checksum) | `server/images.ts` |
| **Flash** | Writes the OS image to the USB device via `xz | pv | dd` | `server/flasher.ts` |
| **Inject** | Copies the backup to the new device's data partition + sets up `.HA_RESTORE` for auto-restore | `server/injector.ts` |

Progress is streamed to the frontend via WebSocket (`server/jobs.ts` → `hooks/use-clone-progress.ts`).

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/devices` | List safe USB devices |
| GET | `/api/system-info` | Board, OS version, IP, free space |
| GET | `/api/backups` | List existing HA backups |
| GET | `/api/image-cache` | Cached OS image status |
| DELETE | `/api/image-cache` | Discard cached image |
| POST | `/api/start-clone` | Start clone pipeline |
| POST | `/api/cancel-clone` | Cancel running clone |
| GET | `/api/jobs/current` | Current job state (for reconnection) |
| WS | `/ws/progress` | Real-time stage updates |

## Project Structure

```
disk-swap/
├── server/           # Bun backend
│   ├── index.ts      # Hono routes + WebSocket + static files
│   ├── clone.ts      # Pipeline orchestrator
│   ├── flasher.ts    # xz/pv/dd pipeline
│   ├── injector.ts   # Backup injection + .HA_RESTORE
│   ├── images.ts     # Image download, caching, checksum
│   ├── supervisor.ts # HA Supervisor API client
│   ├── devices.ts    # USB device enumeration + safety filters
│   └── jobs.ts       # Job state machine + WebSocket pub/sub
├── frontend/         # React SPA
│   └── src/
│       ├── App.tsx           # 5-screen flow
│       ├── store.ts          # TanStack Store (state + actions)
│       ├── components/       # UI screens + primitives
│       ├── hooks/            # Data fetching + WebSocket
│       └── lib/api.ts        # API client
├── shared/types.ts   # Shared TypeScript types
├── rootfs/var/www/   # Built frontend assets (committed)
├── config.yaml       # HA addon configuration
├── Dockerfile        # Container build
└── CHANGELOG.md      # Version history
```

## Development Setup

### Prerequisites

- [Bun](https://bun.sh) (v1.2+)
- Node.js (for frontend tooling)
- A Home Assistant OS VM for integration testing ([UTM](https://mac.getutm.app) with `haos_generic-aarch64` works well)

### Local Development (Mock Mode)

```bash
cd disk-swap
bun install
bun dev    # starts on http://localhost:8099 with DEV=1 (mock data)
```

`DEV=1` loads mock USB devices and system info. No HA VM needed for API/frontend work.

For frontend-only development with hot reload:

```bash
cd disk-swap/frontend
bun install
bun dev    # Vite dev server with proxy to backend at :8099
```

### What Can Be Tested Without Hardware

| Feature | Hardware needed? |
|---------|-----------------|
| All UI screens and flows | No |
| Supervisor API (backup, system-info) | No (mocked in DEV mode) |
| Image download + checksum | No |
| WebSocket progress updates | No |
| Job state machine | No |
| Flash (dd pipeline) | Yes — USB device |
| Inject (mount + copy) | Yes — USB device |

## Build & Deploy

The frontend is pre-built and committed to `rootfs/var/www/`. The Dockerfile copies these static assets — it does NOT build the frontend during Docker build.

### Fast Deploy (rsync + local addon)

For rapid iteration without git commits, use the **local addon** approach. Files are rsync'd directly to the HA device and rebuilt in-place.

**One-time setup:**

```bash
# 1. rsync the addon to HA's local addons directory
cd disk-swap
bun run sync

# 2. Reload the store so the Supervisor discovers it
ssh root@<ha-ip> "ha store reload"

# 3. Install the local addon (slug: local_disk-swap)
ssh root@<ha-ip> "ha apps install local_disk-swap"

# 4. Stop the store-based addon to avoid port conflicts
ssh root@<ha-ip> "ha apps stop 64504a20_disk-swap"
```

**Iterating (from `disk-swap/`):**

| Command | What it does | When to use |
|---------|-------------|-------------|
| `bun run deploy` | Build frontend + rsync + rebuild | Frontend + backend changes |
| `bun run deploy:quick` | rsync + rebuild (skip frontend build) | Backend-only changes |
| `bun run build` | Build frontend | Frontend changes only |
| `bun run sync` | rsync files to HA device | Push files without rebuilding |
| `bun run rebuild` | Rebuild addon on HA device | Trigger Docker rebuild |
| `bun run logs` | Tail addon logs | Debugging |
| `bun run restart` | Restart addon without rebuild | Quick restart |

No git commit, push, or version bump needed. Docker layer caching makes rebuilds fast since only the `COPY` layers change.

> **Note:** `rebuild` errors if `config.yaml` version changed since install — use `ha apps update local_disk-swap` instead, or keep the version constant during development.

### Git Deploy (store addon)

For final releases or when the local addon isn't set up:

```bash
# 1. Build frontend (if changed)
cd disk-swap && bun run build

# 2. Commit everything (source + built assets)
git add -A && git commit -m "description"

# 3. Bump version in disk-swap/config.yaml

# 4. Push
git push origin dev

# 5. Update on HA (via SSH)
ssh root@<ha-ip> "ha store refresh && ha apps update <slug>"
```

### Useful HA CLI Commands

```bash
ha apps info <slug>         # app status
ha apps logs <slug> -f      # tail logs
ha apps restart <slug>      # restart without rebuild
ha apps rebuild <slug>      # rebuild local addon
ha supervisor logs          # supervisor logs
```

## USB Device Testing

For testing flash and inject stages, you need a physical USB storage device:

1. Plug a USB device into your Mac
2. In UTM, click the USB icon in the toolbar
3. Attach the device to the VM
4. It appears as `/dev/sdX` inside the VM

Note: the Mac's built-in SD card slot cannot be passed through — use an external USB adapter.

## Key Technical Decisions

- **`full_access: true`** — USB devices appear as dynamic `/dev/sdX` block devices. HA's `devices:` key only supports static paths, so full access is required.
- **Bun runtime** — Fast startup, built-in TypeScript, `Bun.spawn` for process management, `$` shell for commands.
- **Pre-built frontend** — Keeps the Docker build simple and fast. No Node.js needed in the container.
- **`setsid` for flash** — Creates a new process group so the entire `xz | pv | dd` pipeline can be killed on cancel.
- **`.HA_RESTORE`** — HA Core's built-in mechanism for auto-restoring config on first boot. Placed during inject stage.
