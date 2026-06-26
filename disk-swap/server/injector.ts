import { $ } from "bun";
import { readdir } from "node:fs/promises";

const MOUNT_POINT = "/mnt/newsd";
const BACKUP_DIR = "/backup";
const LOOP_DEV = "/dev/loop0";

/** Find the hassos-data partition on the target device. */
export async function findDataPartition(devicePath: string): Promise<string> {
  const output = await $`lsblk -nro NAME,PARTLABEL ${devicePath}`.text();

  for (const line of output.trim().split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === "hassos-data") {
      return `/dev/${parts[0]}`;
    }
  }

  throw new Error(
    `Could not find hassos-data partition on ${devicePath}. ` +
      `Flash may have failed or partition layout is unexpected.`,
  );
}

/**
 * Get the byte offset and size of a partition for use with losetup.
 * Returns { offset, sizelimit } in bytes.
 */
export async function getPartitionGeometry(partitionPath: string): Promise<{ offset: number; sizelimit: number }> {
  const start = parseInt(
    (await $`lsblk -nrbo START ${partitionPath}`.text()).trim(),
  );
  const size = parseInt(
    (await $`lsblk -nrbo SIZE ${partitionPath}`.text()).trim(),
  );
  if (isNaN(start) || isNaN(size)) {
    throw new Error(`Could not determine geometry for ${partitionPath}`);
  }
  // START is in 512-byte sectors; SIZE with -b is already in bytes
  return { offset: start * 512, sizelimit: size };
}

/**
 * Set up a loop device for the partition.
 * This avoids page cache aliasing between the whole-disk device (written by dd
 * during flash) and the partition device — the loop device has its own page
 * cache, so mkfs.ext4 writes are not shadowed by stale cached blocks.
 */
async function setupLoop(partitionPath: string, devicePath: string): Promise<void> {
  await $`losetup -d ${LOOP_DEV}`.nothrow().quiet();

  // Grow the data partition to fill the disk BEFORE creating the filesystem.
  // Freshly-flashed HA OS images ship a small (~1.3GB) fixed hassos-data
  // partition; HA OS only expands it on first boot. The inject stage runs
  // before that, so without growing here a large backup (e.g. 6+ GB) overflows
  // the tiny partition → ENOSPC. sfdisk ", +" extends the partition to the end
  // of the disk and fixes the GPT secondary header (parted fails here).
  const partNum = partitionPath.match(/(\d+)$/)?.[1];
  if (partNum) {
    await $`echo ', +' | sfdisk --force -N ${partNum} ${devicePath}`.nothrow().quiet();
    await $`partprobe ${devicePath}`.nothrow().quiet();
    await $`udevadm settle --timeout=5`.nothrow().quiet();
    console.log(`[inject] Grew data partition ${partitionPath} to fill disk`);
  }

  const { offset, sizelimit } = await getPartitionGeometry(partitionPath);
  console.log(`[inject] Setting up loop device: offset=${offset}, size=${sizelimit}`);
  await $`losetup -o ${offset} --sizelimit ${sizelimit} ${LOOP_DEV} ${devicePath}`;
}

async function teardownLoop(): Promise<void> {
  await $`losetup -d ${LOOP_DEV}`.nothrow().quiet();
}

/** Create a fresh ext4 filesystem on the loop device. */
async function createExt4(): Promise<void> {
  console.log(`[inject] Creating ext4 filesystem on ${LOOP_DEV}...`);
  await $`wipefs -a ${LOOP_DEV}`.nothrow().quiet();
  await $`mkfs.ext4 -F -L hassos-data ${LOOP_DEV}`;
  await $`sync`;
}

async function mount(): Promise<void> {
  await $`mkdir -p ${MOUNT_POINT}`;
  // Always create a fresh ext4 — ensures no leftover state from previous runs
  // (e.g. sandbox auth tokens, docker images) when skipFlash is used.
  await createExt4();
  await $`mount -t ext4 -o rw ${LOOP_DEV} ${MOUNT_POINT}`;
}

async function unmount(): Promise<void> {
  try {
    await $`sync`;
    await $`umount ${MOUNT_POINT}`;
  } catch {
    /* ignore — may not be mounted */
  }
}

/**
 * Find the backup .tar file for a given slug.
 * HA stores backups as {slug}.tar, but automatic backups may use name-based filenames.
 * Falls back to searching all tars in /backup/ by reading their backup.json.
 */
export async function findBackupFile(slug: string): Promise<string> {
  // Fast path: check {slug}.tar directly
  const directPath = `${BACKUP_DIR}/${slug}.tar`;
  if (await Bun.file(directPath).exists()) return directPath;

  // Slow path: search all tars for matching slug in backup.json
  console.log(`[inject] ${slug}.tar not found, searching backup files...`);
  const files = await readdir(BACKUP_DIR);
  for (const file of files) {
    if (!file.endsWith(".tar")) continue;
    const filePath = `${BACKUP_DIR}/${file}`;
    try {
      const json = await $`tar -xf ${filePath} backup.json -O`.text();
      const meta = JSON.parse(json);
      if (meta.slug === slug) {
        console.log(`[inject] Found backup ${slug} in ${file}`);
        return filePath;
      }
    } catch { /* not a valid backup tar */ }
  }

  throw new Error(`Backup file not found for slug: ${slug}`);
}


/**
 * Inject a backup .tar into the freshly flashed device's data partition.
 * 1. Find hassos-data partition
 * 2. Set up loop device (avoids page cache aliasing after dd flash)
 * 3. Mount at /mnt/newsd
 * 4. Copy backup .tar into supervisor/backup/
 * 5. sync + unmount + teardown loop (always, via finally)
 */
export async function injectBackup(
  devicePath: string,
  backupSlug: string,
  progressCb: (percent: number, description?: string, speed?: number, eta?: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  progressCb(0, "Finding data partition\u2026");
  const sourcePath = await findBackupFile(backupSlug);
  const destDir = `${MOUNT_POINT}/supervisor/backup`;
  const destPath = `${destDir}/${backupSlug}.tar`;

  const sourceFile = Bun.file(sourcePath);
  const totalBytes = sourceFile.size;

  // Refresh kernel's partition table view (important when flash was skipped)
  await $`partprobe ${devicePath}`.nothrow().quiet();
  await $`udevadm settle --timeout=5`.nothrow().quiet();

  const partitionPath = await findDataPartition(devicePath);

  try {
    progressCb(1, "Preparing disk\u2026");
    await setupLoop(partitionPath, devicePath);

    progressCb(2, "Mounting filesystem\u2026");
    await mount();
    await $`mkdir -p ${destDir}`;

    progressCb(3, "Copying backup\u2026");
    const reader = sourceFile.stream().getReader();
    const writer = Bun.file(destPath).writer();
    let copied = 0;
    const copyStart = Date.now();
    let lastSpeedTime = copyStart;
    let lastSpeedBytes = 0;
    let speed = 0;

    try {
    while (true) {
      if (signal?.aborted) {
        reader.cancel();
        await writer.end();
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      // Must await: backpressure + so a write error (e.g. ENOSPC) rejects here
      // and fails the stage cleanly, instead of escaping as an unhandled
      // rejection that floods the logs with [FATAL] once per buffered chunk.
      await writer.write(value);
      copied += value.byteLength;

      // Calculate speed: interval-based after first 500ms, average-based before
      const now = Date.now();
      const elapsed = now - lastSpeedTime;
      if (elapsed >= 500) {
        speed = ((copied - lastSpeedBytes) / elapsed) * 1000;
        lastSpeedTime = now;
        lastSpeedBytes = copied;
      } else if (speed === 0 && copied > 0) {
        const totalElapsed = now - copyStart;
        if (totalElapsed > 0) {
          speed = (copied / totalElapsed) * 1000;
        }
      }

      const remaining = totalBytes - copied;
      const eta = speed > 0 ? remaining / speed : 0;
      // File copy maps to 3–90%
      const copyPercent = 3 + Math.round((copied / totalBytes) * 87);
      progressCb(copyPercent, "Copying backup\u2026", speed, eta);
    }
    } catch (err: unknown) {
      // Best-effort close so the sink doesn't reject again on its own.
      // writer.end() returns number | Promise<number>; wrap so a sync return or a
      // rejected promise both swallow cleanly (no .catch on the bare number).
      try { await writer.end(); } catch { /* ignore */ }
      const e = err as { code?: string };
      if (e?.code === "ENOSPC") {
        const gb = (totalBytes / 1024 ** 3).toFixed(1);
        throw new Error(
          `Ran out of space writing the ${gb} GB backup to the target disk. ` +
            `The device is too small for this backup \u2014 use a larger USB device.`,
        );
      }
      throw err;
    }

    if (!signal?.aborted) {
      await writer.end();

      progressCb(95, "Flushing writes to disk\u2026");
      await $`sync`;
    }
  } finally {
    progressCb(98, "Unmounting\u2026");
    await unmount();
    await teardownLoop();
  }
}
