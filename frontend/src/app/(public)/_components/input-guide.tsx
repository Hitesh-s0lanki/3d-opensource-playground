/** What to feed it - the section that saves a visitor their first credit.
 *
 * The model reads depth out of shading, perspective and occlusion. A photo has
 * all three; flat cel artwork has none, so the shape stage is handed a
 * silhouette and extrudes it. Saying so on the landing page is not a
 * disclaimer, it is the difference between a first run that works and one that
 * comes back a sheet of paper.
 *
 * Both numbers are measured, not asserted: thinnest bounding-box side over
 * longest, the same ratio the showcase meshes were picked by. The full
 * investigation is "Flat pictures make flat meshes" in the README.
 */

import Image from "next/image";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionHead } from "./section-head";

const CASES = [
  {
    src: "/showcase/raphael.png",
    alt: "A photographed figurine of a red-masked cartoon turtle",
    verdict: "good",
    label: "A photo of a real object",
    body: "Shading and perspective say how deep it is.",
    depth: "0.55",
  },
  {
    src: "/samples/bowtie-cat.png",
    alt: "A flat line drawing of a cat wearing a bow tie",
    verdict: "bad",
    label: "Flat line art",
    body: "No shading to read. It gets extruded.",
    depth: "0.01",
  },
] as const;

export function InputGuide() {
  return (
    <section id="input" className="mt-20 scroll-mt-24">
      <SectionHead kicker="Input" title="What works" />
      <p className="mt-2 max-w-xl text-sm text-ink-soft">
        Depth is thinnest side over longest. A ball is 1.00.
      </p>

      <ul className="mt-6 grid gap-3 sm:grid-cols-2">
        {CASES.map((item) => {
          const good = item.verdict === "good";
          return (
            <li
              key={item.label}
              className="overflow-hidden rounded-xl border border-line bg-surface"
            >
              <div className="relative bg-[#f1efe9]">
                <Image
                  src={item.src}
                  alt={item.alt}
                  width={1024}
                  height={1024}
                  sizes="(min-width: 640px) 50vw, 100vw"
                  className={cn(
                    "aspect-[5/4] w-full object-contain",
                    !good && "opacity-70 grayscale",
                  )}
                />
                <span className="absolute left-3 top-3 rounded-full bg-surface/85 px-2 py-1 text-[11px] font-medium tabular-nums text-ink-muted backdrop-blur">
                  {item.depth} deep
                </span>
              </div>
              <div className="flex items-start gap-2.5 p-4">
                <span
                  className={cn(
                    "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
                    good ? "bg-brand text-background" : "bg-muted text-ink-muted",
                  )}
                >
                  {good ? (
                    <Check className="size-3" aria-hidden />
                  ) : (
                    <X className="size-3" aria-hidden />
                  )}
                </span>
                <div>
                  <h3 className="font-display text-lg font-bold leading-tight text-ink">
                    {item.label}
                  </h3>
                  <p className="mt-0.5 text-sm leading-snug text-ink-soft">{item.body}</p>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-sm text-ink-muted">
        Only have a drawing? Turn on{" "}
        <span className="font-medium text-ink-soft">Render as a figurine</span> first — it
        adds the shading, and costs no credit.
      </p>
    </section>
  );
}
