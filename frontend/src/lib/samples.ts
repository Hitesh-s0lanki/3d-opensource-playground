/** The starter characters offered in the New run form.
 *
 * They exist so the app can be tried without hunting for a photo first, which
 * makes each one somebody's first credit - and that is the whole constraint on
 * what belongs here. A suggestion that reconstructs badly spends a stranger's
 * only free run proving the tool does not work.
 *
 * So these are lit 3D character renders rather than drawings: a matte vinyl
 * figure under a soft key light, ambient occlusion in every fold, rounded
 * volumes, a three-quarter turn of roughly thirty degrees, the full body
 * inside the frame with a margin on every side, and a plain even ground. That
 * is the same description as `FIGURINE_PROMPT` in `lib/stylize.ts`, and not by
 * coincidence: the figurine step exists to turn an upload into exactly this,
 * so a sample already in that form is a run that needs neither a stylize call
 * nor loosened guidance to come back solid.
 *
 * Flat cel artwork is the opposite of the brief, however well drawn. It gives
 * the shape model no shading to read, so it extrudes into a relief - the
 * landing page measures one of the files in `public/samples` at 0.01 deep and
 * labels it the thing not to upload (`(public)/_components/input-guide.tsx`).
 * Those files stay on disk because that section and the showcase still point
 * at them; they simply do not belong in the list below.
 *
 * Adding one: drop `<id>.png` into `public/samples` and add its id and label
 * here. The picker renders whatever this list holds, three to a row.
 */

export interface Sample {
  /** Also the filename stem and the name the job is queued under. */
  id: string;
  label: string;
}

export const SAMPLES: Sample[] = [
  { id: "crayon-kid", label: "Crayon kid" },
  { id: "pigtail-girl", label: "Pigtail girl" },
  { id: "tin-robot", label: "Tin robot" },
  { id: "little-dino", label: "Little dino" },
  { id: "penguin-scout", label: "Penguin scout" },
  { id: "bowtie-cat", label: "Bow-tie cat" },
];

export const sampleSrc = (sample: Sample) => `/samples/${sample.id}.png`;

/** Pull a sample off the server as a File, so it travels the same upload path
 * as anything the user picked themselves - nothing downstream knows it came
 * from here. */
export async function sampleAsFile(sample: Sample): Promise<File> {
  const res = await fetch(sampleSrc(sample));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return new File([blob], `${sample.id}.png`, { type: "image/png" });
}
