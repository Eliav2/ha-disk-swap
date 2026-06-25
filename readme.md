# Disk Swap for Home Assistant

Migrate your Home Assistant to a new storage device — directly from the HA UI, no PC required.

![Disk Swap UI](https://github.com/user-attachments/assets/5261b597-92a8-41af-9c5f-f0e5b55c797c)

[![Add Repository](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FEliav2%2Fha-disk-swap)

## Live Boot — a whole Home Assistant running *inside* the add-on

![Live Boot — your cloned Home Assistant booted inside the add-on](https://github.com/user-attachments/assets/84723355-f16a-444f-9a44-5cec90326e72)

This is the part that shouldn't be possible.

Before you ever touch your hardware, Disk Swap spins up a **complete, isolated Home Assistant** — its own Supervisor, Core, and add-ons — **nested inside this add-on**, boots it against your freshly-cloned disk, restores your entire setup into it, and shows it to you running, live, in your browser. You watch your real HA come back to life in a sandbox, confirm everything is there, *then* swap the disk with zero doubt.

Running a full nested Supervisor + Core + add-on stack inside a single Home Assistant add-on is not a thing the platform was built to do. As far as we know, nothing else in the HA community pulls this off. Big claim. Big add-on. 🦣

And the cloned disk it produces boots **clean, on its own**, straight into your fully-restored Home Assistant — no onboarding, no manual restore, no "second step." Swap it in and you're home.

## Features

- **One-click migration** — backup, flash, restore, and verify in a single pipeline
- **Live Boot** — boot a complete, isolated Home Assistant (Supervisor + Core + add-ons) *inside* the add-on and watch your backup restore in real time before you commit to the swap. The inner HA can't see or touch your real devices
- **True clone** — Core config, **add-ons**, folders, and database are all restored into the new disk, not config-only
- **Clean standalone boot** — the cloned disk boots on its own into your fully-restored HA; no onboarding, no manual restore step
- **Real-time progress** — live download speed (MB/s) and ETA for every stage, including per-image pull speed
- **Image caching** — skip re-download on repeat clones
- **Safe device filtering** — only shows USB devices, never your boot disk
- **Cancellation** — abort at any stage

## Installation

1. Click the **Add Repository** button above (or manually add `https://github.com/Eliav2/ha-disk-swap` in **Settings > Add-ons > Add-on Store > Repositories**)
2. Install **Disk Swap** from the store
3. **Disable protection mode** on the app's Info tab (required for USB device access)
4. Start the app and open the **Web UI**

## How It Works

1. **Plug in** a USB storage device (USB stick, SSD, SD card via adapter)
2. **Select** the target device in the UI
3. **Clone** — the app creates a backup, downloads the HA OS image, flashes it to the USB device, and injects your backup
4. **Live Boot (recommended)** — boots a complete, isolated Home Assistant inside the add-on and **restores your full backup into the new disk** (Core, add-ons, folders, database), then shows it running so you can confirm everything came back. The inner HA is fully sandboxed — it cannot see or control your real devices
5. **Swap** — shut down, remove the old boot media, insert the cloned device
6. **Boot** — power on; it comes straight up as your Home Assistant, already restored

## What Gets Restored

**With Live Boot (full clone):** everything is restored *and verified* into the new disk before you swap —

- User accounts and login credentials
- Integrations and devices
- Automations, scripts, and scenes
- Entity history and database
- All Home Assistant configuration
- **Add-ons** (e.g. Advanced SSH, File Editor) and their folders

Swap the disk and it boots straight into your fully-restored Home Assistant.

> One exception: the Disk Swap add-on itself is intentionally skipped during the Live Boot restore — there's no point reinstalling the cloning tool into the temporary verification sandbox. As a result it isn't on the cloned disk; reinstall it from the add-on store afterwards if you want it on the cloned machine.

**Without Live Boot:** the backup is injected onto the disk; on first boot, choose *Restore from backup* on the welcome screen to bring everything back.

## Requirements

- **Home Assistant OS** (not Container or Core)
- USB storage device, **8 GB or larger**
- Protection mode must be **disabled** (the app needs raw block device access)
- Live Boot's instant restore needs **Core ≥ 2026.4** (older Core still works, just slower)

## Supported Hardware

Works on all [Home Assistant OS supported boards](https://www.home-assistant.io/installation/) including Raspberry Pi 3/4/5, ODROID, Tinker Board, Intel NUC, and generic x86-64.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture overview, and build instructions.

## License

[MIT](LICENSE)
