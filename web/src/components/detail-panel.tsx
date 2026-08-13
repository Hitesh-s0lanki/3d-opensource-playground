"use client";

/** The right-hand column: the photo the run came from, the pipeline strip
 * (photo → crops → scene), and - once an object is selected - that one
 * object's end-to-end story: the patch of photograph, the crop, the mesh that
 * came back and where it was placed.
 */

import { Download, FileJson } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { formatBytes, formatMetres, formatVec } from "@/lib/format";
import type { Run, RunItem } from "@/lib/types";
import { PhotoWithBoxes } from "./photo-with-boxes";

interface DetailPanelProps {
  run: Run;
  selected: string | null;
  onSelect: (name: string | null) => void;
}

const STATUS_RING: Record<string, string> = {
  placed: "ring-moss/60",
  dropped: "ring-danger/70",
  orphan: "ring-honey/70",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="kicker">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === "") return null;
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-ink-muted">{label}</span>
      <span className="text-right font-medium text-ink-soft">{value}</span>
    </div>
  );
}

function PipelineStrip({ run, selected, onSelect }: DetailPanelProps) {
  if (!run.items.length) return null;
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {run.items.map((item) => (
        <button
          key={item.name}
          type="button"
          onClick={() => onSelect(item.name === selected ? null : item.name)}
          className={cn(
            "group w-16 shrink-0 space-y-1 text-left outline-none",
            "focus-visible:ring-2 focus-visible:ring-ring rounded-md",
          )}
        >
          <div
            className={cn(
              "flex h-16 w-16 items-center justify-center overflow-hidden rounded-md bg-paper-deep ring-2 transition",
              item.name === selected ? "ring-brand" : (STATUS_RING[item.status] ?? "ring-border"),
            )}
          >
            {item.crop?.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.crop.url}
                alt={item.name}
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : (
              <span className="px-1 text-center text-[10px] text-muted-foreground">
                {item.kind === "flat" ? "flat panel" : "no crop"}
              </span>
            )}
          </div>
          <p className="truncate text-[10px] leading-tight text-muted-foreground group-hover:text-foreground">
            {item.name}
          </p>
        </button>
      ))}
    </div>
  );
}

function ObjectStory({ item }: { item: RunItem }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="font-display truncate text-lg font-bold leading-tight text-ink">
          {item.name}
        </h3>
        <Badge
          className={cn(
            "border-transparent",
            item.status === "placed" ? "bg-moss/15 text-moss" : "bg-danger/10 text-danger",
          )}
        >
          {item.status}
        </Badge>
        {item.kind === "flat" && <Badge variant="outline">textured panel</Badge>}
      </div>

      {item.crop?.url && (
        <div className="overflow-hidden rounded-lg border bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.crop.url} alt={`crop of ${item.name}`} className="mx-auto max-h-44" />
        </div>
      )}

      <div className="space-y-1.5">
        <Row
          label="detected as"
          value={
            item.label
              ? `${item.label}${item.score != null ? ` · ${(item.score * 100).toFixed(0)}%` : ""}`
              : null
          }
        />
        <Row
          label="box"
          value={item.box_from === "detector" ? "recorded by the detector" : item.box_from === "matched" ? "recovered by matching the crop" : null}
        />
        <Row label="crop" value={item.crop ? `${item.crop.name} · ${formatBytes(item.crop.bytes)}` : null} />
        <Row
          label="mesh"
          value={item.mesh ? `${item.mesh.name} · ${formatBytes(item.mesh.bytes)}` : "none (skipped or failed)"}
        />
      </div>

      {item.status === "placed" && (item.position || item.size) && (
        <>
          <Separator />
          <div className="space-y-1.5">
            <Row label="position" value={item.position ? item.position.map((v) => formatMetres(v)).join(", ") : null} />
            <Row label="target size" value={formatVec(item.size)} />
            <Row
              label="rotation"
              value={item.rotation_z ? `${((item.rotation_z * 180) / Math.PI).toFixed(0)}°` : "0°"}
            />
            <Row label="auto-orient" value={item.auto_orient == null ? null : item.auto_orient ? "yes" : "no"} />
          </div>
        </>
      )}

      {item.status === "dropped" && (
        <p className="font-display text-[13px] italic leading-snug text-ink-muted">
          Detected and reconstructed, but never placed - a mesh under 200 faces is dropped, or the
          object was edited out of the spec by hand.
        </p>
      )}
    </div>
  );
}

export function DetailPanel({ run, selected, onSelect }: DetailPanelProps) {
  const item = run.items.find((candidate) => candidate.name === selected) ?? null;
  const room = run.spec?.room ?? {};
  const roomEntries = Object.entries(room).filter(([, value]) =>
    ["number", "string", "boolean"].includes(typeof value),
  );
  const boxSource = run.items.some((i) => i.box_from === "detector")
    ? "boxes recorded by the detector"
    : run.items.some((i) => i.box_from === "matched")
      ? "boxes recovered by matching crops into the photo"
      : null;

  return (
    <ScrollArea className="h-full">
      <div className="space-y-5 p-4">
        {run.photo ? (
          <Section title="Source photo">
            <PhotoWithBoxes photo={run.photo} items={run.items} selected={selected} onSelect={onSelect} />
            <p className="font-display text-[13px] italic leading-snug text-ink-muted">
              {run.photo.name}
              {run.photo.width ? ` · ${run.photo.width}×${run.photo.height}` : ""}
              {boxSource ? ` · ${boxSource}` : ""}
            </p>
          </Section>
        ) : (
          <p className="text-xs text-muted-foreground">
            No source photo found in inputs/ for this run.
          </p>
        )}

        {run.items.length > 0 && (
          <Section title="Pipeline · photo → crops → scene">
            <PipelineStrip run={run} selected={selected} onSelect={onSelect} />
          </Section>
        )}

        {item && (
          <>
            <Separator />
            <ObjectStory item={item} />
          </>
        )}

        {!item && (
          <>
            <Separator />
            <Section title="Run">
              <div className="space-y-1.5">
                <Row label="kind" value={run.kind} />
                <Row
                  label="assembled GLB"
                  value={run.render ? `${run.render.name} · ${formatBytes(run.render.bytes)}` : "not assembled"}
                />
                <Row
                  label="objects"
                  value={
                    run.items.length
                      ? `${run.items.filter((i) => i.status === "placed").length} placed · ${run.items.filter((i) => i.status === "dropped").length} dropped`
                      : null
                  }
                />
                {roomEntries.map(([key, value]) => (
                  <Row key={key} label={`room ${key}`} value={String(value)} />
                ))}
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                {run.render?.url && (
                  <a
                    href={run.render.url}
                    download={run.render.name}
                    className="inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-paper px-2 py-1 text-xs font-medium text-ink-soft transition-colors hover:bg-paper-deep hover:text-ink"
                  >
                    <Download className="size-3.5 text-brand" /> Download GLB
                  </a>
                )}
                {run.spec?.url && (
                  <a
                    href={run.spec.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-paper px-2 py-1 text-xs font-medium text-ink-soft transition-colors hover:bg-paper-deep hover:text-ink"
                  >
                    <FileJson className="size-3.5 text-brand" /> scene.json
                  </a>
                )}
              </div>
              {run.kind === "scene" && (
                <p className="font-display pt-1 text-[13px] italic leading-snug text-ink-muted">
                  A scene.json beside its GLB — edit it and rebuild with dreamspace-assemble,
                  without re-running any model.
                </p>
              )}
              {run.kind === "images" && (
                <p className="font-display pt-1 text-[13px] italic leading-snug text-ink-muted">
                  Crops with no scene.json — from a run that did not finish.
                </p>
              )}
            </Section>
          </>
        )}
      </div>
    </ScrollArea>
  );
}
