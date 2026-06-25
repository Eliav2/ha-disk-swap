// Re-export shared types used by both frontend and server
export type {
  Device,
  DevicesResponse,
  SystemInfoResponse,
  StageName,
  StageStatus,
  WsMessage,
  JobStatus,
  JobMode,
  ImageCacheStatus,
} from "@shared/types.ts";

// Import for local use
import type { StageName, StageStatus, Job as SharedJob } from "@shared/types.ts";

/** HA backup entry from GET api/backups (frontend subset — no size_bytes) */
export interface Backup {
  slug: string;
  name: string;
  date: string;
  type: "full" | "partial";
  size: number; // MB float
}

/** Response shape for GET api/backups */
export interface BackupsResponse {
  backups: Backup[];
}

/** User's backup choice for the clone pipeline */
export type BackupSelection =
  | { type: "new" }
  | { type: "existing"; slug: string; name: string };

/** Frontend stage state — extends shared StageState with UI-specific fields */
export interface StageState {
  name: StageName;
  label: string;
  description: string;
  status: StageStatus;
  progress: number; // 0–100
  speed?: number; // bytes/sec
  eta?: number; // seconds remaining
  link?: { text: string; url: string };
  experimental?: boolean;
}

/** Clone job returned by GET api/jobs/current (matches shared Job) */
export type Job = SharedJob;
