"use client";

/** The + New form: an image, Single object or Whole room, and the flags that
 * matter for each. A wide image preselects Whole room, since that is what
 * wide usually means. Submitting uploads the image and queues the same CLI
 * you would have typed.
 */

import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
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
import type { JobKind } from "@/lib/types";

interface NewRunDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** An image dropped onto the viewport, preselected into the form. */
  initialFile: File | null;
  onSubmitted: () => void;
}

const MC_RESOLUTIONS = { default: "default", "128": "128 · fast", "192": "192", "256": "256 · fine" };
const WALLS = { auto: "auto · far wall + the one with art", all: "all · closed box", none: "none · furniture only" };

export function NewRunDialog({ open, onOpenChange, initialFile, onSubmitted }: NewRunDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [kind, setKind] = useState<JobKind>("object");
  const [busy, setBusy] = useState(false);

  // object flags
  const [mcResolution, setMcResolution] = useState("default");
  const [noTexture, setNoTexture] = useState(false);
  // room flags
  const [fov, setFov] = useState("");
  const [threshold, setThreshold] = useState("");
  const [walls, setWalls] = useState("auto");
  const [decimate, setDecimate] = useState("");
  const [labels, setLabels] = useState("");

  const fileInput = useRef<HTMLInputElement>(null);

  const takeFile = (next: File | null) => {
    setFile(next);
    if (!next) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(next);
    setPreview(url);
    // A wide image is almost always a room, not an object.
    const probe = new Image();
    probe.onload = () => {
      if (probe.naturalWidth >= probe.naturalHeight * 1.5) setKind("room");
    };
    probe.src = url;
  };

  useEffect(() => {
    if (open) takeFile(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFile]);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  const submit = async () => {
    if (!file) {
      toast.error("Choose an image first");
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file, file.name);
      form.set("kind", kind);
      if (kind === "object") {
        if (mcResolution !== "default") form.set("mc_resolution", mcResolution);
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
      if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`);
      toast.success("Queued", { description: `${file.name} → ${kind === "room" ? "whole room" : "single object"}` });
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl font-bold text-ink">New run</DialogTitle>
          <DialogDescription className="font-display text-[14px] italic leading-snug text-ink-muted">
            The upload lands in inputs/ and runs the same command you would have typed. Jobs run
            one at a time — a 4 GB card fits one reconstruction.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* image */}
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="flex min-h-24 w-full items-center justify-center overflow-hidden rounded-lg border border-dashed bg-muted/50 p-2 hover:bg-muted"
          >
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="upload preview" className="max-h-40 rounded-md" />
            ) : (
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Upload className="size-4" /> Choose an image…
              </span>
            )}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".png,.jpg,.jpeg,.webp,.bmp,image/*"
            className="hidden"
            onChange={(event) => takeFile(event.target.files?.[0] ?? null)}
          />

          {/* kind */}
          <RadioGroup
            value={kind}
            onValueChange={(value) => setKind(value as JobKind)}
            className="grid grid-cols-2 gap-2"
          >
            {(
              [
                ["object", "Single object", "one image → one mesh"],
                ["room", "Whole room", "detect → reconstruct → layout → assemble"],
              ] as const
            ).map(([value, title, hint]) => (
              <Label
                key={value}
                className={`flex cursor-pointer flex-col items-start gap-1 rounded-lg border p-3 ${kind === value ? "border-ring bg-accent" : "hover:bg-muted/60"}`}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <RadioGroupItem value={value} /> {title}
                </span>
                <span className="text-[11px] leading-tight text-muted-foreground">{hint}</span>
              </Label>
            ))}
          </RadioGroup>

          {/* per-kind flags */}
          {kind === "object" ? (
            <div className="grid grid-cols-2 items-end gap-3">
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
              <Label className="flex h-8 items-center justify-between gap-2 text-xs">
                No texture (much lighter)
                <Switch checked={noTexture} onCheckedChange={setNoTexture} />
              </Label>
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
                <Label className="text-xs">Labels (optional, comma-separated)</Label>
                <Input
                  placeholder="bed, wardrobe, lamp"
                  value={labels}
                  onChange={(event) => setLabels(event.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !file}>
            {busy ? "Uploading…" : "Generate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
