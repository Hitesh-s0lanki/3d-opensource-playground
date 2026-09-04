"use client";

/** The + New form: an image, Single object or Whole room, and the flags that
 * matter for each. A wide image preselects Whole room, since that is what
 * wide usually means. Submitting uploads the image and queues the same CLI
 * you would have typed.
 *
 * The figurine step in the middle is the one part that is not a flag. It calls
 * an image model, which costs money and redraws the character rather than
 * photographing it, so it is shown before it is used: the render appears here
 * and only becomes the job's input if the user looks at it and keeps it. See
 * `lib/stylize.ts` for why it helps at all.
 */

import { useEffect, useRef, useState } from "react";
import { FileImage, Sparkles, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { IMAGE_ACCEPT, isDisplayable } from "@/lib/image-input";
import { SAMPLES, sampleAsFile, sampleSrc, type Sample } from "@/lib/samples";
import type { CreditsSnapshot, JobKind, StylizePayload } from "@/lib/types";

interface NewRunDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** An image dropped onto the viewport, preselected into the form. */
  initialFile: File | null;
  /** The room pipeline runs Blender and has no cloud implementation yet, so
   * the option is shown but not selectable. */
  roomAvailable: boolean;
  /** Whether OPENAI_API_KEY is set on the server. The figurine step is hidden
   * rather than disabled when it is not: a run without it still works, and an
   * option that can never be taken is only clutter. */
  stylizeAvailable: boolean;
  /** The free allowance. Generating spends one; at zero the form still opens
   * but cannot be submitted, which is kinder than a disabled + New button that
   * cannot say why. Null until the first poll answers. */
  credits: CreditsSnapshot | null;
  onSubmitted: () => void;
}

const MC_RESOLUTIONS = { default: "default", "128": "128 · fast", "192": "192", "256": "256 · fine" };
/** How literally the shape model must obey the picture.
 *
 * Upstream's 5.0 is tuned for photographs, where every shadow is a depth cue
 * worth obeying. A flat drawing has none, so obeying it literally returns a
 * relief - a cel-shaded cat came back 20 mm deep against 1.5 m wide. Loosening
 * this lets the model's own 3D prior fill the figure out: the same drawing at
 * 2.0 measured 2.3x deeper.
 *
 * A figurine render inverts that again. It has shading, so there is something
 * worth obeying and the default is right for it - which is the hint under the
 * control when one is in hand. */
const GUIDANCE = {
  default: "strict · photos",
  "3": "balanced",
  "2": "loose · flat art",
};
const WALLS = { auto: "auto · far wall + the one with art", all: "all · closed box", none: "none · furniture only" };

interface Figurine {
  /** data: URL, straight from /api/stylize. Never stored server-side. */
  url: string;
  name: string;
  remainingToday: number;
}

export function NewRunDialog({
  open,
  onOpenChange,
  initialFile,
  roomAvailable,
  stylizeAvailable,
  credits,
  onSubmitted,
}: NewRunDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  // A HEIC off an iPhone is a perfectly good upload that Chrome cannot draw.
  // When that happens the drop zone says so rather than showing a broken
  // image, since the file is going to work regardless - the server converts it.
  const [undrawable, setUndrawable] = useState(false);
  const [kind, setKind] = useState<JobKind>("object");
  // A sample is only a file the app fetched on your behalf, so it lives in
  // the same `file` state as an upload. These two just remember which tile to
  // mark and which one is still downloading.
  const [sampleId, setSampleId] = useState<string | null>(null);
  const [loadingSample, setLoadingSample] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // figurine step
  const [wantFigurine, setWantFigurine] = useState(false);
  const [figurine, setFigurine] = useState<Figurine | null>(null);
  const [rendering, setRendering] = useState(false);

  // object flags
  const [mcResolution, setMcResolution] = useState("default");
  const [guidance, setGuidance] = useState("default");
  const [noTexture, setNoTexture] = useState(false);
  // room flags
  const [fov, setFov] = useState("");
  const [threshold, setThreshold] = useState("");
  const [walls, setWalls] = useState("auto");
  const [decimate, setDecimate] = useState("");
  const [labels, setLabels] = useState("");

  const fileInput = useRef<HTMLInputElement>(null);

  const takeFile = (next: File | null, from: string | null = null) => {
    setFile(next);
    setSampleId(from);
    setUndrawable(false);
    // A figurine belongs to the image it was rendered from, so a new file
    // invalidates it. Leaving it would let someone pick a second image and
    // generate the first one's figurine without noticing.
    setFigurine(null);
    if (!next) {
      setPreview(null);
      return;
    }
    if (!isDisplayable(next)) {
      setPreview(null);
      setUndrawable(true);
      return;
    }
    const url = URL.createObjectURL(next);
    setPreview(url);
    // A wide image is almost always a room, not an object - but only offer
    // that when the room pipeline can actually run.
    if (!roomAvailable) return;
    const probe = new Image();
    probe.onload = () => {
      if (probe.naturalWidth >= probe.naturalHeight * 1.5) setKind("room");
    };
    probe.src = url;
  };

  /** Hand a sample in as if it had been chosen from disk: `sampleAsFile`
   * fetches it into a File, so every path after this - the preview, the
   * figurine step, the upload - is the one a real photo takes. */
  const chooseSample = async (sample: Sample) => {
    setLoadingSample(sample.id);
    try {
      takeFile(await sampleAsFile(sample), sample.id);
    } catch (exc) {
      toast.error("Could not load that sample", {
        description: exc instanceof Error ? exc.message : String(exc),
      });
    } finally {
      setLoadingSample(null);
    }
  };

  useEffect(() => {
    if (open) takeFile(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFile]);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  const outOfCredits = credits !== null && credits.remaining <= 0;
  /** The switch is on but there is nothing to send yet. Submitting now would
   * quietly upload the original, which is the opposite of what the switch
   * says, so the button waits instead. */
  const figurinePending = kind === "object" && wantFigurine && !figurine;

  const renderFigurine = async (source: File) => {
    setRendering(true);
    try {
      const form = new FormData();
      form.set("file", source, source.name);
      const res = await fetch("/api/stylize", { method: "POST", body: form });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 402 means the balance on screen was stale - someone generated in
        // another tab. Pull the real one before showing the error.
        if (res.status === 402) onSubmitted();
        throw new Error(payload.error ?? `HTTP ${res.status}`);
      }
      const { image, name, remaining_today } = payload as StylizePayload;
      setFigurine({ url: image, name, remainingToday: remaining_today });
    } catch (exc) {
      toast.error("Could not render the figurine", {
        description: exc instanceof Error ? exc.message : String(exc),
      });
    } finally {
      setRendering(false);
    }
  };

  /** Turning the switch on is the request - there is no second button to
   * press first. Turning it off keeps the render in hand, so changing your
   * mind twice does not cost two calls. */
  const toggleFigurine = (on: boolean) => {
    setWantFigurine(on);
    if (on && file && !figurine && !rendering) void renderFigurine(file);
  };

  const submit = async () => {
    if (!file) {
      toast.error("Choose an image first");
      return;
    }
    setBusy(true);
    try {
      let upload = file;
      const form = new FormData();
      if (kind === "object" && wantFigurine && figurine) {
        // Back through fetch() because a data: URL is the one thing that turns
        // into a Blob without hand-decoding the base64.
        const blob = await (await fetch(figurine.url)).blob();
        upload = new File([blob], figurine.name, { type: "image/png" });
        // Recorded on the job so its options say which image made the mesh.
        form.set("stylized", "true");
      }
      form.set("file", upload, upload.name);
      form.set("kind", kind);
      if (kind === "object") {
        if (mcResolution !== "default") form.set("mc_resolution", mcResolution);
        if (guidance !== "default") form.set("guidance_scale", guidance);
        if (noTexture) form.set("no_texture", "true");
      } else {
        if (fov) form.set("fov", fov);
        if (threshold) form.set("threshold", threshold);
        if (walls !== "auto") form.set("walls", walls);
        if (decimate) form.set("decimate", decimate);
        if (labels.trim()) form.set("labels", labels.trim());
      }
      const res = await fetch("/api/jobs", { method: "POST", body: form });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 402) onSubmitted();
        throw new Error(payload.error ?? `HTTP ${res.status}`);
      }
      toast.success("Queued", {
        description: `${upload.name} → ${kind === "room" ? "whole room" : "single object"}`,
      });
      onOpenChange(false);
      onSubmitted();
    } catch (exc) {
      toast.error("Could not start the job", {
        description: exc instanceof Error ? exc.message : String(exc),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl font-bold text-ink">New run</DialogTitle>
          <DialogDescription className="font-display text-[14px] leading-snug text-ink-muted">
            The upload goes straight to blob storage and queues a job on a
            rented GPU. One generation costs one credit
            {credits ? `, and you have ${credits.remaining} of ${credits.granted} left` : ""}.
          </DialogDescription>
        </DialogHeader>

        {/* Two columns. At one this form is eleven controls stacked into a
            scroll, and the image - the only part that is not optional - ends
            up above the fold on its own. Left is what goes in, right is how
            it gets made. */}
        <div className="grid gap-5 sm:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <div className="space-y-3">
            {/* image */}
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="flex min-h-24 w-full items-center justify-center overflow-hidden rounded-lg border border-dashed bg-muted/50 p-2 hover:bg-muted"
            >
              {preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={preview}
                  alt="upload preview"
                  className="max-h-40 rounded-md"
                  onError={() => {
                    setPreview(null);
                    setUndrawable(true);
                  }}
                />
              ) : undrawable && file ? (
                <span className="flex flex-col items-center gap-1 px-3 py-2 text-center">
                  <FileImage className="size-5 text-muted-foreground" />
                  <span className="text-sm font-medium">{file.name}</span>
                  <span className="text-[11px] leading-tight text-muted-foreground">
                    This browser cannot preview that format — it will be converted
                    when you generate.
                  </span>
                </span>
              ) : (
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Upload className="size-4" /> Choose an image…
                </span>
              )}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept={IMAGE_ACCEPT}
              className="hidden"
              onChange={(event) => takeFile(event.target.files?.[0] ?? null)}
            />
            {/* A tester should not have to go and find a photo before they can
                see what the thing does - and this being their first credit is
                why the tiles are lit character renders and not the flat
                drawings sitting beside them in the folder, which the landing
                page holds up as the input that fails. lib/samples.ts has the
                brief. */}
            <div className="space-y-2">
              <p className="text-[11px] text-muted-foreground">
                No image handy? Start with one of these.
              </p>
              <ul className="grid grid-cols-3 gap-2">
                {SAMPLES.map((sample) => (
                  <li key={sample.id}>
                    <button
                      type="button"
                      onClick={() => void chooseSample(sample)}
                      disabled={loadingSample !== null}
                      title={sample.label}
                      className={`focus-ring w-full overflow-hidden rounded-lg border p-1 transition-colors disabled:opacity-60 ${
                        sampleId === sample.id
                          ? "border-ring bg-accent"
                          : "bg-muted/40 hover:bg-muted"
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={sampleSrc(sample)}
                        alt={sample.label}
                        loading="lazy"
                        className="aspect-square w-full rounded object-contain"
                      />
                      <span className="mt-1 block truncate text-[10px] leading-tight text-muted-foreground">
                        {loadingSample === sample.id ? "Loading…" : sample.label}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="space-y-3">
            {/* kind */}
            <RadioGroup
              value={kind}
              onValueChange={(value) => setKind(value as JobKind)}
              className="grid grid-cols-2 gap-2"
            >
              {(
                [
                  ["object", "Single object", "one image → one mesh"],
                  ["room", "Whole room", "not in the cloud yet — needs Blender"],
                ] as const
              ).map(([value, title, hint]) => {
                const disabled = value === "room" && !roomAvailable;
                return (
                  <Label
                    key={value}
                    className={`flex flex-col items-start gap-1 rounded-lg border p-3 ${
                      disabled
                        ? "cursor-not-allowed opacity-50"
                        : `cursor-pointer ${kind === value ? "border-ring bg-accent" : "hover:bg-muted/60"}`
                    }`}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <RadioGroupItem value={value} disabled={disabled} /> {title}
                    </span>
                    <span className="text-[11px] leading-tight text-muted-foreground">{hint}</span>
                  </Label>
                );
              })}
            </RadioGroup>

            {/* per-kind flags */}
            {kind === "object" ? (
              <div className="space-y-3">
                {stylizeAvailable && (
                  <div className="space-y-3 rounded-lg border p-3">
                    <Label className="flex items-start justify-between gap-3">
                      <span className="space-y-1">
                        <span className="flex items-center gap-1.5 text-sm font-medium">
                          <Sparkles className="size-3.5" /> Render as a figurine first
                        </span>
                        <span className="block text-[11px] leading-tight text-muted-foreground">
                          The shape model reads depth out of shading, and a flat
                          drawing has none — which is why one comes back as a
                          relief. This redraws yours as a lit vinyl figure, turned
                          three-quarters on and already cut out, and sends that to
                          the GPU instead.
                        </span>
                      </span>
                      <Switch
                        checked={wantFigurine}
                        onCheckedChange={toggleFigurine}
                        disabled={!file || rendering}
                      />
                    </Label>

                    {wantFigurine && (
                      <div className="space-y-2">
                        <div className="flex min-h-32 items-center justify-center overflow-hidden rounded-md border bg-muted/40 p-2">
                          {rendering ? (
                            <span className="animate-pulse text-[12px] text-muted-foreground">
                              Rendering the figurine — this takes 15–40 seconds…
                            </span>
                          ) : figurine ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={figurine.url}
                              alt="figurine render"
                              className="max-h-44 rounded"
                            />
                          ) : (
                            <span className="px-3 text-center text-[12px] text-muted-foreground">
                              No figurine yet — the render did not finish. Try
                              again, or switch this off to use your image as it is.
                            </span>
                          )}
                        </div>
                        {figurine && !rendering && (
                          <p className="text-[11px] leading-tight text-muted-foreground">
                            This is what goes to the GPU, not the image above. The
                            model redraws the character rather than photographing
                            it, so check the face and the outfit before you spend
                            a credit.
                          </p>
                        )}
                        <div className="flex items-center justify-between gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={!file || rendering}
                            onClick={() => file && void renderFigurine(file)}
                          >
                            {rendering ? "Rendering…" : figurine ? "Try another" : "Render figurine"}
                          </Button>
                          {figurine && (
                            <span className="text-[11px] text-muted-foreground">
                              {figurine.remainingToday} left today
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-3 items-end gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Marching-cubes resolution</Label>
                    <Select items={MC_RESOLUTIONS} value={mcResolution} onValueChange={(v) => setMcResolution(v as string)}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(MC_RESOLUTIONS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Follow the picture</Label>
                    <Select items={GUIDANCE} value={guidance} onValueChange={(v) => setGuidance(v as string)}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(GUIDANCE).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Texture</Label>
                    {/* Sized like the two selects beside it rather than left as
                        a bare switch, so the row reads as three controls. */}
                    <Label className="flex h-8 cursor-pointer items-center justify-between gap-2 rounded-lg border border-input px-2.5 text-xs">
                      Skip it
                      <Switch checked={noTexture} onCheckedChange={setNoTexture} />
                    </Label>
                  </div>
                </div>
                <p className="text-[11px] leading-tight text-muted-foreground">
                  {wantFigurine && figurine ? (
                    <>
                      A figurine carries its own shading, so <em>strict</em> is
                      right for it — the loose settings are for sending flat
                      artwork to the GPU untouched.
                    </>
                  ) : (
                    <>
                      A photograph carries its own depth, so <em>strict</em> is
                      right for one. Flat artwork carries none and comes back as a
                      relief — loosen it and the model fills the shape out itself.
                    </>
                  )}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">FOV °</Label>
                    <Input
                      inputMode="decimal"
                      placeholder="85"
                      value={fov}
                      onChange={(event) => setFov(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Threshold</Label>
                    <Input
                      inputMode="decimal"
                      placeholder="0.35"
                      value={threshold}
                      onChange={(event) => setThreshold(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Decimate</Label>
                    <Input
                      inputMode="decimal"
                      placeholder="0.2"
                      value={decimate}
                      onChange={(event) => setDecimate(event.target.value)}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 items-end gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Walls</Label>
                    <Select items={WALLS} value={walls} onValueChange={(v) => setWalls(v as string)}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(WALLS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Labels (optional)</Label>
                    <Input
                      placeholder="bed, wardrobe, lamp"
                      value={labels}
                      onChange={(event) => setLabels(event.target.value)}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {outOfCredits && (
          <p
            role="status"
            className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] leading-snug text-danger"
          >
            No credits left — all {credits?.granted} free generations on this
            account are spent. Runs that fail or that you cancel give their
            credit back.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !file || outOfCredits || figurinePending}>
            {busy
              ? "Uploading…"
              : outOfCredits
                ? "No credits left"
                : figurinePending
                  ? rendering
                    ? "Rendering figurine…"
                    : "Render the figurine first"
                  : wantFigurine
                    ? "Generate from figurine"
                    : "Generate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
