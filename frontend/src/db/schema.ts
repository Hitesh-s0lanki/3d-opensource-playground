/** The Neon catalog of everything the pipeline has produced.
 *
 * Files stay on disk - outputs/ is where Blender and the CLIs read and write,
 * and multi-megabyte meshes do not belong in Postgres rows. The database is
 * the durable record of them: which runs exist, what each object in a run
 * became, the placement numbers, a SHA-256 of every assembled GLB, and the
 * history of every job the viewer ran - all of which survives outputs/ being
 * cleaned out.
 */

import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { Box, Vec3 } from "@/lib/types";

export const runs = pgTable("runs", {
  /** The run id the viewer uses: "bedroom" for a room, "chair.glb" for an object. */
  id: text("id").primaryKey(),
  kind: text("kind").notNull(), // room | scene | object | images
  photoName: text("photo_name"),
  photoWidth: integer("photo_width"),
  photoHeight: integer("photo_height"),
  /** outputs/-relative path of the assembled GLB, e.g. "bedroom.glb". */
  renderPath: text("render_path"),
  renderBytes: bigint("render_bytes", { mode: "number" }),
  renderMtime: timestamp("render_mtime", { withTimezone: true }),
  renderSha256: text("render_sha256"),
  specPath: text("spec_path"),
  room: jsonb("room").$type<Record<string, unknown>>(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const runItems = pgTable(
  "run_items",
  {
    id: serial("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(), // mesh | flat | image
    status: text("status").notNull(), // placed | dropped | orphan
    cropPath: text("crop_path"),
    cropBytes: bigint("crop_bytes", { mode: "number" }),
    meshPath: text("mesh_path"),
    meshBytes: bigint("mesh_bytes", { mode: "number" }),
    position: jsonb("position").$type<Vec3>(),
    size: jsonb("size").$type<Vec3>(),
    rotationZ: real("rotation_z").notNull().default(0),
    autoOrient: boolean("auto_orient"),
    /** pixel box [x0, y0, x1, y1] inside the source photo */
    box: jsonb("box").$type<Box>(),
    boxFrom: text("box_from"), // detector | matched
    score: real("score"),
    label: text("label"),
  },
  (table) => [uniqueIndex("run_items_run_id_name").on(table.runId, table.name)],
);

export const jobs = pgTable("jobs", {
  id: serial("id").primaryKey(),
  /** The in-process id ("j3") - unique per server session, not globally. */
  localId: text("local_id").notNull(),
  kind: text("kind").notNull(), // object | room
  image: text("image").notNull(),
  options: jsonb("options").$type<Record<string, string>>().notNull(),
  state: text("state").notNull(), // done | failed | cancelled
  stage: text("stage"),
  error: text("error"),
  returncode: integer("returncode"),
  /** The run this job produced, matching runs.id once discovery sees it. */
  runId: text("run_id"),
  log: jsonb("log").$type<string[]>(),
  queuedAt: timestamp("queued_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
