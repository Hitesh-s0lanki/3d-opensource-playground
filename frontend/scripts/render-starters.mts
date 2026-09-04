/** One-off: turn the flat starter drawings into the lit figures the picker
 * should be offering.
 *
 * The New run picker is a stranger's first credit, so what it hands them has
 * to be the input the pipeline is good at - see the brief in `lib/samples.ts`.
 * The drawings under `public/samples` are the opposite of it, and the landing
 * page says so out loud. Rather than source new art, this pushes each one
 * through the same figurine step the app offers on upload: same prompt, same
 * model, same transparent PNG out. The characters survive; the flatness does
 * not.
 *
 * It imports `renderFigurine` rather than reimplementing the call, so the
 * prompt cannot drift away from the one users get.
 *
 * Renders land in `public/starters`, never over `public/samples` - the input
 * guide and the showcase still point at those files, and a run of this script
 * must not quietly rewrite the landing page's counter-example.
 *
 *   node --env-file=.env scripts/render-starters.mts
 *
 * Costs one image-model call per sample. Already-rendered files are skipped,
 * so a re-run after a failure only pays for what is missing; pass --force to
 * render everything again.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SAMPLES } from "../src/lib/samples.ts";
import { renderFigurine } from "../src/lib/stylize.ts";

const SOURCE_DIR = path.join("public", "samples");
const OUT_DIR = path.join("public", "starters");
const force = process.argv.includes("--force");

const done: string[] = [];
const skipped: string[] = [];
const failed: [string, string][] = [];

await mkdir(OUT_DIR, { recursive: true });

for (const sample of SAMPLES) {
  const source = path.join(SOURCE_DIR, `${sample.id}.png`);
  const out = path.join(OUT_DIR, `${sample.id}.png`);

  if (!existsSync(source)) {
    failed.push([sample.id, `no source at ${source}`]);
    continue;
  }
  if (existsSync(out) && !force) {
    skipped.push(sample.id);
    continue;
  }

  process.stdout.write(`${sample.label} … `);
  try {
    // Sequential on purpose: six images is not worth a rate-limit retry loop,
    // and a failure halfway through leaves the finished ones on disk.
    const png = await renderFigurine(await readFile(source), `${sample.id}.png`, "image/png");
    await writeFile(out, png);
    console.log(`${(png.length / 1024).toFixed(0)} KB → ${out}`);
    done.push(sample.id);
  } catch (exc) {
    const why = exc instanceof Error ? exc.message : String(exc);
    console.log(`failed: ${why}`);
    failed.push([sample.id, why]);
  }
}

console.log(
  `\n${done.length} rendered, ${skipped.length} already present, ${failed.length} failed`,
);
if (skipped.length) console.log(`  skipped: ${skipped.join(", ")} (--force to redo)`);
for (const [id, why] of failed) console.log(`  ${id}: ${why}`);

// A partial set is still a broken picker, so say what is left to do rather
// than letting a green-looking run imply the swap is finished.
if (failed.length) process.exitCode = 1;
else console.log(`\nAll ${SAMPLES.length} present in ${OUT_DIR} - point sampleSrc at /starters.`);
