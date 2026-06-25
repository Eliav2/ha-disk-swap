# Disk Swap

Migrate your Home Assistant to a new storage device directly from the HA UI. No PC, no SD card reader, no command line required.

## Requirements

- **Home Assistant OS** (HAOS) — not supported on Container or Core installations
- A **USB storage device** (USB stick, USB SSD, SD card with USB adapter) — 8 GB or larger
- **Protection mode** must be disabled (see below)

## Disabling Protection Mode

This app needs direct access to USB block devices to flash them. Protection mode blocks this access.

1. Go to **Settings > Add-ons > Disk Swap**
2. On the **Info** tab, find **Protection mode**
3. Toggle it **off**
4. Restart the app

## How to Use

### 1. Select a Device

Plug your USB storage device into your Home Assistant device. Open the Disk Swap web UI — it automatically detects available USB devices. Select the one you want to clone to.

### 2. Confirm

The app shows a confirmation dialog. The target device will be completely erased. Make sure you selected the right one.

### 3. Choose a Backup

Pick an existing backup or let the app create a new full backup. If you previously ran a clone and the OS image is already cached, you'll see a "cached" badge — no need to re-download.

If the target device already has HA OS, you can skip the flash stage and only re-inject the backup (useful for updating your backup on an already-cloned device).

### 4. Clone

The pipeline runs automatically:

1. **Backup** — creates a full backup of your HA configuration, apps, and database
2. **Download** — fetches the correct HA OS image for your hardware from GitHub
3. **Flash** — writes the OS image to the USB device
4. **Inject** — copies the backup onto the new device and sets up auto-restore
5. **Live Boot** *(optional)* — boots the new HA OS in parallel inside the add-on so you can verify your backup before swapping (see below)

You'll see real-time progress with speed (MB/s) and estimated time remaining. You can safely navigate away — the clone continues in the background.

### 4b. Live Boot (Optional)

Enable **Live Boot** on the backup selection screen to add an extra verification step after cloning. Once the new disk is ready, your new HA OS boots inside the add-on:

- A live Home Assistant instance running directly from your new disk appears in an embedded panel
- Complete onboarding and restore your backup in the inner HA UI
- The inner HA is **fully isolated** — it cannot see or control your smart home devices, and it has no access to your existing HA setup
- Once you've confirmed everything restored correctly, click **Done — Ready to Swap Disk** to shut down the sandbox and proceed

This step is entirely optional. If you skip it, the disk is still ready to boot and will auto-restore your backup on first physical boot.

### 5. Swap and Boot

Once complete, the app shows step-by-step instructions:

1. Shut down your Home Assistant device
2. Remove the current boot media (SD card)
3. Insert the cloned USB device
4. Power on and wait ~5 minutes for HA to boot
5. Log in with your existing credentials

## What Gets Restored

**Automatically on first boot** (no action needed):
- User accounts and login credentials
- All integrations and devices
- Automations, scripts, and scenes
- Entity history and database
- All Home Assistant configuration

**Requires one manual step:**
- Add-on apps need to be restored separately:
  1. Go to **Settings > System > Backups**
  2. Select the backup (the app tells you which one)
  3. Choose **Restore** and select the apps you want
  4. Wait for them to download and install

## Troubleshooting

### No USB devices found

- Make sure the device is plugged in via **USB** (not SATA, NVMe, or the built-in SD slot)
- The device must be between **8 GB and 2 TB**
- Try unplugging and replugging the device, then click **Refresh**

### Protection mode warning

If you see a yellow banner about protection mode, click the link to go to the app settings and disable it. The app cannot access USB devices with protection mode enabled.

### Clone fails during flash

- Check the app logs (**Settings > Add-ons > Disk Swap > Log**)
- Ensure the USB device is not write-protected
- Try a different USB port or device

### Clone fails during inject

- The target device may not have a valid partition table. Try running the clone again (the flash stage recreates partitions)
- Check logs for mount errors — the app needs to mount the device's data partition

## Support

- [GitHub Issues](https://github.com/Eliav2/ha-disk-swap/issues)
- [GitHub Repository](https://github.com/Eliav2/ha-disk-swap)
