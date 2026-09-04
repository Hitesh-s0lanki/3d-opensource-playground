"use client";

/** The proof, on the landing page: a sample photo beside the mesh the app made
 * from it, turning.
 *
 * Every mesh here was produced by the same Modal pipeline a signed-in run
 * uses - nothing on this page is a mock-up, and the triangle count and file
 * size under them are read off the file being drawn. One is a drawing the New
 * run form also offers as a starter; the rest are finished runs kept for this
 * page alone, which is why their files sit in their own `public/showcase`
 * directory rather than among the starters.
 *
 * Accessibility and cost push the same way: the viewer is one canvas, not
 * three; it is built only once it scrolls into view; its loop stops when it
 * leaves again or the tab is hidden; and the photo beside it carries the whole
 * story for anyone who cannot or would rather not drag a 3D scene. Auto-spin
 * is suppressed under `prefers-reduced-motion` by the stage itself.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Box, Loader2, MousePointer2, Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBytes, formatCount } from "@/lib/format";
import { GlbStage, type StageStats } from "@/components/three/glb-stage";

/** The pairs that have a mesh worth showing beside them.
 *
 * Worth showing starts as a measurement - thinnest bounding-box side over
 * longest - and then gets looked at from the back, because depth and
 * correctness are not the same thing. A flat drawing that survives the trip
 * lands around 0.3-0.6; a picture of something already three-dimensional
 * starts with the depth cues the model needs and scores higher:
 *
 *   little-dino  guidance 3.5  0.379  solid on paper           <- pulled
 *   little-dino  guidance 2.0  0.463  deeper, face detaches
 *   little-dino  guidance 5.0  0.204  a relief
 *   tin-robot    guidance 2.0  0.247  clean, properly round    <- shipped
 *   tin-robot    guidance 5.0  0.061  a disc
 *   bowtie-cat   any           0.007  a sheet of paper         <- dropped
 *   raphael                    0.546  round, holds up behind   <- shipped
 *   orc-bust                   0.731  a true bust              <- shipped
 *   doraemon                   0.744  the roundest of the set  <- shipped
 *
 * The dino is the caveat on that first column: 0.379 sat inside the healthy
 * band, but turning on the page it still read as a cut-out, because the ratio
 * describes the bounding box and not how the volume is distributed inside it.
 * The number is a filter, not a verdict - nothing ships without being watched
 * through a full rotation. Its files stay under `public/samples`, where the
 * New run form still offers the drawing as a starter.
 *
 * The rest of that investigation, including what turned out not to be the
 * cause, is "Flat pictures make flat meshes" in the README.
 *
 * `base` is the stem the photo and the mesh share, so an entry can sit in
 * either directory without the component below having to know which. */
const SHOWCASE = [
  {
    id: "raphael",
    base: "/showcase/raphael",
    label: "Raphael",
    alt: "A red-masked cartoon turtle figurine holding a sai in each hand",
  },
  {
    id: "tin-robot",
    base: "/samples/tin-robot",
    label: "Tin robot",
    alt: "A drawn tin robot with an antenna and a dial",
  },
  {
    id: "orc-bust",
    base: "/showcase/orc-bust",
    label: "Orc bust",
    alt: "A tusked green orc bust wearing spiked leather shoulder armour",
  },
  {
    id: "doraemon",
    base: "/showcase/doraemon",
    label: "Doraemon",
    alt: "A round blue and white cat figurine with a red collar and a gold bell",
  },
] as const;

/** How long an example holds the stage before the next one takes it.
 *
 * The clock starts when the mesh has finished arriving rather than when it was
 * chosen, so a slow connection stretches the wait instead of skipping past the
 * model it just spent four megabytes fetching. Long enough to watch a figure
 * turn most of the way round; short enough that the next one arrives before
 * attention wanders. */
const DWELL_MS = 5200;

export function Showcase() {
  const [active, setActive] = useState(0);
  const [stats, setStats] = useState<StageStats | null>(null);
  const [bytes, setBytes] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const mount = useRef<HTMLDivElement>(null);
  const stage = useRef<GlbStage | null>(null);
  /** Set once the element has been seen, so the canvas is never built for a
   * visitor who never scrolls this far. */
  const [seen, setSeen] = useState(false);
  /** On screen, in a tab someone is actually looking at.
   *
   * The render loop already used this; the cycle needs it far more urgently.
   * Advancing off-screen would quietly pull every remaining mesh - about
   * nineteen megabytes - for a visitor who scrolled past the hero and never
   * looked back. */
  const [watching, setWatching] = useState(false);
  /** Whether the examples are still advancing on their own. Cleared the moment
   * the visitor takes the wheel, and restored only by the play button. */
  const [auto, setAuto] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);

  const sample = SHOWCASE[active];

  /** Something changing on its own every few seconds is exactly what this
   * setting asks us not to do, so the cycle is off entirely when it is set -
   * the chips still work, and nothing else about the panel changes. */
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const node = mount.current;
    if (!node) return;
    let onScreen = false;
    // Both signals decide both things, so they are settled in one place. The
    // tab handler used to consider only whether the tab was hidden, which
    // would restart the loop for a panel that had long since scrolled away.
    const settle = () => {
      const live = onScreen && !document.hidden;
      stage.current?.setRunning(live);
      setWatching(live);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting;
        if (entry.isIntersecting) setSeen(true);
        settle();
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    document.addEventListener("visibilitychange", settle);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", settle);
    };
  }, []);

  useEffect(() => {
    if (!seen || !mount.current || stage.current) return;
    stage.current = new GlbStage(mount.current, {
      onStats: setStats,
      onToggles: () => {},
      onError: () => {
        setFailed(true);
        setLoading(false);
      },
      onProgress: () => {},
      onPick: () => {},
      onHover: () => {},
    });
    stage.current.toggle("spin", true);
    return () => {
      stage.current?.dispose();
      stage.current = null;
    };
  }, [seen]);

  useEffect(() => {
    const current = stage.current;
    if (!current) return;
    let live = true;
    setLoading(true);
    setFailed(false);
    setBytes(null);
    const url = `${sample.base}.glb`;
    // The size shown is the size the user would download, so it is read from
    // the file rather than typed into the page.
    void fetch(url, { method: "HEAD" })
      .then((res) => {
        const length = res.headers.get("content-length");
        if (live && length) setBytes(Number(length));
      })
      .catch(() => {});
    void current
      .load(url, `${sample.id}.glb`)
      .then(() => live && setLoading(false))
      .catch(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [sample, seen]);

  /** Whether the carousel is currently due to move on. Every term in it is a
   * reason to hold still: nothing to cycle through, the visitor has taken
   * over, the panel is off screen, the mesh on screen has not finished
   * arriving, or the machine has asked for less motion. */
  const cycling =
    SHOWCASE.length > 1 && auto && watching && !loading && !failed && !reducedMotion;

  useEffect(() => {
    if (!cycling) return;
    const timer = setTimeout(() => {
      setActive((index) => (index + 1) % SHOWCASE.length);
      setStats(null);
    }, DWELL_MS);
    return () => clearTimeout(timer);
  }, [cycling, active]);

  const pick = useCallback((index: number) => {
    setActive(index);
    setStats(null);
    // Choosing one is also how you stop the thing moving.
    setAuto(false);
  }, []);

  /** Reaching into the scene is the other way to take the wheel. A carousel
   * that swaps the model out from under a drag is worse than one that never
   * moved at all. */
  const takeOver = useCallback(() => setAuto(false), []);

  return (
    <div className="rounded-2xl border border-line-strong bg-surface p-2 shadow-[0_24px_60px_-40px_rgb(31_36_48/0.45)] sm:p-3">
      <div className="grid gap-2 sm:grid-cols-2 sm:gap-3">
        {/* before */}
        {/* The mount is the drawings' own paper colour, so the letterboxing
            `object-contain` leaves is invisible rather than a pair of bands. */}
        <figure className="relative overflow-hidden rounded-xl bg-[#f1efe9]">
          <span className="kicker absolute left-3 top-3 z-10 rounded-full bg-surface/85 px-2 py-1 backdrop-blur">
            Photo
          </span>
          <Image
            // Keyed so each example mounts its own element and can fade in.
            // Without it React swaps the src under one node and the photo
            // changes in a hard cut.
            key={sample.id}
            src={`${sample.base}.png`}
            alt={sample.alt}
            width={1024}
            height={1024}
            sizes="(min-width: 640px) 50vw, 100vw"
            // The first is the image above the fold and the whole point of the
            // page; preloading the rest would fight the meshes for bandwidth
            // at exactly the wrong moment.
            priority={active === 0}
            className="aspect-[5/4] w-full animate-in fade-in object-contain duration-700"
          />
        </figure>

        {/* after */}
        <div className="relative aspect-[5/4] overflow-hidden rounded-xl bg-[var(--stage-bg)]">
          <span className="kicker absolute left-3 top-3 z-10 rounded-full bg-surface/85 px-2 py-1 backdrop-blur">
            3D model
          </span>
          <div
            ref={mount}
            onPointerDown={takeOver}
            className="size-full"
            role="img"
            aria-label={`A 3D model of ${sample.label}, slowly rotating. Drag to turn it yourself.`}
          />

          {(loading || failed) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-ink-muted">
              {failed ? (
                <>
                  <Box className="size-5" aria-hidden />
                  <p className="px-6 text-center text-xs">Could not load the model.</p>
                </>
              ) : (
                <>
                  <Loader2 className="size-5 animate-spin" aria-hidden />
                  <p className="text-xs">Loading the mesh…</p>
                </>
              )}
            </div>
          )}

          {!loading && !failed && (
            <p className="pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-surface/85 px-2.5 py-1 text-[11px] font-medium text-ink-muted backdrop-blur">
              <MousePointer2 className="size-3" aria-hidden /> drag to turn it
            </p>
          )}
        </div>
      </div>

      {/* How long the current one has left. The only thing on the page that
          says the view is about to change without being asked. */}
      <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-line/60 sm:mt-3" aria-hidden>
        {cycling && (
          <div
            key={active}
            className="h-full origin-left bg-brand/60"
            // Driven from the same constant as the timer, so the bar cannot
            // drift from the thing it is describing.
            style={{ animation: `dwell ${DWELL_MS}ms linear forwards` }}
          />
        )}
      </div>

      {/* switcher, and the numbers off the file on screen */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 pb-1 sm:mt-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Choose an example">
          {SHOWCASE.map((option, index) => (
            <button
              key={option.id}
              type="button"
              onClick={() => pick(index)}
              aria-pressed={index === active}
              className={cn(
                "focus-ring flex min-h-11 cursor-pointer items-center gap-2 rounded-full border py-1.5 pl-1.5 pr-3.5 text-xs font-medium transition-colors",
                index === active
                  ? "border-brand/40 bg-brand/10 text-brand-deep"
                  : "border-line-strong bg-surface text-ink-soft hover:bg-paper-deep",
              )}
            >
              <Image
                src={`${option.base}.png`}
                alt=""
                width={64}
                height={64}
                className="size-8 rounded-full bg-paper-deep object-cover"
              />
              {option.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 px-1">
          {/* Auto-advancing content needs a way to stop it that does not
              require guessing that clicking a chip will do it. */}
          {SHOWCASE.length > 1 && !reducedMotion && (
            <button
              type="button"
              onClick={() => setAuto((on) => !on)}
              aria-label={auto ? "Pause the examples" : "Play the examples"}
              className="focus-ring flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-line-strong bg-surface text-ink-soft transition-colors hover:bg-paper-deep"
            >
              {auto ? (
                <Pause className="size-3.5" aria-hidden />
              ) : (
                <Play className="size-3.5" aria-hidden />
              )}
            </button>
          )}

          <p className="text-[11px] tabular-nums text-ink-muted">
            {stats && !failed ? (
              <>
                {formatCount(stats.triangles)} triangles
                {bytes ? ` · ${formatBytes(bytes)}` : ""}
              </>
            ) : (
              " "
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
