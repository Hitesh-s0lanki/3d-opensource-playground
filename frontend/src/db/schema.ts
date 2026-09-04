/** The Neon catalog. There is no other source of truth.
 *
 * Every row belongs to exactly one Clerk user. There is no shared or global
 * scope anywhere in this file: `userId` is on both `runs` and `jobs`, and
 * `run_items` inherits it through its run. Nothing may be read without a
 * matching `userId` in the where clause.
 *
 * Large binaries - photos and meshes - are the one thing not stored here.
 * Postgres would hold them (a GLB is 4-22 MB) but Neon bills storage and its
 * HTTP driver is a poor pipe for multi-megabyte values, so bytes live in blob
 * storage under a per-user key and the row keeps the key, the size and the
 * hash. `scene.json`, which used to be a file, is small and structured and so
 * lives here as jsonb.
 */

import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Box, Vec3 } from "@/lib/types";

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Clerk user id. Every query filters on this. */
    userId: text("user_id").notNull(),
    /** The name the user sees and searches by: "bedroom", "chair". Unique
     * per user, not globally - two people may both have a "bedroom". */
    slug: text("slug").notNull(),
    kind: text("kind").notNull(), // room | scene | object | images

    /** The source photo, in blob storage. */
    photoKey: text("photo_key"),
    photoName: text("photo_name"),
    photoBytes: bigint("photo_bytes", { mode: "number" }),
    photoWidth: integer("photo_width"),
    photoHeight: integer("photo_height"),

    /** The assembled GLB, in blob storage. */
    renderKey: text("render_key"),
    renderBytes: bigint("render_bytes", { mode: "number" }),
    renderSha256: text("render_sha256"),

    /** What used to be scene.json on disk. */
    spec: jsonb("spec").$type<Record<string, unknown>>(),
    room: jsonb("room").$type<Record<string, unknown>>(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("runs_user_slug").on(table.userId, table.slug),
    index("runs_user_updated").on(table.userId, table.updatedAt),
  ],
);

export const runItems = pgTable(
  "run_items",
  {
    id: serial("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(), // mesh | flat | image
    status: text("status").notNull(), // placed | dropped | orphan
    cropKey: text("crop_key"),
    cropBytes: bigint("crop_bytes", { mode: "number" }),
    meshKey: text("mesh_key"),
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

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(), // object | room
    state: text("state").notNull(), // queued | running | done | failed | cancelled
    stage: text("stage"),
    error: text("error"),
    options: jsonb("options").$type<Record<string, string>>().notNull(),

    /** The uploaded photo this job runs against, in blob storage. Its size is
     * measured once here, on the bytes already in hand, so finishing the job
     * does not have to fetch the photo back to find out. */
    imageKey: text("image_key").notNull(),
    imageName: text("image_name").notNull(),
    imageBytes: bigint("image_bytes", { mode: "number" }),
    imageWidth: integer("image_width"),
    imageHeight: integer("image_height"),

    /** Modal's handle for the in-flight call, polled until it resolves.
     * Null before submission and after the result has been collected. */
    modalCallId: text("modal_call_id"),

    /** The run slug this job produces, for the viewer to jump to. */
    runSlug: text("run_slug"),

    /** One credit was taken when this job was submitted; this says whether it
     * has since been given back. It is a flag on the job rather than a ledger
     * entry because its only job is to make the refund idempotent - two
     * overlapping polls can both notice the same job failed, and only the one
     * that flips this false to true is allowed to pay. */
    creditRefunded: boolean("credit_refunded").notNull().default(false),

    log: jsonb("log").$type<string[]>(),
    queuedAt: timestamp("queued_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("jobs_user_queued").on(table.userId, table.queuedAt),
    index("jobs_user_state").on(table.userId, table.state),
  ],
);

/** The free allowance. One row per Clerk user, created the first time we look.
 *
 * `granted` lives on the row rather than only in code so a top-up is an UPDATE
 * rather than a migration, and `spent` counts rather than decrements so a
 * refund can never hand back more than was taken. Remaining is the difference.
 *
 * There is no ledger of individual charges: a job row already is the receipt,
 * and one integer that a single conditional UPDATE can move is what makes
 * spending safe without a transaction the HTTP driver does not have.
 */
export const credits = pgTable("credits", {
  userId: text("user_id").primaryKey(),
  granted: integer("granted").notNull().default(5),
  spent: integer("spent").notNull().default(0),

  /** Figurine renders, which are metered by the day rather than paid for out
   * of the allowance above.
   *
   * They are not generations: one costs a fraction of a GPU minute and the
   * whole point of the preview is that the user may reject it and ask for
   * another, so charging a credit would make trying twice cost more than the
   * mesh does. But they are billed by OpenAI per call and nothing about a
   * button stops someone holding it down, so the day is the bound.
   *
   * The window resets lazily: the count belongs to `stylizedOn`, and a request
   * dated later simply overwrites both. Nothing has to run at midnight.
   */
  stylizedOn: date("stylized_on"),
  stylizedCount: integer("stylized_count").notNull().default(0),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
