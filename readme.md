# Disk Swap for Home Assistant

Migrate your Home Assistant to a new storage device — directly from the HA UI, no PC required.

![Disk Swap UI](https://github.com/user-attachments/assets/5261b597-92a8-41af-9c5f-f0e5b55c797c)

[![Add Repository](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FEliav2%2Fha-disk-swap)

## Features

- **One-click migration** — backup, flash, and restore in a single pipeline
- **Auto-restore on first boot** — configuration, automations, accounts, and database are restored automatically
- **Live Boot** — boot your new HA OS in parallel inside the add-on, verify your backup restored correctly, then swap the disk with confidence
- **Real-time progress** — live speed (MB/s) and ETA for every stage
- **Image caching** — skip re-download on repeat clones
- **Safe device filtering** — only shows USB devices, never your boot disk
- **Cancellation** — abort at any stage
- **Backup selection** — create a new backup or use an existing one

## Installation

1. Click the **Add Repository** button above (or manually add `https://github.com/Eliav2/ha-disk-swap` in **Settings > Add-ons > Add-on Store > Repositories**)
2. Install **Disk Swap** from the store
3. **Disable protection mode** on the app's Info tab (required for USB device access)
4. Start the app and open the **Web UI**

## How It Works

1. **Plug in** a USB storage device (USB stick, SSD, SD card via adapter)
2. **Select** the target device in the UI
3. **Clone** — the app creates a backup, downloads the HA OS image, flashes it to the USB device, and injects your backup
4. **(Optional) Live Boot** — enable the Live Boot feature to boot your new HA OS in parallel inside the add-on. Your new HA is completely isolated — it cannot see or control your devices. Use it to complete onboarding, restore the backup, and confirm everything works before committing to the swap
5. **Swap** — shut down, remove the old boot media, insert the cloned device
6. **Boot** — power on and log in with your existing credentials

## What Gets Restored

**Automatically on first boot:**
- User accounts and login credentials
- Integrations and devices
- Automations, scripts, and scenes
- Entity history and database
- All Home Assistant configuration

**One extra step (Settings > System > Backups):**
- Add-on apps — select the backup and restore the apps you need

## Requirements

- **Home Assistant OS** (not Container or Core)
- USB storage device, **8 GB or larger**
- Protection mode must be **disabled** (the app needs raw block device access)

## Supported Hardware

Works on all [Home Assistant OS supported boards](https://www.home-assistant.io/installation/) including Raspberry Pi 3/4/5, ODROID, Tinker Board, Intel NUC, and generic x86-64.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture overview, and build instructions.

## License

[MIT](LICENSE)
