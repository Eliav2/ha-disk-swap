import { $ } from "bun";
import { findDataPartition, getPartitionGeometry } from "./injector.ts";

const DATA_MOUNT = "/mnt/newsd";
const LOOP_DEV = "/dev/loop0";
const DIND_SOCK = "/run/dind.sock";

// Map uname -m to the HA supervisor image arch prefix
const ARCH_MAP: Record<string, string> = {
  aarch64: "aarch64",
  x86_64: "amd64",
};
const rawArch = (await $`uname -m`.text()).trim();
const SUPERVISOR_ARCH = ARCH_MAP[rawArch] ?? rawArch;
const SUPERVISOR_IMAGE = `ghcr.io/home-assistant/${SUPERVISOR_ARCH}-hassio-supervisor:latest`;

// HA Core runs in Docker --network=host mode (Supervisor default when no HA OS is present).
// It binds to 0.0.0.0:8123 in the outer container's network namespace.
// Poll and proxy via 127.0.0.1:8123.
const SUPERVISOR_IP = "127.0.0.1";

// Module-level state for the "user is done" deferred and proxy URL
let sandboxDoneResolve: (() => void) | null = null;
let sandboxProxyUrl: string | null = null;

/** Called by POST /api/sandbox/done — signals the sandbox that the user finished restoring. */
export function signalSandboxDone(): void {
  sandboxDoneResolve?.();
}

/** Returns the URL of the running HA Core instance for proxying, or null if not ready. */
export function getSandboxProxyUrl(): string | null {
  return sandboxProxyUrl;
}

/** Set up loop device for the data partition (page cache aliasing safety). */
async function setupLoop(devicePath: string): Promise<void> {
  await $`losetup -d ${LOOP_DEV}`.nothrow().quiet();
  const partitionPath = await findDataPartition(devicePath);

  // Grow the data partition to fill available disk space.
  // Freshly-flashed HA OS images have a small (~1.3GB) fixed data partition.
  // The sandbox needs several GB for Docker image storage.
  // sfdisk ", +" extends the partition to the end of the disk and also fixes
  // the GPT secondary header location (which parted fails to handle here).
  const partNum = partitionPath.match(/(\d+)$/)?.[1];
  if (partNum) {
    await $`echo ', +' | sfdisk --force -N ${partNum} ${devicePath}`.nothrow().quiet();
    console.log(`[sandbox] Grew data partition ${partitionPath} to fill disk`);
  }

  const { offset, sizelimit } = await getPartitionGeometry(partitionPath);
  console.log(`[sandbox] Loop device: offset=${offset}, sizelimit=${sizelimit}`);
  await $`losetup -o ${offset} --sizelimit ${sizelimit} ${LOOP_DEV} ${devicePath}`;

  // Resize the ext4 filesystem to fill the newly expanded partition.
  await $`e2fsck -f -p ${LOOP_DEV}`.nothrow().quiet();
  await $`resize2fs ${LOOP_DEV}`.nothrow().quiet();
  console.log(`[sandbox] Filesystem resized to fill partition`);
}

async function mountPartition(): Promise<void> {
  await $`mkdir -p ${DATA_MOUNT}`;
  await $`mount -t ext4 -o rw ${LOOP_DEV} ${DATA_MOUNT}`;
}

async function unmountSafe(): Promise<void> {
  try {
    await $`sync`;
    await $`umount ${DATA_MOUNT}`;
  } catch {
    /* ignore — may not be mounted */
  }
}

async function teardownLoop(): Promise<void> {
  await $`losetup -d ${LOOP_DEV}`.nothrow().quiet();
}

/** Write the inner dockerd config file. */
async function writeDaemonConfig(): Promise<void> {
  const config = {
    "storage-driver": "overlay2",
    // Disable inner dockerd iptables management. When enabled, dockerd pollutes the
    // addon container's network namespace with DOCKER chains containing blanket DROP
    // rules that block the outer Supervisor's ingress proxy from reaching this addon
    // (causing the panel to go blank during and after sandbox execution).
    // We add only the minimal MASQUERADE rules manually after dockerd starts.
    iptables: false,
    "seccomp-profile": "unconfined",
    dns: ["8.8.8.8", "8.8.4.4"],
    "data-root": `${DATA_MOUNT}/docker`,
  };
  await Bun.write("/tmp/dind-daemon.json", JSON.stringify(config, null, 2));
}

/** Poll the dockerd unix socket until it responds (500ms intervals). */
async function waitForDockerd(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await $`docker -H unix://${DIND_SOCK} version`.nothrow().quiet();
    if (result.exitCode === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dockerd socket ${DIND_SOCK} not ready after ${timeoutMs}ms`);
}

/** Poll supervisor logs until it reports RUNNING state (up to 25 min). */
async function waitForSupervisorRunning(signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 25 * 60 * 1000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("Cancelled");
    const logs = await $`docker -H unix://${DIND_SOCK} logs --tail 50 hassio_supervisor 2>&1`.nothrow().text();
    if (logs.includes("Supervisor is up and running")) {
      console.log("[sandbox] Supervisor reached RUNNING state");
      return;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  console.warn("[sandbox] Timed out waiting for Supervisor RUNNING — proceeding anyway");
}

/** Poll HTTP until a non-5xx response arrives (500ms intervals). */
async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) return; // 200, 302, 401, 403 are all "HA is up"
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`HA Core at ${url} not ready after ${timeoutMs}ms`);
}

/**
 * Run the ephemeral HA sandbox stage.
 *
 * Boots a real HA Supervisor + Core inside the add-on using Docker-in-Docker,
 * with the inner dockerd writing to the target disk's Docker data directory.
 * This means after the sandbox session, the HA Core image is already on disk
 * (same benefit as the old pre-cache stage) PLUS the user has interactively
 * restored their backup through the real HA UI.
 *
 * Non-fatal: if this stage fails, the disk is still fully functional — the user
 * will just need to do a normal first-boot restore.
 */
/**
 * Automatically restore the injected backup via the HA onboarding API.
 *
 * This must be called BEFORE the user manually completes onboarding (i.e. before
 * POST /api/onboarding/users). The onboarding restore path bypasses the Supervisor
 * "startup" state check that blocks the regular POST /backups/{slug}/restore/full.
 *
 * agent_id "hassio.local" is the Supervisor's local storage (.local location).
 */
async function autoRestoreBackup(
  backupSlug: string,
  progressCb: (percent: number, description?: string) => void,
): Promise<void> {
  const coreUrl = `http://${SUPERVISOR_IP}:8123`;

  // Verify the user step hasn't been completed yet — if it has, the onboarding
  // restore endpoint will return 401 and we should bail out early.
  // The response may be HTML (e.g. networking error page) instead of JSON — retry.
  let onboarding: Array<{ step: string; done: boolean }> | null = null;
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(`${coreUrl}/api/onboarding`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 401) {
        // 401 = HA Core already has auth (not in onboarding mode).
        // Likely leftover state from a previous sandbox run on the same disk.
        throw new Error("Onboarding already completed (401) — skipping auto-restore");
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("json")) {
        // HTML response (e.g. networking error page) — transient, retry
        console.log(`[sandbox] Onboarding returned non-JSON (attempt ${i + 1}/10), retrying…`);
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }
      onboarding = await res.json();
      break;
    } catch (err) {
      // Re-throw terminal errors (401, user done) — don't retry
      if (err instanceof Error && (err.message.includes("401") || err.message.includes("already"))) throw err;
      console.log(`[sandbox] Onboarding check failed (attempt ${i + 1}/10): ${err}`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  if (!onboarding) throw new Error("Could not reach onboarding API after retries");
  const userDone = onboarding.find((s) => s.step === "user")?.done ?? false;
  if (userDone) throw new Error("Onboarding user step already done");

  progressCb(87, "Restoring your backup…");

  // Trigger restore via the onboarding API — no auth token required.
  // We call this only after the Supervisor has reached RUNNING state, so "blocked"
  // responses should be rare. Retry up to 20× (60s) for transient errors.
  // HA Core may go offline before sending the response; swallow network errors.
  let res: Response | null = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    res = await fetch(`${coreUrl}/api/onboarding/backup/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backup_id: backupSlug, agent_id: "hassio.local" }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);

    if (!res || res.ok) break; // success or network error (HA restarting)

    const body = await res.text().catch(() => "");
    if (res.status === 400 && body.includes("blocked")) {
      // Supervisor BackupManager not running yet — wait and retry
      console.log(`[sandbox] Backup manager blocked, retrying in 3s (attempt ${attempt + 1}/20)…`);
      await new Promise((r) => setTimeout(r, 3_000));
      continue;
    }
    if (res.status === 404 || res.status === 500 || res.status === 503) {
      // Transient errors — HA Core integrations load asynchronously after the HTTP
      // server starts. 404 = onboarding routes not registered yet; 500 = hassio
      // backup agent not registered yet; 503 = service unavailable.
      console.log(`[sandbox] Restore returned ${res.status}, retrying in 3s (attempt ${attempt + 1}/20)…`);
      await new Promise((r) => setTimeout(r, 3_000));
      continue;
    }
    throw new Error(`Onboarding restore failed (${res.status}): ${body}`);
  }
  if (res && !res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Onboarding restore failed after retries (${res.status}): ${body}`);
  }

  console.log("[sandbox] Restore triggered, waiting for HA to restart…");
  progressCb(88, "Waiting for HA to restart…");

  // HA shuts down within ~5s of restore being triggered, then comes back up.
  // After restore the Supervisor may need to pull a different Core version
  // (backup version != latest), which can take time in DinD. Use 15-min timeout.
  await new Promise((r) => setTimeout(r, 8_000));
  await waitForHttp(coreUrl, 15 * 60 * 1000);

  console.log("[sandbox] HA Core back online after restore");
}

export async function runSandboxStage(
  devicePath: string,
  machine: string,
  backupSlug: string,
  progressCb: (percent: number, description?: string) => void,
  signal: AbortSignal,
): Promise<void> {
  // Reset module-level state
  sandboxDoneResolve = null;
  sandboxProxyUrl = null;

  let dockerdProc: ReturnType<typeof Bun.spawn> | null = null;

  try {
    // 1. Mount target disk's data partition via loop device
    progressCb(0, "Mounting data partition…");
    await $`partprobe ${devicePath}`.nothrow().quiet();
    await $`udevadm settle --timeout=5`.nothrow().quiet();
    await setupLoop(devicePath);
    await mountPartition();

    if (signal.aborted) throw new Error("Cancelled");

    // 2. Write inner dockerd config (data-root on target disk so HA Core image persists)
    progressCb(5, "Configuring sandbox environment…");
    await writeDaemonConfig();

    // 3. Set up required host paths for Supervisor plugins
    // Supervisor data dir = /mnt/newsd/supervisor (matches real HA OS disk layout).
    // This means the injected backup at /mnt/newsd/supervisor/backup/ is automatically
    // visible to the inner Supervisor as /data/backup/ without any extra copying.
    // audio/external must pre-exist: audio plugin fails on CAP_SYS_NICE and never
    // creates it, but HA Core bind-mounts it and errors out if the path is missing.
    // cid_files/homeassistant.cid must pre-exist as an empty file: Docker bind-mounts
    // a file (not a directory) here, and refuses to create a non-existent file source.
    // config.json removal forces fresh-boot mode (not "Detected Supervisor restart"):
    // in restart mode the Supervisor defers Core start to a ~5-minute periodic watchdog;
    // in fresh mode it starts Core immediately during initialization.
    // homeassistant dir removal forces fresh onboarding on every sandbox run so the
    // iframe always shows the onboarding UI (not a dashboard from a previous run).
    await $`mkdir -p /mnt/newsd/supervisor/audio/external /mnt/newsd/supervisor/cid_files`.nothrow().quiet();

    // The Supervisor bind-mounts several host paths into every child container it starts
    // (homeassistant, audio, observer, etc.). These paths must exist as the correct type
    // in the addon container's filesystem or Docker will refuse to create the containers.
    //
    // /run/dbus         — must be a directory (Supervisor mounts DBus socket dir)
    // /etc/machine-id   — must be a FILE; Docker creates an empty directory placeholder
    //                     when the host bind-mount source is missing, which causes
    //                     IsADirectoryError / "bind source does not exist" on child starts
    // /run/docker.sock  — must be a socket/file; our inner dockerd listens on
    //                     /run/dind.sock, so symlink the standard path to it so the
    //                     Observer plugin can connect
    await $`mkdir -p /run/dbus`.nothrow().quiet();
    await $`sh -c '[ -d /etc/machine-id ] && rm -rf /etc/machine-id; true'`.nothrow().quiet();
    await Bun.write("/etc/machine-id", crypto.randomUUID().replace(/-/g, "") + "\n");
    await $`ln -sf ${DIND_SOCK} /run/docker.sock`.nothrow().quiet();
    await $`touch /mnt/newsd/supervisor/cid_files/homeassistant.cid`.nothrow().quiet();
    await $`rm -f /mnt/newsd/supervisor/config.json`.nothrow().quiet();
    await $`rm -rf /mnt/newsd/supervisor/homeassistant`.nothrow().quiet();

    if (signal.aborted) throw new Error("Cancelled");

    // 4. Start inner dockerd
    progressCb(15, "Starting sandbox Docker daemon…");

    // Start dockerd inside a new mount namespace so we can remount /proc/sys
    // read-write without the change propagating to the host.
    // /proc/sys is read-only in the addon container; dockerd needs to write
    // sysctl values (hairpin mode, IPv6 RA) when creating bridge networks.
    const dockerdArgs = [
      "dockerd",
      "--config-file",
      "/tmp/dind-daemon.json",
      "--host",
      `unix://${DIND_SOCK}`,
      "--bip",
      "10.99.99.1/24",
      "--userland-proxy=false",
      "--log-level",
      "info",
    ].join(" ");
    dockerdProc = Bun.spawn(
      [
        "unshare",
        "--mount",
        "/bin/sh",
        "-c",
        // mount --make-shared /mnt/newsd: Docker bind-mounts require the parent mount
        // to be shared or slave. After unshare --mount, /mnt/newsd is private.
        // Making it shared allows the inner dockerd to bind-mount subdirectories
        // (e.g. /mnt/newsd/supervisor) into HA Core's container.
        `mount -o remount,rw /proc/sys && mount -o remount,rw /sys/fs/cgroup && sysctl -w net.ipv4.conf.default.rp_filter=0 && mount --make-shared /mnt/newsd && exec ${dockerdArgs}`,
      ],
      { stdout: Bun.file("/tmp/dind.log"), stderr: Bun.file("/tmp/dind.log") },
    );

    await waitForDockerd(30_000);
    console.log("[sandbox] Inner dockerd ready");

    // Add the minimal NAT rules inner containers need to reach the internet.
    // We use --iptables=false on dockerd so it doesn't add DOCKER chains with DROP
    // rules. Instead we only MASQUERADE traffic from inner networks leaving eth0.
    await $`iptables -t nat -A POSTROUTING -s 172.30.32.0/23 -o eth0 -j MASQUERADE`.nothrow().quiet();
    await $`iptables -t nat -A POSTROUTING -s 10.99.99.0/24 -o eth0 -j MASQUERADE`.nothrow().quiet();

    // Overwrite resolv.conf with real DNS BEFORE any docker pull.
    // The outer container's /etc/resolv.conf contains 127.0.0.11 (Docker's embedded
    // DNS). If a previous sandbox run (or the hassio bridge creation below) disrupts
    // routing, 127.0.0.11 may become unreachable and pull fails with "server
    // misbehaving". Using 8.8.8.8 directly avoids any such routing dependency.
    await Bun.write("/etc/resolv.conf", "nameserver 8.8.8.8\nnameserver 8.8.4.4\nsearch local.hass.io\n");

    if (signal.aborted) throw new Error("Cancelled");

    // 5. Pull Supervisor image BEFORE creating the hassio network.
    //    Creating hassio (172.30.32.0/23) adds a conflicting kernel route that
    //    breaks internet connectivity for the inner dockerd process.
    //    Pulling first ensures we have the image locally before the route exists.
    progressCb(15, "Pulling HA Supervisor image…");
    await $`docker -H unix://${DIND_SOCK} pull ${SUPERVISOR_IMAGE}`;
    console.log("[sandbox] Supervisor image pulled");

    // Pre-pull HA Core images while DNS still works (before hassio_dns takes over).
    // The Supervisor will find them cached and skip the slow DinD download.
    // We need BOTH the latest version (initial boot) AND the backup's version
    // (restore downgrades Core to the backup's version).
    progressCb(20, "Pulling HA Core image (this may take a few minutes)…");
    try {
      const versionJson = await fetch("https://version.home-assistant.io/stable.json", {
        signal: AbortSignal.timeout(15_000),
      }).then((r) => r.json()) as Record<string, any>;
      const latestVersion = versionJson?.homeassistant?.[machine];

      // Get backup's HA version from the tar's backup.json
      let backupVersion: string | null = null;
      try {
        const bjson = (await $`tar -xf /backup/${backupSlug}.tar ./backup.json -O 2>/dev/null`.nothrow().text()).trim();
        backupVersion = JSON.parse(bjson)?.homeassistant_version ?? null;
      } catch { /* ignore */ }

      const versions = new Set<string>();
      if (latestVersion) versions.add(latestVersion);
      if (backupVersion) versions.add(backupVersion);
      // Also pull landing page (needed before real Core is ready)
      versions.add("landingpage");

      for (const ver of versions) {
        const img = `ghcr.io/home-assistant/${machine}-homeassistant:${ver}`;
        console.log("[sandbox] Pre-pulling:", img);
        progressCb(20, `Pulling HA Core image (${ver})…`);
        await $`docker -H unix://${DIND_SOCK} pull ${img}`.nothrow();
      }
      console.log("[sandbox] HA Core images pre-pulled");
    } catch (err) {
      console.warn("[sandbox] HA Core pre-pull failed (will download later):", err);
    }

    if (signal.aborted) throw new Error("Cancelled");

    // 6. Create inner hassio network (Supervisor hardcodes 172.30.32.0/23 with
    //    gateway 172.30.33.254).
    //
    // Routing strategy:
    //   172.30.32.0/23 dev eth0     — outer HA network (outer Supervisor, other addons)
    //   172.30.32.100/32 dev hassio — inner Supervisor (specific host route wins)
    //   DNAT OUTPUT 172.30.32.2:80 → 172.30.32.100:80 (iptables, see below)
    //
    // The Supervisor hardcodes DOCKER_IPV4_NETWORK_MASK[2]=172.30.32.2 as HASSIO env var
    // for HA Core. The DNAT rule redirects those calls to the inner Supervisor at
    // 172.30.32.100 instead of the outer one at 172.30.32.2 (which would 403).
    //
    // Save the addon's eth0 IP before bridge creation so we can restore the /23
    // route after Docker clobbers it.
    progressCb(25, "Setting up HA network…");
    const eth0Ip = (await $`ip -4 addr show eth0`.text()).match(/inet ([\d.]+)/)?.[1] ?? "";

    // Gateway MUST be 172.30.32.1 (= DOCKER_IPV4_NETWORK_MASK[1]).
    // The Supervisor's DNS plugin maps "homeassistant" → DOCKER_IPV4_NETWORK_MASK[1] = 172.30.32.1.
    // HA Core runs with --network=host and binds to 0.0.0.0:8123 in the addon's namespace.
    // By making 172.30.32.1 the hassio bridge IP in the addon's namespace, HA Core becomes
    // reachable at 172.30.32.1:8123 — the Supervisor can poll it, see CoreState.RUNNING,
    // and transition to its own RUNNING state (required for backup restore to succeed).
    await $`docker -H unix://${DIND_SOCK} network create \
      --driver bridge \
      --subnet 172.30.32.0/23 \
      --gateway 172.30.32.1 \
      --opt com.docker.network.bridge.name=hassio \
      hassio`
      .nothrow()
      .quiet();

    // Docker auto-adds 172.30.32.0/23 dev hassio which overwrites the outer HA
    // network route via eth0. Delete it, restore eth0, then add a precise host
    // route for the inner Supervisor's IP only.
    await $`ip route del 172.30.32.0/23 dev hassio`.nothrow().quiet();
    if (eth0Ip) {
      await $`ip route add 172.30.32.0/23 dev eth0 src ${eth0Ip}`.nothrow().quiet();
    }
    await $`ip route add 172.30.32.100/32 dev hassio`.nothrow().quiet();


    // DNAT: redirect inner HA Core's calls to 172.30.32.2:80 (which the Supervisor
    // hardcodes as HASSIO env var) to 172.30.32.100:80 (the actual inner Supervisor).
    // Without this, HA Core calls the OUTER Supervisor → 403 → hassio integration
    // fails → hassio.local backup agent never registers → backup restore fails.
    await $`iptables -t nat -A OUTPUT -d 172.30.32.2 -p tcp --dport 80 -j DNAT --to-destination 172.30.32.100:80`.nothrow().quiet();
    console.log("[sandbox] DNAT 172.30.32.2:80 → 172.30.32.100:80");

    console.log("[sandbox] hassio network ready");

    // 6b. Protect the Docker gateway so the Supervisor's health check passes.
    //     Without these rules, the system is marked unhealthy (docker_gateway_unprotected)
    //     and the BackupManager blocks all restore operations.
    await $`iptables -t raw -I PREROUTING -i lo -d 172.30.32.1 -j ACCEPT`.nothrow().quiet();
    await $`iptables -t raw -I PREROUTING ! -i hassio -d 172.30.32.1 -j DROP`.nothrow().quiet();
    console.log("[sandbox] Gateway firewall rules applied");

    if (signal.aborted) throw new Error("Cancelled");

    // 7. Start HA Supervisor (remove any leftover container from a previous run first)
    progressCb(30, "Starting HA Supervisor…");
    await $`docker -H unix://${DIND_SOCK} rm -f hassio_supervisor`.nothrow().quiet();

    await $`docker -H unix://${DIND_SOCK} run -d \
      --rm \
      --name hassio_supervisor \
      --network hassio \
      --ip 172.30.32.100 \
      --privileged \
      --security-opt apparmor=unconfined \
      --security-opt seccomp=unconfined \
      -e SUPERVISOR_SHARE=/mnt/newsd/supervisor \
      -e SUPERVISOR_NAME=hassio_supervisor \
      -e SUPERVISOR_MACHINE=${machine} \
      -e SUPERVISOR_WAIT_BOOT=180 \
      -v ${DIND_SOCK}:/run/docker.sock:rw \
      -v /mnt/newsd/supervisor:/data:rw \
      -v /etc/machine-id:/etc/machine-id:ro \
      ${SUPERVISOR_IMAGE}`;
    console.log("[sandbox] Supervisor container started");

    // Stream Supervisor logs to addon stdout for visibility in the HA log panel.
    Bun.spawn(
      ["docker", "-H", `unix://${DIND_SOCK}`, "logs", "-f", "--since", "0s", "hassio_supervisor"],
      { stdout: "inherit", stderr: "inherit" },
    );

    if (signal.aborted) throw new Error("Cancelled");

    // 8. Wait for HA Core to become accessible, then wait for the REAL Core
    //    (not the landing page placeholder) to start.
    //    Progress range: 40-90%.
    const coreUrl = `http://${SUPERVISOR_IP}:8123`;
    const CORE_READY_TIMEOUT = 30 * 60 * 1000; // 30 minutes (includes download)

    progressCb(40, "sandbox_status:Waiting for HA Core…");

    // 8a. Wait for HTTP 200 on port 8123 (landing page or real Core).
    await waitForHttp(coreUrl, CORE_READY_TIMEOUT);
    console.log("[sandbox] HA Core HTTP is up at", coreUrl);

    // Expose proxy URL immediately so the user can see the landing page.
    sandboxProxyUrl = coreUrl;

    // Stream HA Core logs alongside Supervisor logs for visibility.
    Bun.spawn(
      ["docker", "-H", `unix://${DIND_SOCK}`, "logs", "-f", "--since", "0s", "homeassistant"],
      { stdout: "inherit", stderr: "inherit" },
    );

    if (signal.aborted) throw new Error("Cancelled");

    // 8b. Wait for the REAL HA Core (not the landing page).
    //     The landing page is a placeholder that returns 401 for all API calls.
    //     We detect it by checking the Docker image tag.
    progressCb(45, "sandbox_status:Downloading HA Core image…");
    const realCoreStart = Date.now();
    while (true) {
      if (signal.aborted) throw new Error("Cancelled");
      if (Date.now() - realCoreStart > CORE_READY_TIMEOUT) {
        throw new Error("Timed out waiting for HA Core image download");
      }

      // Check if the homeassistant container is still the landing page
      const image = (await $`docker -H unix://${DIND_SOCK} inspect homeassistant --format {{.Config.Image}} 2>/dev/null`.nothrow().text()).trim();
      if (image && !image.includes(":landingpage")) {
        console.log("[sandbox] Real HA Core image detected:", image);
        break;
      }

      // Parse Supervisor logs for download progress
      const logs = (await $`docker -H unix://${DIND_SOCK} logs --tail 20 hassio_supervisor 2>&1`.nothrow().text()).trim();
      // Find the LAST download progress line (most recent percentage)
      const dlMatches = [...logs.matchAll(/Downloading Home Assistant Core image, (\d+)%/g)];
      const dlMatch = dlMatches.length > 0 ? dlMatches[dlMatches.length - 1] : null;
      if (dlMatch) {
        const dlPct = parseInt(dlMatch[1], 10);
        // Map download 0-100% to sandbox progress 45-80%
        const pct = Math.round(45 + (dlPct / 100) * 35);
        progressCb(pct, `sandbox_status:Downloading HA Core image… ${dlPct}%`);
      } else if (logs.includes("installation in progress")) {
        progressCb(45, "sandbox_status:Preparing HA Core installation…");
      }

      await new Promise((r) => setTimeout(r, 5_000));
    }

    // 8c. Real Core image is running — wait for it to be ready.
    progressCb(82, "sandbox_status:Starting HA Core…");
    console.log("[sandbox] Waiting for real HA Core to respond…");
    // The container restarts with the real image; wait for HTTP again.
    await new Promise((r) => setTimeout(r, 5_000)); // brief grace for container restart
    await waitForHttp(coreUrl, 5 * 60 * 1000);
    console.log("[sandbox] Real HA Core is ready");

    if (signal.aborted) throw new Error("Cancelled");

    // 8d. Wait for Supervisor RUNNING state.
    //     The Supervisor's _block_till_run() has a hardcoded 10-min timeout per cycle.
    //     It needs ~2 cycles (~20 min) before transitioning to RUNNING (onboarding mode
    //     means is_connected() always fails — auth tokens haven't been exchanged yet).
    //     The BackupManager is blocked until the Supervisor reaches RUNNING state.
    progressCb(85, "sandbox_status:Waiting for Supervisor…");
    await waitForSupervisorRunning(signal);

    if (signal.aborted) throw new Error("Cancelled");

    // 8e. Ignore the "healthy" job condition so backup restore isn't blocked.
    //     The DinD environment triggers docker_gateway_unprotected (no systemd to
    //     apply firewall rules), which blocks BackupManager operations.
    //     Get the Supervisor API token from the homeassistant container's env.
    try {
      const envJson = (await $`docker -H unix://${DIND_SOCK} inspect homeassistant --format json 2>/dev/null`.nothrow().text()).trim();
      const envVars: string[] = JSON.parse(envJson)?.[0]?.Config?.Env ?? [];
      const tokenLine = envVars.find((e: string) => e.startsWith("SUPERVISOR_TOKEN="));
      const supervisorToken = tokenLine?.split("=")[1]?.trim();
      if (supervisorToken) {
        await fetch("http://172.30.32.2/jobs/options", {
          method: "POST",
          headers: { Authorization: `Bearer ${supervisorToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ignore_conditions: ["healthy"] }),
          signal: AbortSignal.timeout(10_000),
        });
        console.log("[sandbox] Ignored healthy job condition for backup restore");
      } else {
        console.warn("[sandbox] Could not find SUPERVISOR_TOKEN in homeassistant env");
      }
    } catch (err) {
      console.warn("[sandbox] Failed to ignore healthy condition:", err);
    }

    progressCb(88, "sandbox_restoring");

    let autoRestoreFailed = false;
    if (backupSlug) {
      try {
        await autoRestoreBackup(backupSlug, progressCb);
      } catch (err) {
        // Non-fatal: show the sandbox panel with an error so the user can restore manually
        autoRestoreFailed = true;
        console.warn("[sandbox] Auto-restore failed, showing onboarding UI:", err);
      }
    }

    if (signal.aborted) throw new Error("Cancelled");

    const sandboxFinalDesc = autoRestoreFailed ? "sandbox_restore_failed" : "sandbox_ready";
    progressCb(99, sandboxFinalDesc);

    // 9. Wait for user to click "Done" (POST /api/sandbox/done → signalSandboxDone).
    //    Broadcast the current state every 5s so any freshly-connected WS client (e.g.
    //    after a page refresh) picks up the state without needing a dedicated poll.
    const readyInterval = setInterval(() => progressCb(99, sandboxFinalDesc), 5_000);
    try {
      await new Promise<void>((resolve) => {
        sandboxDoneResolve = resolve;
        // If the signal fires while waiting, resolve immediately so cleanup runs
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally {
      clearInterval(readyInterval);
    }

    progressCb(99, "Shutting down sandbox…");
  } finally {
    // 10. Graceful cleanup
    sandboxProxyUrl = null;
    sandboxDoneResolve = null;

    // Stop Supervisor container
    await $`docker -H unix://${DIND_SOCK} stop hassio_supervisor`.nothrow().quiet();

    // Stop inner dockerd
    if (dockerdProc) {
      dockerdProc.kill("SIGTERM");
      await Promise.race([dockerdProc.exited, new Promise<void>((r) => setTimeout(r, 15_000))]);
      try {
        dockerdProc.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }

    // Remove the MASQUERADE rules and inner Supervisor host route we added.
    // The 172.30.32.0/23 dev eth0 route is the outer HA network and should remain.
    // The 172.30.32.100/32 dev hassio route is auto-removed when the hassio bridge
    // disappears, but we delete it explicitly to be clean.
    await $`iptables -t nat -D POSTROUTING -s 172.30.32.0/23 -o eth0 -j MASQUERADE`.nothrow().quiet();
    await $`iptables -t nat -D POSTROUTING -s 10.99.99.0/24 -o eth0 -j MASQUERADE`.nothrow().quiet();
    await $`iptables -t nat -D OUTPUT -d 172.30.32.2 -p tcp --dport 80 -j DNAT --to-destination 172.30.32.100:80`.nothrow().quiet();
    await $`ip route del 172.30.32.100/32 dev hassio`.nothrow().quiet();
    await $`iptables -t raw -D PREROUTING -i lo -d 172.30.32.1 -j ACCEPT`.nothrow().quiet();
    await $`iptables -t raw -D PREROUTING ! -i hassio -d 172.30.32.1 -j DROP`.nothrow().quiet();
    console.log("[sandbox] iptables/route cleanup done");

    // Flush and unmount
    await unmountSafe();
    await teardownLoop();

    // Ensure securityfs is mounted — the inner dockerd can unmount it as a
    // side-effect of mount namespace cleanup, which breaks AppArmor on the host.
    await $`mount -t securityfs securityfs /sys/kernel/security`.nothrow().quiet();
  }
}
