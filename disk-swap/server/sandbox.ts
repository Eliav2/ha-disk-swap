import { $ } from "bun";
import { readdir, stat } from "node:fs/promises";
import { findDataPartition, getPartitionGeometry } from "./injector.ts";

const DATA_MOUNT = "/mnt/newsd";
const LOOP_DEV = "/dev/loop0";
const DIND_SOCK = "/run/dind.sock";

// Map uname -m to the HA supervisor image arch prefix
const ARCH_MAP: Record<string, string> = {
  aarch64: "aarch64",
  x86_64: "amd64",
};

// Lazy arch detection — top-level `await $\`uname -m\`` would block module load and
// take the whole server down if uname is slow/unavailable. Cached after first call.
let cachedArch: string | null = null;
async function getSupervisorArch(): Promise<string> {
  if (cachedArch) return cachedArch;
  const rawArch = (await $`uname -m`.text()).trim();
  cachedArch = ARCH_MAP[rawArch] ?? rawArch;
  return cachedArch;
}
async function getSupervisorImage(): Promise<string> {
  return `ghcr.io/home-assistant/${await getSupervisorArch()}-hassio-supervisor:latest`;
}

/** True if the image already exists in the inner dockerd's local store. */
async function imageExists(image: string): Promise<boolean> {
  const res = await $`docker -H unix://${DIND_SOCK} image inspect ${image}`.nothrow().quiet();
  return res.exitCode === 0;
}

/**
 * Pull an image, tolerant of flaky external DNS / registry reachability.
 *
 * The inner dockerd's data-root lives on the target disk (/mnt/newsd/docker) and
 * persists across runs, so on any re-run the image is usually already cached. A
 * single ghcr.io timeout used to hard-fail the whole sandbox at the Supervisor
 * pull (no .nothrow(), no retry). Now:
 *   - if `skipIfPresent` and the image is already local, skip the registry hit
 *     entirely (bulletproof against DNS blips on re-runs);
 *   - otherwise retry the pull a few times before giving up;
 *   - if all pulls fail but the image is cached locally, fall back to the cache.
 * Throws only when the image is neither pullable nor cached.
 */
async function pullImage(image: string, opts: { skipIfPresent?: boolean; attempts?: number } = {}): Promise<void> {
  const { skipIfPresent = true, attempts = 3 } = opts;
  if (skipIfPresent && (await imageExists(image))) {
    console.log(`[sandbox] Using cached image ${image} (skipping pull)`);
    return;
  }
  for (let i = 1; i <= attempts; i++) {
    const res = await $`docker -H unix://${DIND_SOCK} pull ${image}`.nothrow();
    if (res.exitCode === 0) return;
    console.warn(`[sandbox] Pull of ${image} failed (attempt ${i}/${attempts}): ${res.stderr.toString().trim()}`);
  }
  // Last resort: a previously-cached copy is fine for a sandbox test.
  if (await imageExists(image)) {
    console.warn(`[sandbox] Pull failed but ${image} is cached locally — using cached copy`);
    return;
  }
  throw new Error(`Failed to pull ${image} after ${attempts} attempts and no cached copy exists`);
}

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

/** Returns a promise that resolves the next time `signalSandboxDone()` is called.
 *  Used by the dev-mode sandbox fake in clone.ts so the drawer's Done button
 *  actually finishes the fake stage instead of hanging. */
export function awaitSandboxDone(): Promise<void> {
  return new Promise((resolve) => {
    sandboxDoneResolve = resolve;
  });
}

/**
 * Scan the mounted data partition's /supervisor/backup/ for the most-recently
 * written backup tar and return its slug (from backup.json, falling back to
 * the filename). Returns null if the directory is missing or empty.
 *
 * Used by sandbox-only mode (clone.ts passes empty backupSlug) so booting an
 * already-cloned disk auto-restores the user's data instead of dumping them
 * onto fresh-onboarding.
 */
async function findInjectedBackup(): Promise<string | null> {
  const backupDir = `${DATA_MOUNT}/supervisor/backup`;
  let entries: string[];
  try {
    entries = (await readdir(backupDir)).filter((f) => f.endsWith(".tar"));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;

  const stamped = await Promise.all(
    entries.map(async (f) => {
      const s = await stat(`${backupDir}/${f}`);
      return { f, mtime: s.mtimeMs };
    }),
  );
  stamped.sort((a, b) => b.mtime - a.mtime);
  const newest = stamped[0].f;

  // Prefer the slug declared inside backup.json (the canonical HA backup ID);
  // fall back to the filename stem if the tar can't be inspected.
  try {
    const json = (
      await $`tar -xf ${backupDir}/${newest} ./backup.json -O`.nothrow().text()
    ).trim();
    if (json) {
      const meta = JSON.parse(json);
      if (meta?.slug) return meta.slug as string;
    }
  } catch {
    /* fall through */
  }
  return newest.replace(/\.tar$/, "");
}

/**
 * Decide whether the mounted data partition already holds a FULLY RESTORED,
 * onboarded HA config — the marker used to fast-path past the ~20-min restore.
 *
 * A *fresh* HA boot writes `.HA_VERSION` and a `.storage/` with system-only users
 * ("Home Assistant Content", "Supervisor") but NO completed onboarding, so neither
 * of those is a reliable "restored" signal. The authoritative marker is
 * `.storage/onboarding` listing the `user` step as done — it only exists once a
 * real backup restore (or finalize-from-backup) has produced an onboarded instance
 * with a human owner. Checking it offline (disk not booted) keeps the fast-path
 * honest: a disk whose restore never succeeded will correctly fall through to a
 * real restore instead of booting forever into the onboarding wizard.
 */
async function isRestoredOnboardedConfig(): Promise<boolean> {
  const storage = `${DATA_MOUNT}/supervisor/homeassistant/.storage`;
  try {
    // (1) onboarding marker must list the `user` step as done.
    const onboarding = await Bun.file(`${storage}/onboarding`).json();
    const done: unknown = onboarding?.data?.done;
    if (!Array.isArray(done) || !done.includes("user")) return false;

    // (2) auth must contain a REAL human owner — not just the auto-generated
    // system users ("Home Assistant Content", "Supervisor"). This guards against
    // the finalize-from-backup failure mode where the onboarding marker got
    // stamped but the actual restore never brought the owner account over, which
    // would otherwise fast-path forever into an unloggable instance.
    const auth = await Bun.file(`${storage}/auth`).json();
    const users: unknown = auth?.data?.users;
    if (!Array.isArray(users)) return false;
    return users.some(
      (u) => u?.is_owner === true && u?.system_generated === false,
    );
  } catch {
    return false;
  }
}

/** Returns the URL of the running HA Core instance for proxying, or null if not ready. */
export function getSandboxProxyUrl(): string | null {
  return sandboxProxyUrl;
}

/**
 * THE FIX for the inner-HA iframe spinner / flaky-on-reload bug.
 *
 * The inner hassio bridge gateway 172.30.32.1 (forced by the Supervisor) collides
 * with the addon's REAL default gateway, also 172.30.32.1. While .1 is locally
 * assigned to hassio it shadows the gateway, so the :8124 proxy's replies to the
 * (off-subnet) browser are black-holed → the iframe never gets its /api/onboarding
 * response → eternal spinner (worse on reload, where the cached shell masks it).
 *
 * .1 is needed DURING setup/restore (the inner Supervisor must reach HA Core at
 * .1, and HA Core must reach the inner Supervisor authorized as src .1). Once HA
 * Core is up and any restore is done, the browser :8124 view itself only needs
 * HA Core over loopback (127.0.0.1:8123) — but the inner Supervisor still wants
 * to reach HA Core at .1 (else it may mark Core unhealthy and restart it). So we
 * don't just drop .1: we first re-establish Core↔Supervisor connectivity WITHOUT
 * a local .1, then remove the local address:
 *   - proxy-ARP on hassio so the addon still answers ARP for .1 from inner
 *     containers,
 *   - DNAT inbound hassio traffic for .1 → the addon's eth0 IP, where HA Core
 *     listens via --network=host (0.0.0.0:8123),
 *   - SNAT Core/addon → inner-Supervisor (172.30.32.2) to source .1 (the only
 *     source it authorizes), replacing the old `src 172.30.32.1` route which
 *     needs .1 local,
 *   - then remove .1 from hassio → the addon's real default gateway is usable
 *     again → browser return path works.
 * The Supervisor has finished its network migration by now and does not re-add .1
 * (verified), so this is stable for the life of the sandbox.
 */
async function freeOuterGateway(eth0Ip: string): Promise<void> {
  const addr = await $`ip -4 addr show hassio`.nothrow().text();
  if (!addr.includes("172.30.32.1")) return;
  // Keep HA Core reachable at .1 for the inner Supervisor without a local .1.
  // -C/-A guards keep these idempotent across repeat sandbox runs.
  await $`sh -c ${"echo 1 > /proc/sys/net/ipv4/conf/hassio/proxy_arp"}`.nothrow().quiet();
  if (eth0Ip) {
    await $`sh -c ${`iptables -t nat -C PREROUTING -i hassio -d 172.30.32.1 -j DNAT --to-destination ${eth0Ip} 2>/dev/null || iptables -t nat -A PREROUTING -i hassio -d 172.30.32.1 -j DNAT --to-destination ${eth0Ip}`}`.nothrow().quiet();
  }
  // Core/addon → inner Supervisor must still appear to come from .1 (authorized).
  await $`sh -c ${"iptables -t nat -C POSTROUTING -o hassio -d 172.30.32.2 -j SNAT --to-source 172.30.32.1 2>/dev/null || iptables -t nat -A POSTROUTING -o hassio -d 172.30.32.2 -j SNAT --to-source 172.30.32.1"}`.nothrow().quiet();
  // The old policy route uses `src 172.30.32.1` (now invalid); drop the src, the
  // SNAT above supplies the .1 source instead.
  await $`ip route replace 172.30.32.2 dev hassio table 103`.nothrow().quiet();
  // Now free the colliding gateway IP → browser :8124 return path is unblocked.
  await $`ip addr del 172.30.32.1/23 dev hassio`.nothrow().quiet();
  console.log("[sandbox] Freed outer gateway (.1 removed; Core↔Supervisor kept via proxy-ARP+DNAT+SNAT) — browser :8124 path unblocked");
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
    // Clamp the inner bridge MTU below the default 1500. The image pull traverses
    // nested bridges (inner docker → hassio bridge → HA OS → in dev, UTM NAT),
    // and PMTU discovery is blackholed across them (ICMP frag-needed dropped), so
    // full-1500 packets on a large layer silently vanish → the TCP connection
    // stalls with no EOF, so Docker's download-retry never fires and the pull
    // hangs forever. 1400 stays under every hop's MTU and keeps big pulls flowing.
    mtu: 1400,
    // A stalled/dropped layer should be retried hard rather than wedging the pull.
    "max-download-attempts": 10,
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

/**
 * Poll supervisor logs until it reports RUNNING state (up to 25 min).
 *
 * `progressCb` (optional) is called every ~10s with a (percent, description) tuple
 * so the UI can show meaningful state during the long wait — see
 * STARTUP_API_RESPONSE_TIMEOUT in HA Supervisor: in onboarding mode the
 * Supervisor needs ~2 × 10-min cycles before transitioning to RUNNING because
 * `hassio` integration is absent and `is_connected()` always fails. We detect
 * which cycle we're in by counting the "Can't start Home Assistant Core" log
 * lines (Supervisor's own typo: "rebuiling") and linearly bump the progress
 * percent between 85 and 95 so the bar visibly moves.
 */
async function waitForSupervisorRunning(
  signal: AbortSignal,
  progressCb?: (percent: number, description: string) => void,
): Promise<void> {
  const start = Date.now();
  const totalMs = 20 * 60 * 1000; // typical onboarding wait
  const deadline = start + 25 * 60 * 1000;
  const expectedCycles = 2;
  let lastTick = 0;

  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("Cancelled");

    // Re-assert the inner-Supervisor policy route on every poll. The Supervisor
    // reconfigures the hassio bridge during its own boot ("Migrating Supervisor
    // network…", "Connecting Supervisor to hassio-network"), which can wipe a
    // one-shot route added right after container start. Re-asserting here (cheap,
    // idempotent `ip route replace`) guarantees the route is present and stable
    // for the rest of the wait, so HA Core's hassio integration connects and
    // registers the hassio.local backup agent well before restore is triggered.
    await ensureInnerSupervisorRoute(2_000);

    const logs = await $`docker -H unix://${DIND_SOCK} logs --tail 100 hassio_supervisor 2>&1`.nothrow().text();
    if (logs.includes("Supervisor is up and running")) {
      console.log("[sandbox] Supervisor reached RUNNING state");
      return;
    }

    if (progressCb && Date.now() - lastTick >= 10_000) {
      lastTick = Date.now();
      const elapsedSec = Math.floor((Date.now() - start) / 1000);
      const remainingSec = Math.max(Math.floor((totalMs - (Date.now() - start)) / 1000), 30);
      const cyclesDone = (logs.match(/Can't start Home Assistant Core/g) ?? []).length;
      const cycleNum = Math.min(cyclesDone + 1, expectedCycles);
      const remainingMin = Math.ceil(remainingSec / 60);
      const percent = 85 + Math.min(10, Math.round((elapsedSec / (totalMs / 1000)) * 10));
      progressCb(
        percent,
        `sandbox_status:Waiting for Supervisor (boot cycle ${cycleNum}/${expectedCycles}, ~${remainingMin} min remaining)…`,
      );
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
 * Wait until HA Core's HTTP API layer is actually serving — not just the web
 * server answering `/`.
 *
 * Why this exists (the eternal-spinner bug): `waitForHttp` returns as soon as
 * `GET /` is 200, but HA Core keeps returning **503** on API routes like
 * `/api/onboarding` for a startup window AFTER `/` already serves the frontend.
 * The onboarding frontend fetches `/api/onboarding` exactly once on load; if it
 * lands in that 503 window it sticks on the loading spinner forever (no retry).
 * The iframe auto-opens at `sandbox_ready`, so declaring ready before the API is
 * warm is what made the inner UI hang intermittently. Gate `sandbox_ready` on a
 * non-503 from `/api/onboarding`: 200 (onboarding pending) / 401 / 404 (already
 * onboarded) all mean "API is up"; only 503 means "still starting".
 */
async function waitForCoreApiReady(coreUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${coreUrl}/api/onboarding`, { signal: AbortSignal.timeout(3000) });
      if (res.status !== 503) {
        console.log(`[sandbox] Core API serving (/api/onboarding → ${res.status})`);
        return;
      }
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.warn(`[sandbox] Core API still 503 after ${timeoutMs}ms — proceeding anyway`);
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
 * (Re)install the policy route that makes addon + HA-Core traffic to the inner
 * Supervisor (172.30.32.2:80) egress via the hassio bridge with source IP
 * 172.30.32.1 — the only source the inner Supervisor authorizes. Idempotent and
 * verified; returns true once the route is confirmed present in table 103.
 *
 * Why it must wait+retry (this was the long-standing restore bug): Docker assigns
 * the bridge gateway IP (172.30.32.1) to the host-side `hassio` interface only
 * once an endpoint joins the network — i.e. AFTER the Supervisor container starts,
 * not at `docker network create` time. `ip route add … src 172.30.32.1` fails with
 * "Cannot assign requested address" until then. If added too early (with the error
 * swallowed), table 103 stays empty, every .2:80 packet falls through to the main
 * table and exits via eth0 to the OUTER Supervisor, and HA Core's hassio integration
 * gets 403 → never registers the hassio.local backup agent → onboarding restore
 * returns 500 indefinitely.
 */
async function ensureInnerSupervisorRoute(timeoutMs = 60_000): Promise<boolean> {
  // mark + rule don't depend on the bridge IP; (re)add idempotently.
  const markExists =
    (await $`iptables -t mangle -C OUTPUT -d 172.30.32.2 -p tcp --dport 80 -j MARK --set-mark 4`
      .nothrow()
      .quiet()).exitCode === 0;
  if (!markExists) {
    await $`iptables -t mangle -A OUTPUT -d 172.30.32.2 -p tcp --dport 80 -j MARK --set-mark 4`.nothrow().quiet();
  }
  const rules = await $`ip rule show`.nothrow().text();
  if (!rules.includes("fwmark 0x4")) {
    await $`ip rule add fwmark 4 lookup 103`.nothrow().quiet();
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const addr = await $`ip -4 addr show hassio`.nothrow().text();
    if (addr.includes("172.30.32.1")) {
      // `replace` is idempotent (add-or-update).
      await $`ip route replace 172.30.32.2 dev hassio src 172.30.32.1 table 103`.nothrow().quiet();
      const tbl = await $`ip route show table 103`.nothrow().text();
      if (tbl.includes("172.30.32.2")) return true;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

/**
 * True if HA Core's exact network path to the inner Supervisor works AND auth is
 * accepted (HTTP 200). A 403 here means traffic is reaching the OUTER Supervisor
 * via eth0 — i.e. the policy route in table 103 is missing or wrong. Checked from
 * inside the homeassistant container, the precise context HA Core's hassio
 * integration uses to talk to the Supervisor.
 */
async function innerSupervisorAuthOk(): Promise<boolean> {
  const code = (
    await $`docker -H unix://${DIND_SOCK} exec homeassistant sh -c ${'curl -s -o /dev/null -w "%{http_code}" --max-time 5 -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://172.30.32.2/supervisor/info'}`
      .nothrow()
      .text()
  ).trim();
  return code.startsWith("200");
}

/**
 * Whether HA Core considers onboarding complete. HA removes the /api/onboarding
 * routes once onboarding is done, so 404 (or 401) === onboarded. A 200 JSON
 * response with the "user" step not done === still in the onboarding wizard.
 * Polls briefly to ride out the post-restart window where the HTTP server is up
 * but routes aren't registered yet.
 */
async function isOnboarded(coreUrl: string): Promise<boolean> {
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`${coreUrl}/api/onboarding`, {
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    if (res && (res.status === 404 || res.status === 401)) return true;
    if (res?.ok && (res.headers.get("content-type") ?? "").includes("json")) {
      const steps = await res.json().catch(() => null);
      if (Array.isArray(steps)) {
        // Onboarding state is file-backed (stable), so a clean JSON answer is
        // authoritative — no need to keep polling once we have one.
        return steps.find((s) => s?.step === "user")?.done === true;
      }
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return false;
}

/**
 * HA's onboarding-backup-restore restores everything (auth, registries, DB) but
 * drops `.storage/onboarding`, so the instance boots back into the onboarding
 * wizard despite all the user's data being present. Finalize it using the marker
 * from the user's OWN backup (not a fabricated one): extract data/.storage/onboarding
 * from the backup's homeassistant.tar.gz, drop it in while HA Core is stopped, then
 * restart and re-verify. Returns true once the instance is confirmed onboarded.
 */
async function finalizeOnboardingFromBackup(backupSlug: string, coreUrl: string): Promise<boolean> {
  const backupTar = `${DATA_MOUNT}/supervisor/backup/${backupSlug}.tar`;
  const haStorage = `${DATA_MOUNT}/supervisor/homeassistant/.storage`;
  if (!(await Bun.file(backupTar).exists())) {
    console.warn(`[sandbox] Cannot finalize onboarding — backup tar not found at ${backupTar}`);
    return false;
  }
  // Guard against masking a FAILED restore: only stamp the onboarding marker if
  // the actual auth data was restored (a real human owner exists). Otherwise we'd
  // produce an instance that *looks* onboarded but has no account to log into —
  // the exact false-success that hides a blocked/failed restore. If the owner
  // isn't here, the restore genuinely didn't work; surface that instead.
  const authStorage = `${DATA_MOUNT}/supervisor/homeassistant/.storage/auth`;
  const hasOwner = await Bun.file(authStorage)
    .json()
    .then((a) => Array.isArray(a?.data?.users) && a.data.users.some((u: { is_owner?: boolean; system_generated?: boolean }) => u?.is_owner === true && u?.system_generated === false))
    .catch(() => false);
  if (!hasOwner) {
    console.warn("[sandbox] Refusing to finalize onboarding — no human owner in restored auth (the restore did not actually bring the user's account; not masking it)");
    return false;
  }

  const work = "/tmp/ob-finalize";
  await $`rm -rf ${work}`.nothrow().quiet();
  await $`mkdir -p ${work}`.nothrow().quiet();
  await $`tar xf ${backupTar} -C ${work} homeassistant.tar.gz`.nothrow().quiet();
  await $`tar xzf ${work}/homeassistant.tar.gz -C ${work} data/.storage/onboarding`.nothrow().quiet();
  if (!(await Bun.file(`${work}/data/.storage/onboarding`).exists())) {
    console.warn("[sandbox] Backup has no .storage/onboarding marker — cannot finalize");
    await $`rm -rf ${work}`.nothrow().quiet();
    return false;
  }
  // Stop HA Core so it doesn't overwrite .storage mid-copy, drop the marker, restart.
  await $`docker -H unix://${DIND_SOCK} stop homeassistant`.nothrow().quiet();
  await $`cp ${work}/data/.storage/onboarding ${haStorage}/onboarding`.nothrow().quiet();
  await $`rm -rf ${work}`.nothrow().quiet();
  await $`docker -H unix://${DIND_SOCK} start homeassistant`.nothrow().quiet();
  await new Promise((r) => setTimeout(r, 8_000));
  await waitForHttp(coreUrl, 5 * 60 * 1000);
  return await isOnboarded(coreUrl);
}

/**
 * Automatically restore the injected backup via the HA onboarding API.
 *
 * This must be called BEFORE the user manually completes onboarding (i.e. before
 * POST /api/onboarding/users). The onboarding restore path bypasses the Supervisor
 * "startup" state check that blocks the regular POST /backups/{slug}/restore/full.
 *
 * agent_id "hassio.local" is the Supervisor's local storage (.local location).
 *
 * Throws if the restore can't be verified as a fully onboarded instance — the
 * caller surfaces that as sandbox_restore_failed (manual-restore fallback in UI).
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

  // Pre-flight gate: the restore needs HA Core's hassio.local backup agent, which
  // only registers when HA Core's hassio integration can authenticate against the
  // INNER Supervisor. Make sure the policy route is in place, then wait until that
  // path actually returns 200 (a 403 means we're hitting the outer Supervisor via
  // eth0). Without this gate the loop below just hammers a doomed 500 for 60s.
  await ensureInnerSupervisorRoute();
  let authOk = false;
  for (let i = 0; i < 30; i++) {
    if (await innerSupervisorAuthOk()) { authOk = true; break; }
    if (i === 0) console.log("[sandbox] Waiting for HA Core → inner-Supervisor auth path (hassio.local agent)…");
    await new Promise((r) => setTimeout(r, 2_000));
  }
  if (authOk) console.log("[sandbox] Inner-Supervisor auth path OK — hassio.local agent should be registered");
  else console.warn("[sandbox] Auth path still failing after wait — will attempt restore with HA Core restart fallback");

  // Trigger restore via the onboarding API — no auth token required.
  // Retry up to 40× with a self-healing strategy:
  //   - transient 400-blocked/404/503 → wait and retry
  //   - 500 with the auth path confirmed OK → the hassio.local agent didn't
  //     register on this Core boot; restart HA Core ONCE to force re-registration
  //   - 500 with the auth path failing → repair the route and retry
  // HA Core may go offline before sending the response; swallow network errors.
  let res: Response | null = null;
  let restartedCore = false;
  let consecutive500 = 0;
  const MAX_ATTEMPTS = 40;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    res = await fetch(`${coreUrl}/api/onboarding/backup/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backup_id: backupSlug, agent_id: "hassio.local" }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);

    if (!res || res.ok) break; // success or network error (HA restarting → done)

    const body = await res.text().catch(() => "");
    if (res.status === 400 && body.includes("blocked")) {
      consecutive500 = 0;
      console.log(`[sandbox] Backup manager blocked, retrying in 3s (attempt ${attempt + 1}/${MAX_ATTEMPTS})…`);
      await new Promise((r) => setTimeout(r, 3_000));
      continue;
    }

    if (res.status === 500) {
      consecutive500++;
      // A 500 here is almost always "hassio.local agent not registered". If the
      // auth path is healthy but the agent still isn't there after a few tries,
      // the integration missed registration on this boot — restart HA Core once.
      const pathOk = await innerSupervisorAuthOk();
      if (!pathOk) {
        console.log(`[sandbox] Restore 500 + auth path down — repairing route (attempt ${attempt + 1}/${MAX_ATTEMPTS})…`);
        await ensureInnerSupervisorRoute();
        await new Promise((r) => setTimeout(r, 3_000));
        continue;
      }
      if (!restartedCore && consecutive500 >= 3) {
        console.log("[sandbox] Restore 500 with healthy auth path — restarting HA Core once to force hassio.local agent registration…");
        await $`docker -H unix://${DIND_SOCK} restart homeassistant`.nothrow().quiet();
        restartedCore = true;
        consecutive500 = 0;
        // Wait for Core back up, then re-confirm the auth path before retrying.
        await new Promise((r) => setTimeout(r, 8_000));
        await waitForHttp(coreUrl, 5 * 60 * 1000);
        for (let i = 0; i < 30 && !(await innerSupervisorAuthOk()); i++) {
          await new Promise((r) => setTimeout(r, 2_000));
        }
        continue;
      }
      console.log(`[sandbox] Restore returned 500, retrying in 3s (attempt ${attempt + 1}/${MAX_ATTEMPTS})…`);
      await new Promise((r) => setTimeout(r, 3_000));
      continue;
    }

    if (res.status === 404 || res.status === 503) {
      // HA Core integrations load asynchronously: 404 = onboarding routes not
      // registered yet; 503 = service unavailable. Transient — wait and retry.
      consecutive500 = 0;
      console.log(`[sandbox] Restore returned ${res.status}, retrying in 3s (attempt ${attempt + 1}/${MAX_ATTEMPTS})…`);
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
  progressCb(90, "sandbox_restoring");

  // HA shuts down within ~5s of restore being triggered, then comes back up.
  // After restore the Supervisor may need to pull a different Core version
  // (backup version != latest), which can take time in DinD. Use 15-min timeout.
  await new Promise((r) => setTimeout(r, 8_000));
  await waitForHttp(coreUrl, 15 * 60 * 1000);
  console.log("[sandbox] HA Core back online after restore");

  // VERIFY the restore actually produced a usable, onboarded instance. A restore
  // can "succeed" (files written) yet boot back into the onboarding wizard because
  // HA's onboarding-restore drops .storage/onboarding. Only a verified-onboarded
  // instance counts as success — otherwise the user just sees onboarding again.
  progressCb(95, "sandbox_verifying");
  console.log("[sandbox] Verifying restored instance is onboarded…");
  if (await isOnboarded(coreUrl)) {
    console.log("[sandbox] Verified: instance is onboarded — restore complete");
    return;
  }

  console.warn("[sandbox] Still in onboarding after restore — finalizing from backup marker…");
  if (await finalizeOnboardingFromBackup(backupSlug, coreUrl)) {
    console.log("[sandbox] Verified: onboarding finalized from backup — restore complete");
    return;
  }

  throw new Error("Restore completed but the instance is still in onboarding (could not finalize)");
}

export async function runSandboxStage(
  devicePath: string,
  machine: string,
  initialBackupSlug: string,
  progressCb: (percent: number, description?: string) => void,
  signal: AbortSignal,
  // When true, never restore: don't auto-detect an injected backup and skip the
  // restore/verify steps entirely. Boots the inner HA against the disk as a fast
  // (~5 min) sanity check that the cloned OS comes up — shows a fresh HA.
  noRestore = false,
): Promise<void> {
  // Local var: we may discover an injected backup on the data partition (when
  // the caller passed "" from sandbox-only mode) and want to point auto-restore
  // at it.
  let backupSlug = initialBackupSlug;
  // Reset module-level state
  sandboxDoneResolve = null;
  sandboxProxyUrl = null;

  let dockerdProc: ReturnType<typeof Bun.spawn> | null = null;
  // Snapshot /etc/resolv.conf so we can restore it on cleanup. The sandbox stage
  // overwrites it with 8.8.8.8 (see step 4 below); without restoring, all
  // subsequent Supervisor API calls (http://supervisor) lose their DNS resolver
  // until the addon container restarts.
  let originalResolvConf: string | null = null;
  try {
    originalResolvConf = await Bun.file("/etc/resolv.conf").text();
  } catch {
    /* file unreadable — restore step will skip */
  }

  try {
    // 1. Mount target disk's data partition via loop device
    progressCb(0, "Mounting data partition…");
    await $`partprobe ${devicePath}`.nothrow().quiet();
    await $`udevadm settle --timeout=5`.nothrow().quiet();
    await setupLoop(devicePath);
    await mountPartition();

    // If the data partition already holds a FULLY RESTORED HA config, skip both
    // the homeassistant wipe AND the auto-restore on this run — boot directly into
    // the existing state. Saves the ~20-min Supervisor-RUNNING + restore cycle on
    // repeat sandbox-only iterations against the same disk.
    //
    // The marker is `.storage/onboarding` with the `user` step done — NOT just
    // `.HA_VERSION`. A *fresh* HA boot also writes `.HA_VERSION` (plus a `.storage`
    // with system-only users), so `.HA_VERSION` alone wrongly fast-paths a disk
    // whose restore never actually succeeded — leaving the user stuck on the
    // onboarding wizard forever. The onboarding marker only exists once a real
    // restore (or finalize-from-backup) has produced an onboarded instance.
    const hasRestoredConfig = await isRestoredOnboardedConfig();
    if (hasRestoredConfig) {
      console.log("[sandbox] Found existing fully-restored HA config (onboarding complete) — booting directly without re-restore");
    } else if (await Bun.file(`${DATA_MOUNT}/supervisor/homeassistant/.HA_VERSION`).exists()) {
      console.log("[sandbox] Data partition has a prior HA config but onboarding is incomplete (fresh/failed restore) — will restore the injected backup");
    }

    // If the caller didn't specify a backup slug (sandbox-only mode), look on
    // the data partition for one already injected by a previous clone — when
    // present, we want to auto-restore it instead of showing fresh onboarding.
    // Skip detection when we already have a restored config — there's nothing
    // to restore into.
    if (noRestore) {
      console.log("[sandbox] No-restore mode — booting the cloned OS without restoring any backup");
      backupSlug = "";
    } else if (!backupSlug && !hasRestoredConfig) {
      const detected = await findInjectedBackup();
      if (detected) {
        backupSlug = detected;
        console.log(`[sandbox] Auto-detected injected backup: ${backupSlug}`);
      } else {
        console.log("[sandbox] No injected backup found — fresh onboarding mode");
      }
    }

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
    // /run/supervisor   — must be a directory (Supervisor 2026.5+ bind-mounts this into
    //                     HA Core; without it, HA Core creation fails with
    //                     "invalid mount config for type bind: bind source path does not exist")
    // /etc/machine-id   — must be a FILE; Docker creates an empty directory placeholder
    //                     when the host bind-mount source is missing, which causes
    //                     IsADirectoryError / "bind source does not exist" on child starts
    // /run/docker.sock  — must be a socket/file; our inner dockerd listens on
    //                     /run/dind.sock, so symlink the standard path to it so the
    //                     Observer plugin can connect
    await $`mkdir -p /run/dbus /run/supervisor`.nothrow().quiet();
    await $`sh -c '[ -d /etc/machine-id ] && rm -rf /etc/machine-id; true'`.nothrow().quiet();
    await Bun.write("/etc/machine-id", crypto.randomUUID().replace(/-/g, "") + "\n");
    await $`ln -sf ${DIND_SOCK} /run/docker.sock`.nothrow().quiet();
    await $`touch /mnt/newsd/supervisor/cid_files/homeassistant.cid`.nothrow().quiet();
    await $`rm -f /mnt/newsd/supervisor/config.json`.nothrow().quiet();
    // Only wipe the homeassistant config dir when we're going to re-restore;
    // otherwise we'd throw away the previously-restored state and force a full
    // 20-min Supervisor cycle again.
    if (!hasRestoredConfig) {
      await $`rm -rf /mnt/newsd/supervisor/homeassistant`.nothrow().quiet();
    }

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
      // inherit so dockerd output reaches the addon log (and is captured in the
      // ring buffer surfaced by /api/logs). Previously written to /tmp/dind.log
      // which was invisible from the UI on failure.
      { stdout: "inherit", stderr: "inherit" },
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
    const supervisorImage = await getSupervisorImage();
    await pullImage(supervisorImage);
    console.log("[sandbox] Supervisor image ready");

    // Pre-pull ALL images the Supervisor needs while DNS still works
    // (before hassio_dns takes over and makes pulls extremely slow).
    progressCb(20, "Pulling HA images (this may take a few minutes)…");
    try {
      const versionJson = await fetch("https://version.home-assistant.io/stable.json", {
        signal: AbortSignal.timeout(15_000),
      }).then((r) => r.json()) as Record<string, any>;

      // Determine architecture from Supervisor image template
      const arch = (versionJson?.images?.cli as string)?.match(/\{arch\}/)?.[0]
        ? (supervisorImage.match(/ghcr\.io\/home-assistant\/(\w+)-hassio/)?.[1] ?? "aarch64")
        : "aarch64";

      // HA Core: latest + backup version + landing page
      const coreImages: string[] = [];
      const latestVersion = versionJson?.homeassistant?.[machine];
      if (latestVersion) coreImages.push(`ghcr.io/home-assistant/${machine}-homeassistant:${latestVersion}`);
      let backupVersion: string | null = null;
      try {
        const bjson = (await $`tar -xf /backup/${backupSlug}.tar ./backup.json -O 2>/dev/null`.nothrow().text()).trim();
        const meta = JSON.parse(bjson);
        backupVersion = meta?.homeassistant?.version ?? meta?.homeassistant_version ?? null;
      } catch { /* ignore */ }
      if (backupVersion && backupVersion !== latestVersion) {
        coreImages.push(`ghcr.io/home-assistant/${machine}-homeassistant:${backupVersion}`);
      }
      coreImages.push(`ghcr.io/home-assistant/${machine}-homeassistant:landingpage`);

      // Supervisor plugins: cli, dns, observer, multicast, audio
      const plugins = ["cli", "dns", "observer", "multicast", "audio"];
      const pluginImages = plugins
        .map((p) => {
          const ver = versionJson?.[p];
          return ver ? `ghcr.io/home-assistant/${arch}-hassio-${p}:${ver}` : null;
        })
        .filter((img): img is string => img != null);

      const allImages = [...coreImages, ...pluginImages];
      for (let i = 0; i < allImages.length; i++) {
        const img = allImages[i];
        const label = img.split("/").pop() ?? img;
        progressCb(15 + Math.round((i / allImages.length) * 15), `Pulling ${label}…`);
        console.log("[sandbox] Pre-pulling:", img);
        // Non-fatal pre-pull: skip if cached, retry transient registry blips.
        await pullImage(img, { attempts: 2 }).catch((e) =>
          console.warn(`[sandbox] Pre-pull of ${img} failed (non-fatal):`, String(e)),
        );
      }
      console.log("[sandbox] All images pre-pulled");
    } catch (err) {
      console.warn("[sandbox] Image pre-pull failed (will download later):", err);
    }

    if (signal.aborted) throw new Error("Cancelled");

    // 6. Create inner hassio network (Supervisor hardcodes 172.30.32.0/23 with
    //    gateway 172.30.33.254).
    //
    // Routing strategy:
    //   172.30.32.0/23 dev eth0   — outer HA network (outer Supervisor, addons)
    //   fwmark 4 → table 103     — inner Supervisor: any TCP to 172.30.32.2:80
    //                              is marked and policy-routed via dev hassio,
    //                              survives Docker re-adding its /23 route.
    //
    // The Supervisor hardcodes 172.30.32.2 as its own IP on its hassio bridge.
    // Outer AND inner Supervisor both end up at 172.30.32.2 — outer on eth0,
    // inner on the hassio bridge. We disambiguate with fwmark policy routing
    // so .2:80 traffic from this namespace (addon + HA Core, which shares the
    // namespace via host network) always reaches the inner Supervisor.
    //
    // Note: an earlier design ran the Supervisor at .100 with a DNAT rewrite,
    // but the Supervisor's startup logic self-reattaches to .2 regardless of
    // --ip, so the DNAT pointed to a non-existent host. A subsequent attempt
    // used a /32 main-table route, but Docker kept re-stomping it whenever it
    // touched the hassio network (e.g. starting hassio_dns), so the route
    // would disappear mid-flight.
    //
    // Save the addon's eth0 IP before bridge creation so we can restore the /23
    // route after Docker clobbers it.
    progressCb(25, "Setting up HA network…");
    const eth0Ip = (await $`ip -4 addr show eth0`.text()).match(/inet ([\d.]+)/)?.[1] ?? "";

    // Gateway is 172.30.32.1 (= DOCKER_IPV4_NETWORK_MASK[1]). The Supervisor's
    // DNS plugin maps "homeassistant" → 172.30.32.1, and the Supervisor FORCIBLY
    // re-assigns 172.30.32.1 to the hassio bridge during its network migration
    // (confirmed: a different --gateway gets overridden back to .1). HA Core runs
    // --network=host (binds 0.0.0.0:8123 in the addon's namespace), so it's
    // reachable at 172.30.32.1:8123 — the Supervisor polls it, sees
    // CoreState.RUNNING, and reaches RUNNING (required for backup restore).
    //
    // THE COLLISION: 172.30.32.1 is ALSO the addon's real default gateway. While
    // it's locally assigned to hassio it shadows the gateway and black-holes the
    // :8124 proxy's replies to the (off-subnet) browser → the inner-HA iframe
    // spins / is flaky on reload (the kernel won't forward THROUGH a local IP, so
    // no policy route can rescue it). We can't avoid .1 during setup (the
    // Supervisor needs it and forces it), so instead freeOuterGateway() REMOVES it
    // once HA Core is up and any restore is done — see the call before
    // sandbox_ready. By then the Supervisor has finished its network setup and
    // does not re-add .1 (verified stable), HA Core keeps running, and the browser
    // return path is unblocked.
    await $`docker -H unix://${DIND_SOCK} network create \
      --driver bridge \
      --subnet 172.30.32.0/23 \
      --gateway 172.30.32.1 \
      --opt com.docker.network.bridge.name=hassio \
      hassio`
      .nothrow()
      .quiet();

    // Docker auto-adds 172.30.32.0/23 dev hassio which overwrites the outer HA
    // network route via eth0. Delete it and restore eth0.
    await $`ip route del 172.30.32.0/23 dev hassio`.nothrow().quiet();
    if (eth0Ip) {
      await $`ip route add 172.30.32.0/23 dev eth0 src ${eth0Ip}`.nothrow().quiet();
    }

    // Route .2:80 → inner Supervisor via the hassio bridge using policy routing
    // (fwmark 4 → table 103, src 172.30.32.1). See ensureInnerSupervisorRoute()
    // for the full rationale. The actual install is deferred until AFTER the
    // Supervisor container starts and joins the network — only then does Docker
    // assign 172.30.32.1 to the bridge, which `ip route … src 172.30.32.1`
    // requires. Installing it here (before any endpoint joins) silently fails.
    console.log("[sandbox] hassio network ready (inner-supervisor route installed after Supervisor start)");

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

    // Pin Supervisor to 172.30.32.2 on its inner hassio bridge — this is the
    // IP it binds its API to (`Starting API on 172.30.32.2`) and the same IP
    // HA Core hardcodes in HASSIO/SUPERVISOR env vars. Older Supervisor
    // versions actively reattached themselves to .2 ("Connecting Supervisor
    // to hassio-network") regardless of --ip, but 2026.05.2.dev no longer
    // does — without --ip, Docker auto-assigns an ephemeral IP (e.g.
    // 172.30.33.0) and the container's interface never gets .2, breaking
    // all addon→inner and HA-Core→inner traffic.
    await $`docker -H unix://${DIND_SOCK} run -d \
      --rm \
      --name hassio_supervisor \
      --network hassio \
      --ip 172.30.32.2 \
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
      ${supervisorImage}`;
    console.log("[sandbox] Supervisor container started");

    // Now that the Supervisor has joined the hassio network, Docker has assigned
    // 172.30.32.1 to the bridge — install the inner-supervisor policy route. This
    // lands well before HA Core boots (its image may still be downloading), so
    // HA Core's hassio integration connects correctly on first try and registers
    // the hassio.local backup agent that onboarding restore depends on.
    if (await ensureInnerSupervisorRoute()) {
      console.log("[sandbox] Inner-supervisor route confirmed (fwmark 4 → table 103 dev hassio src 172.30.32.1)");
    } else {
      console.warn("[sandbox] WARNING: inner-supervisor route not confirmed — auto-restore will self-heal/retry");
    }

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

    // 8d. Wait for Supervisor RUNNING state before restoring.
    //     The Supervisor's _block_till_run() has a hardcoded 10-min timeout per
    //     cycle and burns ~2 cycles (~20 min) in onboarding mode (is_connected()
    //     always fails). The BackupManager is blocked until RUNNING — confirmed
    //     empirically: an attempt to restore earlier stays "blocked" the whole
    //     time. Skipped entirely when there's nothing to restore (no-restore
    //     boot / already-restored disk), which is the fast path.
    if (backupSlug) {
      progressCb(85, "sandbox_status:Waiting for Supervisor…");
      await waitForSupervisorRunning(signal, (percent, description) => progressCb(percent, description));
    } else {
      console.log("[sandbox] No restore pending — skipping Supervisor RUNNING wait");
    }

    if (signal.aborted) throw new Error("Cancelled");

    // 8e. Ignore the job conditions that block backup restore in the DinD sandbox:
    //       - "healthy": DinD triggers docker_gateway_unprotected (no systemd to
    //         apply firewall rules), marking the system unhealthy.
    //       - "internet_system"/"internet_host": the DinD has no reliable external
    //         egress (external DNS times out), so the Supervisor's connectivity
    //         check fails and blocks do_restore_partial with "no supervisor internet
    //         connection". Restoring the homeassistant config folder is a purely
    //         local extraction and needs no internet, so this condition is safe to
    //         ignore — without it the restore is silently refused and the user is
    //         left on the onboarding wizard with no owner account.
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
          body: JSON.stringify({ ignore_conditions: ["healthy", "internet_system", "internet_host"] }),
          signal: AbortSignal.timeout(10_000),
        });
        console.log("[sandbox] Ignored healthy + internet job conditions for backup restore");
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

    // Don't declare ready until the Core API layer is actually serving — the
    // iframe auto-opens on sandbox_ready and the onboarding/login frontend
    // fetches /api/onboarding once; a 503 in that window = eternal spinner.
    if (!autoRestoreFailed) {
      progressCb(95, "sandbox_status:Waiting for HA Core API…");
      await waitForCoreApiReady(coreUrl, 90_000);
    }

    // Free the colliding gateway IP so the browser's :8124 return path works
    // (HA Core is up and any restore is done); keep Core↔Supervisor alive via
    // DNAT/SNAT so the Supervisor doesn't restart Core.
    await freeOuterGateway(eth0Ip);

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

    // Remove the MASQUERADE rules, the inner-Supervisor policy-routing setup,
    // and the gateway firewall rules. The 172.30.32.0/23 dev eth0 route is the
    // outer HA network and should remain.
    await $`iptables -t nat -D POSTROUTING -s 172.30.32.0/23 -o eth0 -j MASQUERADE`.nothrow().quiet();
    await $`iptables -t nat -D POSTROUTING -s 10.99.99.0/24 -o eth0 -j MASQUERADE`.nothrow().quiet();
    await $`iptables -t mangle -D OUTPUT -d 172.30.32.2 -p tcp --dport 80 -j MARK --set-mark 4`.nothrow().quiet();
    await $`ip rule del fwmark 4 lookup 103`.nothrow().quiet();
    await $`ip route flush table 103`.nothrow().quiet();
    await $`iptables -t raw -D PREROUTING -i lo -d 172.30.32.1 -j ACCEPT`.nothrow().quiet();
    await $`iptables -t raw -D PREROUTING ! -i hassio -d 172.30.32.1 -j DROP`.nothrow().quiet();
    // freeOuterGateway needs no teardown — the bridge is destroyed below, taking
    // the (already-removed) 172.30.32.1 address with it.
    console.log("[sandbox] iptables/route cleanup done");

    // Flush and unmount
    await unmountSafe();
    await teardownLoop();

    // Ensure securityfs is mounted — the inner dockerd can unmount it as a
    // side-effect of mount namespace cleanup, which breaks AppArmor on the host.
    await $`mount -t securityfs securityfs /sys/kernel/security`.nothrow().quiet();

    // Restore /etc/resolv.conf so Supervisor API calls (http://supervisor)
    // continue working after the sandbox stage.
    if (originalResolvConf !== null) {
      try {
        await Bun.write("/etc/resolv.conf", originalResolvConf);
      } catch (err) {
        console.warn("[sandbox] Failed to restore /etc/resolv.conf:", err);
      }
    }
  }
}
