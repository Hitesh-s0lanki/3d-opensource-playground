import fs from "node:fs";
import path from "node:path";

/** The dreamspace repo root: the directory holding outputs/, inputs/ and the
 * Python venv. The web app lives in <root>/web, so the parent of cwd is the
 * default; DREAMSPACE_ROOT overrides it for any other arrangement. */
function findRoot(): string {
  if (process.env.DREAMSPACE_ROOT) {
    return path.resolve(process.env.DREAMSPACE_ROOT);
  }
  let dir = process.cwd();
  for (let hops = 0; hops < 4; hops++) {
    if (
      fs.existsSync(path.join(dir, "outputs")) &&
      fs.existsSync(path.join(dir, "pyproject.toml"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd(), "..");
}

export const ROOT = findRoot();
export const OUTPUTS_DIR = process.env.DREAMSPACE_OUTPUTS
  ? path.resolve(process.env.DREAMSPACE_OUTPUTS)
  : path.join(ROOT, "outputs");
export const INPUTS_DIR = process.env.DREAMSPACE_INPUTS
  ? path.resolve(process.env.DREAMSPACE_INPUTS)
  : path.join(ROOT, "inputs");

/** The venv interpreter the pipeline was installed into. Generation is
 * disabled (but browsing still works) when it cannot be found. */
export function pythonExe(): string | null {
  if (process.env.DREAMSPACE_PYTHON) return process.env.DREAMSPACE_PYTHON;
  const candidates =
    process.platform === "win32"
      ? [path.join(ROOT, ".venv", "Scripts", "python.exe")]
      : [path.join(ROOT, ".venv", "bin", "python")];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** True only for paths that stay inside `base` after resolution. */
export function insideDir(base: string, target: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
