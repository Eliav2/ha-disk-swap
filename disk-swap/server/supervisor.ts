import type {
  SupervisorInfo,
  OsInfo,
  HostInfo,
  NetworkInfo,
  BackupJobResponse,
  SupervisorJobStatus,
  SupervisorBackup,
} from "../shared/types.ts";
import { formatBytes } from "../shared/format.ts";

const SUPERVISOR_URL = "http://supervisor";
const API_TIMEOUT_MS = 30_000;

/** Machine name → HAOS board slug lookup table */
const MACHINE_TO_SLUG: Record<string, string> = {
  "raspberrypi3": "rpi3",
  "raspberrypi3-64": "rpi3-64",
  "raspberrypi4": "rpi4",
  "raspberrypi4-64": "rpi4-64",
  "raspberrypi5-64": "rpi5-64",
  "generic-x86-64": "generic-x86-64",
  "generic-aarch64": "generic-aarch64",
  "odroid-c2": "odroid-c2",
  "odroid-c4": "odroid-c4",
  "odroid-m1": "odroid-m1",
  "odroid-n2": "odroid-n2",
  "odroid-xu": "odroid-xu",
  "tinker": "tinker",
  "khadas-vim3": "khadas-vim3",
  "green": "green",
  "yellow": "yellow",
  "qemuarm-64": "generic-aarch64",
  "qemux86-64": "generic-x86-64",
};

export function machineToBoardSlug(machine: string): string {
  const slug = MACHINE_TO_SLUG[machine];
  if (!slug) throw new Error(`Unsupported machine type: "${machine}"`);
  return slug;
}

function supervisorHeaders(): Record<string, string> {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) {
    throw new Error(
      "SUPERVISOR_TOKEN not found. This add-on must run inside Home Assistant."
    );
  }
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/** Generic Supervisor API GET — unwraps the { result, data } envelope */
async function supervisorGet<T>(path: string): Promise<T> {
  const res = await fetch(`${SUPERVISOR_URL}${path}`, {
    headers: supervisorHeaders(),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supervisor API ${path} returned ${res.status}: ${body}`);
  }

  const json = (await res.json()) as {
    result: string;
    data: T;
    message?: string;
  };

  if (json.result !== "ok") {
    throw new Error(
      `Supervisor API ${path} result="${json.result}": ${json.message ?? "unknown error"}`
    );
  }

  return json.data;
}

/** Generic Supervisor API POST — unwraps the { result, data } envelope */
async function supervisorPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SUPERVISOR_URL}${path}`, {
    method: "POST",
    headers: supervisorHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supervisor POST ${path} returned ${res.status}: ${text}`);
  }

  const json = (await res.json()) as {
    result: string;
    data: T;
    message?: string;
  };

  if (json.result !== "ok") {
    throw new Error(
      `Supervisor POST ${path} result="${json.result}": ${json.message ?? "unknown error"}`,
    );
  }

  return json.data;
}

/** List all existing backups from the Supervisor. */
export async function listBackups(): Promise<SupervisorBackup[]> {
  const data = await supervisorGet<{ backups: SupervisorBackup[] }>("/backups");
  return data.backups;
}

/** Get the size of the most recent full backup in bytes (for progress estimation). */
export async function getLastFullBackupSize(): Promise<number | null> {
  const backups = await listBackups();
  const fullBackups = backups
    .filter((b) => b.type === "full" && b.size_bytes > 0)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return fullBackups.length > 0 ? fullBackups[0].size_bytes : null;
}

/** Create a full backup in background mode. Returns the job_id for polling. */
export async function createFullBackup(): Promise<BackupJobResponse> {
  const name = `disk-swap-clone-${new Date().toISOString().slice(0, 10)}`;
  return supervisorPost<BackupJobResponse>("/backups/new/full", {
    name,
    background: true,
    homeassistant_exclude_database: false,
  });
}

/** Poll a Supervisor job by ID. */
export async function pollJob(jobId: string): Promise<SupervisorJobStatus> {
  return supervisorGet<SupervisorJobStatus>(`/jobs/${jobId}`);
}

/** Get addon self-info (includes protected mode status). */
export async function getAddonInfo(): Promise<{ protected: boolean; slug: string; version: string }> {
  const data = await supervisorGet<{ protected: boolean; slug: string; version: string }>("/addons/self/info");
  return { protected: data.protected, slug: data.slug, version: data.version };
}

export async function getInfo(): Promise<SupervisorInfo> {
  return supervisorGet<SupervisorInfo>("/info");
}

export async function getOsInfo(): Promise<OsInfo> {
  return supervisorGet<OsInfo>("/os/info");
}

export async function getHostInfo(): Promise<HostInfo> {
  return supervisorGet<HostInfo>("/host/info");
}

export async function getNetworkInfo(): Promise<NetworkInfo> {
  return supervisorGet<NetworkInfo>("/network/info");
}

function extractIpAddress(network: NetworkInfo): string {
  for (const iface of network.interfaces) {
    if (iface.interface === "lo") continue;
    const addresses = iface.ipv4?.address;
    if (addresses && addresses.length > 0) {
      // Strip CIDR suffix (e.g. "192.168.1.42/24" → "192.168.1.42")
      return addresses[0].split("/")[0];
    }
  }
  return "unknown";
}

/** Aggregate system info from multiple Supervisor endpoints */
export async function getSystemInfo() {
  const [info, osInfo, hostInfo, networkInfo, addonInfo] = await Promise.all([
    getInfo(),
    getOsInfo(),
    getHostInfo(),
    getNetworkInfo(),
    getAddonInfo(),
  ]);

  return {
    machine: info.machine,
    board_slug: machineToBoardSlug(info.machine),
    os_version: osInfo.version,
    os_version_latest: osInfo.version_latest,
    ip_address: extractIpAddress(networkInfo),
    free_space_bytes: Math.round(hostInfo.disk_free * 1024 ** 3),
    free_space_human: formatBytes(Math.round(hostInfo.disk_free * 1024 ** 3)),
    protected: addonInfo.protected,
    addon_slug: addonInfo.slug,
    addon_version: addonInfo.version,
  };
}
