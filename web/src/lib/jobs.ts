/** Run the pipeline from the viewer, one job at a time.
 *
 * A TypeScript port of the Python viewer's `jobs.py`. The generators are
 * already console scripts, so nothing is reimplemented here - the uploaded
 * image is saved into inputs/ and the same command you would have typed runs
 * as a subprocess, its output captured as it goes.
 *
 * Serially, and deliberately. A 4 GB card fits one TripoSR at a time; two
 * concurrent generations do not fail politely, they OOM in the middle of
 * whichever was further along. Queueing costs nothing here because the
 * bottleneck is a single GPU either way.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { recordJob } from "@/db/sync";
import { INPUTS_DIR, OUTPUTS_DIR, ROOT, pythonExe } from "./paths";
import type { JobKind, JobSnapshot, JobState } from "./types";

// Uploads land in inputs/, so both the name and the extension have to be tame.
const SAFE_CHARS = /[^A-Za-z0-9._-]+/g;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);
export const MAX_UPLOAD = 40 * 1024 * 1024;

// `console.rule("2/4  reconstruct")` and friends - the only progress signal
// the CLIs emit in a machine-readable shape.
const STAGE = /\b(\d+)\s*\/\s*(\d+)\b\s+([A-Za-z][\w .-]*)/;

const KINDS: Record<JobKind, { module: string; label: string }> = {
  object: { module: "dreamspace.cli.generate", label: "image → mesh" },
  room: { module: "dreamspace.cli.room", label: "photo → scene" },
};

export function isJobKind(kind: string): kind is JobKind {
  return kind in KINDS;
}

/** A file name that cannot escape the directory it is written into. */
export function safeFilename(raw: string): string {
  const name = path.basename(raw.replaceAll("\\", "/"));
  const suffix = path.extname(name).toLowerCase();
  if (!IMAGE_EXT.has(suffix)) throw new Error(`not an image: ${raw}`);
  const stem = name
    .slice(0, -suffix.length)
    .replace(SAFE_CHARS, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return (stem || "upload") + suffix;
}

/** Write an uploaded image into inputs/, without overwriting anything. */
export async function storeUpload(filename: string, data: Buffer): Promise<string> {
  if (data.length > MAX_UPLOAD) {
    throw new Error(
      `image is ${Math.round(data.length / 1e6)} MB; the limit is ${MAX_UPLOAD / 1e6} MB`,
    );
  }
  if (!data.length) throw new Error("empty upload");

  await fsp.mkdir(INPUTS_DIR, { recursive: true });
  const name = safeFilename(filename);
  let target = path.join(INPUTS_DIR, name);
  const exists = async (p: string) =>
    fsp.stat(p).then((st) => st.isFile(), () => false);
  if (await exists(target)) {
    const current = await fsp.readFile(target);
    if (current.equals(data)) return target; // same picture, same name
    const suffix = path.extname(name);
    const stem = name.slice(0, -suffix.length);
    for (let n = 2; await exists(target); n++) {
      target = path.join(INPUTS_DIR, `${stem}-${n}${suffix}`);
    }
  }
  await fsp.writeFile(target, data);
  return target;
}

class Job {
  state: JobState = "queued";
  stage = "";
  lines: string[] = [];
  queuedAt = Date.now();
  startedAt: number | null = null;
  finishedAt: number | null = null;
  returncode: number | null = null;
  error = "";
  proc: ChildProcess | null = null;

  constructor(
    public id: string,
    public kind: JobKind,
    public image: string, // absolute path into inputs/
    public options: Record<string, string>,
  ) {}

  pushLine(line: string) {
    this.lines.push(line);
    if (this.lines.length > 400) this.lines.splice(0, this.lines.length - 400);
  }

  /** Which run this job will produce, for the viewer to jump to. */
  get runId(): string {
    const stem = path.basename(this.image, path.extname(this.image));
    return this.kind === "room" ? stem : `${stem}.glb`;
  }

  snapshot(): JobSnapshot {
    const end = this.finishedAt ?? Date.now();
    return {
      id: this.id,
      kind: this.kind,
      label: KINDS[this.kind].label,
      image: path.basename(this.image),
      image_url: `/api/files/inputs/${encodeURIComponent(path.basename(this.image))}`,
      state: this.state,
      stage: this.stage,
      options: this.options,
      run_id: this.runId,
      elapsed: this.startedAt ? Math.round((end - this.startedAt) / 100) / 10 : 0,
      waited: Math.round(((this.startedAt ?? Date.now()) - this.queuedAt) / 100) / 10,
      returncode: this.returncode,
      error: this.error,
      log: this.lines.slice(-60),
    };
  }
}

export class JobRunner {
  private jobs = new Map<string, Job>();
  private order: string[] = [];
  private queue: Job[] = [];
  private active: Job | null = null;
  private counter = 0;

  submit(kind: JobKind, image: string, options: Record<string, string>): JobSnapshot {
    const job = new Job(`j${++this.counter}`, kind, image, options);
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    this.queue.push(job);
    void this.pump();
    return job.snapshot();
  }

  snapshot(): JobSnapshot[] {
    return this.order.map((id) => this.jobs.get(id)!.snapshot());
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || ["done", "failed", "cancelled"].includes(job.state)) return false;
    if (job.state === "queued") {
      job.state = "cancelled";
      job.finishedAt = Date.now();
      this.queue = this.queue.filter((queued) => queued !== job);
      this.persist(job);
      return true;
    }
    if (job.proc && job.proc.exitCode === null) {
      // Blender, if this job got as far as assembly, is a grandchild and
      // outlives the kill. It exits on its own once its input is gone.
      job.proc.kill();
      job.state = "cancelled";
      return true;
    }
    return false;
  }

  // -- worker --------------------------------------------------------------

  /** Best-effort history row in Neon; a missing database is fine. */
  private persist(job: Job): void {
    void recordJob(job.snapshot(), {
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    });
  }

  private command(job: Job): string[] {
    const opt = job.options;
    const cmd = ["-m", KINDS[job.kind].module, "--image", job.image];
    if (job.kind === "object") {
      cmd.push("--out", OUTPUTS_DIR);
      if (opt.no_texture === "true" || opt.no_texture === "1") cmd.push("--no-texture");
      if (opt.mc_resolution) cmd.push("--mc-resolution", String(parseInt(opt.mc_resolution, 10)));
    } else {
      for (const [flag, key] of [
        ["--fov", "fov"],
        ["--threshold", "threshold"],
        ["--decimate", "decimate"],
      ] as const) {
        if (opt[key]) cmd.push(flag, String(parseFloat(opt[key])));
      }
      if (opt.walls) cmd.push("--walls", opt.walls);
      if (opt.labels) cmd.push("--labels", opt.labels);
    }
    return cmd;
  }

  private environment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      // The viewer may serve a directory that is not the configured one, and
      // a result the viewer cannot see is not a result.
      OUTPUT_DIR: OUTPUTS_DIR,
      PYTHONUNBUFFERED: "1",
      // Without UTF-8 mode the child encodes for the console codepage
      // (cp1252 here) and rich's rules and arrows kill the run with a
      // UnicodeEncodeError several minutes in.
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      // rich formats for whatever terminal it thinks it has; through a pipe
      // that means escape codes and box-drawing in the log tail.
      NO_COLOR: "1",
      TERM: "dumb",
      COLUMNS: "100",
    };
  }

  private async pump(): Promise<void> {
    if (this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    if (job.state === "cancelled") return this.pump();
    this.active = job;
    try {
      await this.run(job);
      this.persist(job); // done, failed or cancelled mid-run
    } finally {
      this.active = null;
      void this.pump();
    }
  }

  private run(job: Job): Promise<void> {
    return new Promise((resolve) => {
      job.state = "running";
      job.startedAt = Date.now();

      const python = pythonExe();
      if (!python) {
        job.state = "failed";
        job.error = "no Python interpreter found - set DREAMSPACE_PYTHON or run setup.ps1";
        job.finishedAt = Date.now();
        return resolve();
      }

      const cmd = this.command(job);
      job.pushLine("$ " + cmd.slice(1).join(" ")); // as you would have typed it
      let proc: ChildProcess;
      try {
        proc = spawn(python, cmd, {
          cwd: ROOT,
          env: this.environment(),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (exc) {
        job.state = "failed";
        job.error = String(exc);
        job.finishedAt = Date.now();
        return resolve();
      }

      job.proc = proc;
      let tail = "";
      const consume = (chunk: Buffer) => {
        tail += chunk.toString("utf8");
        const pieces = tail.split(/\r?\n/);
        tail = pieces.pop() ?? "";
        for (const raw of pieces) {
          const line = raw.trimEnd();
          if (!line) continue;
          job.pushLine(line);
          const match = STAGE.exec(line);
          if (match) job.stage = `${match[1]}/${match[2]} ${match[3].trim()}`;
        }
      };
      proc.stdout?.on("data", consume);
      proc.stderr?.on("data", consume);

      proc.on("error", (exc) => {
        job.state = "failed";
        job.error = String(exc);
        job.finishedAt = Date.now();
        resolve();
      });

      proc.on("close", (code) => {
        if (tail.trim()) job.pushLine(tail.trimEnd());
        job.returncode = code;
        job.finishedAt = Date.now();
        if (job.state === "cancelled") return resolve();
        if (code === 0) {
          job.state = "done";
          job.stage = "finished";
        } else {
          job.state = "failed";
          job.stage = "";
          // The last thing printed is nearly always the reason.
          job.error =
            [...job.lines].reverse().find((line) => line.trim()) ??
            `exited with ${code}`;
        }
        resolve();
      });
    });
  }
}

/** One runner per server process, surviving dev-server hot reloads. */
const globalStore = globalThis as unknown as { __dreamspaceRunner?: JobRunner };

export function getRunner(): JobRunner {
  globalStore.__dreamspaceRunner ??= new JobRunner();
  return globalStore.__dreamspaceRunner;
}
