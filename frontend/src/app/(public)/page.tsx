/** The landing page.
 *
 * The product is visual, so the demo is the pitch: a photo, the model it
 * became, and a button. Everything else here is one line long or it is not
 * here at all. The first draft explained the pipeline in paragraphs, which is
 * documentation - that lives in the README.
 */

import type { Metadata } from "next";
import { Box, Cloud, Download, Lock, Paintbrush, Scissors, Upload } from "lucide-react";
import { InputGuide } from "./_components/input-guide";
import { LandingFooter } from "./_components/footer";
import { LandingNav } from "./_components/nav";
import { SectionHead } from "./_components/section-head";
import { Showcase } from "./_components/showcase";
import { StartButton } from "./_components/start-button";
import { FREE_CREDITS } from "@/lib/credits";

export const metadata: Metadata = {
  title: "dioramic — turn a photo into a 3D model",
  description:
    "Upload a photo of one object and get a textured 3D model back in about a minute. Spin it, download the .glb. Five free.",
};

/** Numbered rather than joined by arrows: four pills and three arrows wrap on
 * a phone into a line that ends in an arrow pointing at nothing. */
const STEPS = [
  { icon: Upload, label: "Upload", body: "One object, whole thing in frame." },
  { icon: Scissors, label: "Cut out", body: "rembg drops the background." },
  { icon: Box, label: "Shape", body: "Hunyuan3D-2.1 builds the mesh." },
  { icon: Paintbrush, label: "Texture", body: "The same model paints it, PBR." },
];

const POINTS = [
  { icon: Lock, title: "Private", body: "Yours alone. Nothing is public." },
  { icon: Download, title: "Real .glb", body: "Opens in Blender, Unity, three.js." },
  { icon: Cloud, title: "Cloud GPU", body: "Close the tab; it keeps going." },
];

/** What someone actually wants to know before signing up, in the order they
 * ask it. The third line is the one most pricing sections leave out. */
/** The spec line under the button.
 *
 * It held three reassurances - no card, ~90 seconds, refunds - and every one of
 * them was already written further down the page, so the row cost a line of the
 * fold and told a reader nothing new. These are facts that appear nowhere else
 * above it: what runs, what lands on disk, and who can see it. */
const SPECS = ["Textured .glb, 4–5 MB", "About 90 seconds", "Yours, not public"];

const OFFER = [
  `${FREE_CREDITS} generations, free.`,
  "A run that fails or is cancelled gives its credit back.",
  "No card, and nothing to buy yet.",
];

export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <LandingNav />

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 sm:px-6">
        {/* The pitch and the proof are one fold. The demo used to be a section
            below with its own heading, which made the best thing on the page
            something you had to scroll to find; the wash holds the two
            together so the headline and the turning mesh read as one claim. */}
        <div className="hero-wash relative">
          <section className="pb-10 pt-28 text-center sm:pt-36">
            <h1 className="mx-auto max-w-3xl font-display text-balance text-5xl font-bold leading-[1.02] tracking-[-0.02em] text-ink sm:text-7xl">
              Turn a photo into 3D
            </h1>
            {/* The subhead names what is actually doing the work. "A model you
                can spin and download out" described the output, which the
                headline and the demo directly below already show; what neither
                of them says is that this is somebody else's open model with a
                GPU and a download button attached. */}
            <p className="mx-auto mt-5 max-w-xl text-pretty text-lg leading-snug text-ink-soft">
              Tencent&rsquo;s open-weight Hunyuan3D-2.1, on a GPU you don&rsquo;t have to
              rent yourself.
            </p>

            <div className="mt-8 flex flex-col items-center justify-center gap-2.5 sm:flex-row sm:gap-3">
              <StartButton label={`Start free — ${FREE_CREDITS} models`} />
              <a
                href="#examples"
                className="focus-ring inline-flex h-12 items-center rounded-full px-6 text-base font-medium text-ink-soft transition-colors hover:bg-muted hover:text-ink"
              >
                See the output
              </a>
            </div>

            {/* Ticks would make these read as promises. They are specs, so they
                get the same middot rule the rest of the page's metadata uses. */}
            <ul className="mt-7 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-xs text-ink-muted">
              {SPECS.map((item, index) => (
                <li key={item} className="flex items-center gap-2.5">
                  {index > 0 && (
                    <span className="text-line-strong" aria-hidden>
                      ·
                    </span>
                  )}
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <section id="examples" className="scroll-mt-24 pb-6">
            <Showcase />
            <p className="mt-3 text-center text-xs text-ink-muted">
              Every mesh here came out of the same pipeline a run uses · about 90 seconds ·
              4–5 MB <code className="font-mono">.glb</code>
            </p>
          </section>
        </div>

        <InputGuide />

        <section id="how" className="mt-20 scroll-mt-24">
          <SectionHead kicker="How it works" title="Four steps, about 90 seconds" />
          <ol className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {STEPS.map((step, index) => (
              <li key={step.label} className="rounded-xl border border-line bg-surface p-4">
                <div className="flex items-center gap-2">
                  <span className="kicker tabular-nums">{index + 1}</span>
                  <step.icon className="size-4 text-brand" aria-hidden />
                </div>
                <h3 className="mt-2.5 font-display text-lg font-bold text-ink">
                  {step.label}
                </h3>
                <p className="mt-0.5 text-sm leading-snug text-ink-soft">{step.body}</p>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-sm leading-snug text-ink-soft">
            Steps 2–4 are open-weight models on a rented L40S —{" "}
            <a
              href="https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1"
              target="_blank"
              rel="noreferrer"
              className="focus-ring rounded font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
            >
              Hunyuan3D-2.1
            </a>{" "}
            for shape and texture, rembg for the cut-out. This app is the harness
            around them.
          </p>
        </section>

        {/* three things worth knowing, one line each */}
        <section id="what-you-get" className="mt-20 scroll-mt-24">
          <SectionHead kicker="What you get" title="A file you own" />
          <ul className="mt-6 grid gap-3 sm:grid-cols-3">
            {POINTS.map((point) => (
              <li key={point.title} className="rounded-xl border border-line bg-surface p-4">
                <point.icon className="size-4 text-brand" aria-hidden />
                <h3 className="mt-2.5 font-display text-lg font-bold text-ink">
                  {point.title}
                </h3>
                <p className="mt-0.5 text-sm leading-snug text-ink-soft">{point.body}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* the offer */}
        <section id="free" className="mb-24 mt-20 scroll-mt-24">
          <div className="rounded-2xl border border-line-strong bg-surface p-6 text-center sm:p-10">
            <p className="kicker">Pricing</p>
            <h2 className="mt-1.5 font-display text-balance text-3xl font-bold tracking-[-0.02em] text-ink sm:text-4xl">
              {FREE_CREDITS} models, free
            </h2>
            <ul className="mx-auto mt-4 max-w-sm space-y-1 text-sm text-ink-soft">
              {OFFER.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <div className="mt-6 flex justify-center">
              <StartButton />
            </div>
          </div>
        </section>
      </main>

      <LandingFooter />
    </div>
  );
}
