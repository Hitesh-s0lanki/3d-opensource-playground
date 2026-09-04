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
  /** Why an upload cannot be re-rendered as a figurine first - OPENAI_API_KEY
   * unset - or null when it can be. The option is hidden rather than shown
   * broken, since a run without it still works. */
  stylize_blocked: string | null;
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

/** What the signed-in user has left to spend. Generating costs one credit;
 * a failed or cancelled job is refunded. */
export interface CreditsSnapshot {
  granted: number;
  spent: number;
  /** granted - spent, floored at zero. What the UI counts down. */
  remaining: number;
}

/** POST /api/stylize. Nothing is stored server-side: the render comes back
 * inline and is posted straight back as the job's file if the user takes it. */
export interface StylizePayload {
  /** The figurine, as a `data:` URL ready to drop into an `<img>`. */
  image: string;
  /** What to call it when it is uploaded as the job's image. */
  name: string;
  /** Figurine renders left today, for the hint under the button. */
  remaining_today: number;
}

/** GET /api/jobs. The credits ride along with the poll the viewer already
 * runs, so the balance follows a refund without a second timer. */
export interface JobsPayload {
  jobs: JobSnapshot[];
  credits: CreditsSnapshot;
}
