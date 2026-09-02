/** Shared shapes between the API routes and the client.
 *
 * `url` fields point at `/api/files/<blob key>`, never at storage directly:
 * that route is where the caller is checked against the key's owner.
 */

export type Box = [number, number, number, number];
export type Vec3 = [number, number, number];

export interface FileRef {
  name: string;
  url: string | null;
  bytes: number;
  /** seconds since epoch, matching Python's st_mtime */
  mtime: number;
}

export interface ImageRef extends FileRef {
  width?: number;
  height?: number;
}

export type RunKind = "room" | "scene" | "object" | "images";
export type ItemStatus = "placed" | "dropped" | "orphan";

export interface RunItem {
  name: string;
  kind: string; // "mesh" | "flat" | "image"
  status: ItemStatus;
  crop: ImageRef | null;
  mesh: FileRef | null;
  position: Vec3 | null;
  size: Vec3 | null;
  rotation_z: number;
  auto_orient: boolean | null;
  /** pixel box [x0, y0, x1, y1] inside the source photo */
  box: Box | null;
  box_from: "detector" | "matched" | null;
  score: number | null;
  label: string | null;
}

export interface RunSpecRef {
  url: string | null;
  path: string;
  room: Record<string, unknown>;
}

export interface Run {
  id: string;
  kind: RunKind;
  photo: ImageRef | null;
  render: (FileRef & { path?: string }) | null;
  spec: RunSpecRef | null;
  items: RunItem[];
}

export interface RunsPayload {
  /** Why a run cannot be started - Modal or blob storage unconfigured - or
   * null when one can be. Disables the new-run dialog, and says why. */
  generate_blocked: string | null;
  /** The room pipeline has no cloud implementation yet. */
  room_available: boolean;
  /** The Neon catalog: configured at all, and did the last read succeed. */
  db: { enabled: boolean; synced: boolean };
  runs: Run[];
}

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";
export type JobKind = "object" | "room";

export interface JobSnapshot {
  id: string;
  kind: JobKind;
  label: string;
  image: string;
  image_url: string;
  state: JobState;
  stage: string;
  options: Record<string, string>;
  run_id: string;
  elapsed: number;
  waited: number;
  returncode: number | null;
  error: string;
  log: string[];
}
