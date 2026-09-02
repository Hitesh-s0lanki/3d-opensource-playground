/** Reassemble what the pipeline left on disk into runs.
 *
 * A TypeScript port of the Python viewer's `runs.py`. `dreamspace-room`
 * scatters one job across four places - the photo in inputs/, the crops and
 * per-object meshes under outputs/<name>/, the placement in scene.json and the
 * finished GLB at outputs/<name>.glb - and nothing on disk links them except
 * the naming convention. This walks that convention back into one structure
 * per run.
 *
 * One deliberate difference from the Python version: crop rectangles are never
 * *computed* here (that is a numpy template match). Recorded detector boxes in
 * scene.json are used first, and the `.provenance.json` sidecar the Python
 * viewer caches is read when present - so anything either viewer has seen once
 * draws its boxes in both.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { imageSize } from "image-size";
import { INPUTS_DIR, OUTPUTS_DIR } from "./paths";
import type { Box, ImageRef, Run, RunItem, Vec3 } from "./types";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);
const MESH_EXT = new Set([".glb", ".gltf"]);
const SIDECAR = ".provenance.json";

type Spec = {
  room?: Record<string, unknown>;
  objects?: SpecObject[];
};
type SpecObject = {
  name?: string;
  kind?: string;
  mesh?: string;
  position?: Vec3;
  size?: Vec3;
  rotation_z?: number;
  auto_orient?: boolean;
  source?: { box?: Box; score?: number; label?: string };
};

const ext = (p: string) => path.extname(p).toLowerCase();

async function stat(p: string): Promise<{ bytes: number; mtime: number } | null> {
  try {
    const st = await fsp.stat(p);
    if (!st.isFile()) return null;
    return { bytes: st.size, mtime: st.mtimeMs / 1000 };
  } catch {
    return null;
  }
}

/** A URL the file route can serve, or null for anything outside both trees. */
function urlFor(p: string): string | null {
  for (const [mount, base] of [
    ["outputs", OUTPUTS_DIR],
    ["inputs", INPUTS_DIR],
  ] as const) {
    const rel = path.relative(base, path.resolve(p));
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return `/api/files/${mount}/${rel.split(path.sep).map(encodeURIComponent).join("/")}`;
    }
  }
  return null;
}

async function imageInfo(p: string): Promise<ImageRef | null> {
  const info = await stat(p);
  if (!info) return null;
  const ref: ImageRef = { ...info, name: path.basename(p), url: urlFor(p) };
  try {
    // Dimensions are only needed to draw detection boxes over the photo.
    const dims = imageSize(await fsp.readFile(p));
    ref.width = dims.width;
    ref.height = dims.height;
  } catch {
    /* not fatal */
  }
  return ref;
}

async function findPhoto(stem: string): Promise<string | null> {
  for (const suffix of IMAGE_EXT) {
    const candidate = path.join(INPUTS_DIR, `${stem}${suffix}`);
    if (await stat(candidate)) return candidate;
  }
  return null;
}

async function readSpec(p: string): Promise<Spec | null> {
  try {
    const data = JSON.parse(await fsp.readFile(p, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Spec) : null;
  } catch {
    return null;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(dir)).sort();
  } catch {
    return [];
  }
}

/** Crop boxes the Python viewer already recovered and cached beside the run.
 * The cache key includes the photo's mtime in ns, so a replaced photo
 * invalidates it - same rule as the writer. */
async function cachedBoxes(workDir: string, photo: string): Promise<Record<string, Box>> {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(workDir, SIDECAR), "utf8"));
    const st = await fsp.stat(photo, { bigint: true });
    const key = `${path.basename(photo)}:${st.mtimeNs}`;
    const entries = raw?.[key];
    if (!entries || typeof entries !== "object") return {};
    const out: Record<string, Box> = {};
    for (const [name, box] of Object.entries(entries)) {
      if (Array.isArray(box) && box.length === 4) out[name] = box as Box;
    }
    return out;
  } catch {
    return {};
  }
}

async function meshRef(p: string) {
  const info = await stat(p);
  return info ? { ...info, url: urlFor(p), name: path.basename(p) } : null;
}

// ---------------------------------------------------------------------------
// the four run shapes
// ---------------------------------------------------------------------------

async function buildRoomRun(workDir: string, specPath: string, spec: Spec): Promise<Run> {
  const stem = path.basename(workDir);
  const crops: Record<string, string> = {};
  for (const name of await listDir(path.join(workDir, "crops"))) {
    if (IMAGE_EXT.has(ext(name)))
      crops[name.slice(0, -ext(name).length)] = path.join(workDir, "crops", name);
  }
  const meshes: Record<string, string> = {};
  for (const name of await listDir(path.join(workDir, "objects"))) {
    if (MESH_EXT.has(ext(name)))
      meshes[name.slice(0, -ext(name).length)] = path.join(workDir, "objects", name);
  }

  const photo = await findPhoto(stem);
  // Prefer what the detector recorded; fall back to the cached recovery the
  // Python viewer wrote, for runs made before boxes were recorded.
  const recorded: Record<string, NonNullable<SpecObject["source"]>> = {};
  for (const entry of spec.objects ?? []) {
    if (entry.source?.box && entry.name) recorded[entry.name] = entry.source;
  }
  const recovered =
    Object.keys(recorded).length || !photo || !Object.keys(crops).length
      ? {}
      : await cachedBoxes(workDir, photo);

  const items: RunItem[] = [];
  const placed = new Set<string>();
  for (const entry of spec.objects ?? []) {
    const name = entry.name ?? "?";
    placed.add(name);
    const src = recorded[name] ?? {};
    const box = src.box ? ([...src.box] as Box) : (recovered[name] ?? null);
    items.push({
      name,
      kind: entry.kind ?? "mesh",
      status: "placed",
      crop: name in crops ? await imageInfo(crops[name]) : null,
      mesh: name in meshes ? await meshRef(meshes[name]) : null,
      position: entry.position ?? null,
      size: entry.size ?? null,
      rotation_z: entry.rotation_z ?? 0.0,
      auto_orient: entry.auto_orient ?? true,
      box,
      box_from: src.box ? "detector" : box ? "matched" : null,
      score: src.score ?? null,
      label: src.label ?? null,
    });
  }

  // Detected, reconstructed, then left out - a mesh too degenerate to place,
  // or an object edited out of the spec by hand. Invisible in the final GLB,
  // so the viewer is the only place it can be accounted for.
  for (const name of [...new Set([...Object.keys(crops), ...Object.keys(meshes)])].sort()) {
    if (placed.has(name)) continue;
    items.push({
      name,
      kind: "mesh",
      status: "dropped",
      crop: name in crops ? await imageInfo(crops[name]) : null,
      mesh: name in meshes ? await meshRef(meshes[name]) : null,
      position: null,
      size: null,
      rotation_z: 0.0,
      auto_orient: null,
      box: recovered[name] ?? null,
      box_from: recovered[name] ? "matched" : null,
      score: null,
      label: null,
    });
  }

  const glb = path.join(OUTPUTS_DIR, `${stem}.glb`);
  const glbInfo = await stat(glb);
  return {
    id: stem,
    kind: "room",
    photo: photo ? await imageInfo(photo) : null,
    render: glbInfo
      ? { ...glbInfo, url: urlFor(glb), name: path.basename(glb), path: `${stem}.glb` }
      : null,
    spec: {
      url: urlFor(specPath),
      path: path.relative(OUTPUTS_DIR, specPath).split(path.sep).join("/"),
      room: spec.room ?? {},
    },
    items,
  };
}

/** A scene.json sitting beside its GLB, with no crops - usually hand-written. */
async function buildSpecRun(specPath: string, spec: Spec): Promise<Run> {
  const stem = path.basename(specPath).slice(0, -".scene.json".length);
  const items: RunItem[] = [];
  for (const entry of spec.objects ?? []) {
    let meshPath = entry.mesh ?? "";
    if (meshPath && !path.isAbsolute(meshPath)) {
      meshPath = path.join(path.dirname(OUTPUTS_DIR), meshPath);
    }
    const src = entry.source ?? {};
    items.push({
      name: entry.name ?? "?",
      kind: entry.kind ?? "mesh",
      status: "placed",
      crop: null,
      mesh: meshPath ? await meshRef(meshPath) : null,
      position: entry.position ?? null,
      size: entry.size ?? null,
      rotation_z: entry.rotation_z ?? 0.0,
      auto_orient: entry.auto_orient ?? true,
      box: src.box ? ([...src.box] as Box) : null,
      box_from: src.box ? "detector" : null,
      score: src.score ?? null,
      label: src.label ?? null,
    });
  }

  const photo = await findPhoto(stem);
  const glb = path.join(OUTPUTS_DIR, `${stem}.glb`);
  const glbInfo = await stat(glb);
  return {
    id: stem,
    kind: "scene",
    photo: photo ? await imageInfo(photo) : null,
    render: glbInfo
      ? { ...glbInfo, url: urlFor(glb), name: path.basename(glb), path: `${stem}.glb` }
      : null,
    spec: {
      url: urlFor(specPath),
      path: path.basename(specPath),
      room: spec.room ?? {},
    },
    items,
  };
}

/** One image in, one mesh out - the dreamspace-generate case. */
async function buildObjectRun(glb: string): Promise<Run | null> {
  const info = await stat(glb);
  if (!info) return null;
  const stem = path.basename(glb).slice(0, -ext(glb).length);
  const rel = path.relative(OUTPUTS_DIR, glb).split(path.sep).join("/");
  const photo = await findPhoto(stem);
  return {
    id: rel,
    kind: "object",
    photo: photo ? await imageInfo(photo) : null,
    render: { ...info, url: urlFor(glb), name: path.basename(glb), path: rel },
    spec: null,
    items: [],
  };
}

/** A folder of images with no scene.json - crops from an unfinished run. */
async function buildLooseRun(dir: string, images: string[]): Promise<Run> {
  const photo = await findPhoto(path.basename(dir));
  const items: RunItem[] = [];
  for (const image of images) {
    items.push({
      name: path.basename(image).slice(0, -ext(image).length),
      kind: "image",
      status: "orphan",
      crop: await imageInfo(image),
      mesh: null,
      position: null,
      size: null,
      rotation_z: 0.0,
      auto_orient: null,
      box: null,
      box_from: null,
      score: null,
      label: null,
    });
  }
  return {
    id: path.relative(OUTPUTS_DIR, dir).split(path.sep).join("/"),
    kind: "images",
    photo: photo ? await imageInfo(photo) : null,
    render: null,
    spec: null,
    items,
  };
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

export async function discover(): Promise<Run[]> {
  const runs: Run[] = [];
  const claimed = new Set<string>(); // GLBs already spoken for by a run
  const seenDirs = new Set<string>();

  let entries: string[] = [];
  try {
    entries = (await fsp.readdir(OUTPUTS_DIR)).sort();
  } catch {
    return [];
  }

  const dirs: string[] = [];
  const rootFiles: string[] = [];
  for (const name of entries) {
    try {
      const st = await fsp.stat(path.join(OUTPUTS_DIR, name));
      (st.isDirectory() ? dirs : rootFiles).push(name);
    } catch {
      /* vanished mid-walk */
    }
  }

  // outputs/<name>/scene.json -> a room run
  for (const dir of dirs) {
    const workDir = path.join(OUTPUTS_DIR, dir);
    const specPath = path.join(workDir, "scene.json");
    if (!(await stat(specPath))) continue;
    const spec = await readSpec(specPath);
    if (!spec) continue;
    runs.push(await buildRoomRun(workDir, specPath, spec));
    claimed.add(path.resolve(OUTPUTS_DIR, `${dir}.glb`));
    for (const name of await listDir(path.join(workDir, "objects"))) {
      claimed.add(path.resolve(workDir, "objects", name));
    }
    seenDirs.add(path.resolve(workDir));
  }

  // outputs/<name>.scene.json -> a hand-written / re-assembled scene
  for (const name of rootFiles) {
    if (!name.endsWith(".scene.json")) continue;
    const specPath = path.join(OUTPUTS_DIR, name);
    const spec = await readSpec(specPath);
    if (!spec) continue;
    const run = await buildSpecRun(specPath, spec);
    runs.push(run);
    claimed.add(path.resolve(OUTPUTS_DIR, `${run.id}.glb`));
  }

  // every remaining mesh, anywhere under outputs/
  const everything = (await fsp.readdir(OUTPUTS_DIR, { recursive: true })) as string[];
  for (const rel of everything.sort()) {
    if (!MESH_EXT.has(ext(rel))) continue;
    const glb = path.join(OUTPUTS_DIR, rel);
    if (claimed.has(path.resolve(glb))) continue;
    const run = await buildObjectRun(glb);
    if (run) runs.push(run);
  }

  // Images in a directory that no run accounts for - a segment pass run on
  // its own, say. Listing them keeps the viewer an honest picture of the
  // folder rather than only of the jobs that finished.
  for (const dir of dirs) {
    const full = path.join(OUTPUTS_DIR, dir);
    if (seenDirs.has(path.resolve(full))) continue;
    const images = (await listDir(full))
      .filter((name) => IMAGE_EXT.has(ext(name)))
      .map((name) => path.join(full, name));
    if (images.length) runs.push(await buildLooseRun(full, images));
  }

  // Newest first: after a run finishes, its result is what you came to see.
  const when = (run: Run): number => {
    const stamps = run.render ? [run.render.mtime] : [];
    for (const item of run.items) if (item.mesh) stamps.push(item.mesh.mtime);
    return stamps.length ? Math.max(...stamps) : 0;
  };
  runs.sort((a, b) => when(b) - when(a));
  return runs;
}
