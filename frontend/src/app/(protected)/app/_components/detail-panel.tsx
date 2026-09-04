"use client";

/** The right-hand column: the photo the run came from, the pipeline strip
 * (photo → crops → scene), and - once an object is selected - that one
 * object's end-to-end story: the patch of photograph, the crop, the mesh that
 * came back and where it was placed.
 */

import { ChevronLeft, ChevronRight, Download, FileJson, Link2, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

const STATUS_DOT: Record<string, string> = {
  placed: "bg-moss",
  dropped: "bg-danger",
  orphan: "bg-honey",
};

const STATUS_WHY: Record<string, string> = {
  placed: "in the assembled scene",
  dropped: "reconstructed but not placed",
  orphan: "no matching entry in the spec",
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

/** A file the user can take away. Small, but there are four of them now and
 * they were all bespoke anchors before. */
function FileLink({
  href,
  download,
  icon: Icon,
  children,
}: {
  href: string;
  download?: string;
  icon: typeof Download;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      download={download}
      target={download ? undefined : "_blank"}
      rel="noreferrer"
      className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-paper px-2 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:bg-paper-deep hover:text-ink"
    >
      <Icon className="size-3.5 text-brand" aria-hidden /> {children}
    </a>
  );
}

function PipelineStrip({ run, selected, onSelect }: DetailPanelProps) {
  if (!run.items.length) return null;
  return (
    <div
      className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2"
      role="listbox"
      aria-label="Objects detected in this run"
    >
      {run.items.map((item) => {
        const active = item.name === selected;
        return (
          <button
            key={item.name}
            type="button"
            role="option"
            aria-selected={active}
            title={`${item.name} — ${STATUS_WHY[item.status] ?? item.status}`}
            onClick={() => onSelect(active ? null : item.name)}
            className="focus-ring group w-16 shrink-0 space-y-1 rounded-md text-left"
          >
            <div
              className={cn(
                "flex h-16 w-16 items-center justify-center overflow-hidden rounded-md bg-paper-deep ring-2 transition",
                active ? "ring-brand" : (STATUS_RING[item.status] ?? "ring-border"),
              )}
            >
              {item.crop?.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.crop.url}
                  alt=""
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              ) : (
                <span className="px-1 text-center text-[10px] leading-tight text-ink-muted">
                  {item.kind === "flat" ? "flat panel" : "no crop"}
                </span>
              )}
            </div>
            <p
              className={cn(
                "truncate text-[11px] leading-tight",
                active ? "font-semibold text-ink" : "text-ink-muted group-hover:text-ink",
              )}
            >
              {item.name}
            </p>
          </button>
        );
      })}
    </div>
  );
}

/** What the ring colors on the strip and the boxes on the photo mean. Three
 * statuses drawn only as colour is exactly the case the guidance warns about,
 * so they get named here once. */
function StatusLegend({ run }: { run: Run }) {
  const present = ["placed", "dropped", "orphan"].filter((status) =>
    run.items.some((item) => item.status === status),
  );
  if (present.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-muted">
      {present.map((status) => (
        <li key={status} className="flex items-center gap-1.5">
          <span className={cn("size-2 rounded-full", STATUS_DOT[status])} aria-hidden />
          {status} — {STATUS_WHY[status]}
        </li>
      ))}
    </ul>
  );
}

function ObjectStory({
  item,
  onClose,
  onStep,
  position,
}: {
  item: RunItem;
  onClose: () => void;
  onStep: (direction: 1 | -1) => void;
  position: { at: number; of: number } | null;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="font-display min-w-0 flex-1 truncate text-lg font-bold leading-tight text-ink">
          {item.name}
        </h3>
        {position && position.of > 1 && (
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous object"
              onClick={() => onStep(-1)}
            >
              <ChevronLeft />
            </Button>
            <span className="text-[11px] tabular-nums text-ink-muted">
              {position.at + 1}/{position.of}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next object"
              onClick={() => onStep(1)}
            >
              <ChevronRight />
            </Button>
          </div>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back to the whole run"
          className="shrink-0"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge
          className={cn(
            "border-transparent",
            item.status === "placed"
              ? "bg-moss/15 text-moss"
              : item.status === "orphan"
                ? "bg-honey/15 text-honey-ink"
                : "bg-danger/10 text-danger",
          )}
        >
          {item.status}
        </Badge>
        {item.kind === "flat" && <Badge variant="outline">textured panel</Badge>}
        {item.label && (
          <Badge variant="outline">
            {item.label}
            {item.score != null ? ` · ${(item.score * 100).toFixed(0)}%` : ""}
          </Badge>
        )}
      </div>

      {item.crop?.url && (
        <div className="overflow-hidden rounded-lg border bg-paper-deep">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.crop.url} alt={`crop of ${item.name}`} className="mx-auto max-h-44" />
        </div>
      )}

      <div className="space-y-1.5">
        <Row
          label="box"
          value={
            item.box_from === "detector"
              ? "recorded by the detector"
              : item.box_from === "matched"
                ? "recovered by matching the crop"
                : null
          }
        />
        <Row
          label="crop"
          value={item.crop ? `${item.crop.name} · ${formatBytes(item.crop.bytes)}` : null}
        />
        <Row
          label="mesh"
          value={
            item.mesh
              ? `${item.mesh.name} · ${formatBytes(item.mesh.bytes)}`
              : "none (skipped or failed)"
          }
        />
      </div>

      {item.mesh?.url && (
        <FileLink href={item.mesh.url} download={item.mesh.name} icon={Download}>
          Download this mesh
        </FileLink>
      )}

      {item.status === "placed" && (item.position || item.size) && (
        <>
          <Separator />
          <div className="space-y-1.5">
            <Row
              label="position"
              value={item.position ? item.position.map((v) => formatMetres(v)).join(", ") : null}
            />
            <Row label="target size" value={formatVec(item.size)} />
            <Row
              label="rotation"
              value={item.rotation_z ? `${((item.rotation_z * 180) / Math.PI).toFixed(0)}°` : "0°"}
            />
            <Row
              label="auto-orient"
              value={item.auto_orient == null ? null : item.auto_orient ? "yes" : "no"}
            />
          </div>
        </>
      )}

      {item.status === "dropped" && (
        <p className="font-display text-[13px] leading-snug text-ink-muted">
          Detected and reconstructed, but never placed - a mesh under 200 faces is dropped, or the
          object was edited out of the spec by hand.
        </p>
      )}
    </div>
  );
}

export function DetailPanel({ run, selected, onSelect }: DetailPanelProps) {
  const index = run.items.findIndex((candidate) => candidate.name === selected);
  const item = index >= 0 ? run.items[index] : null;
  const room = run.spec?.room ?? {};
  const roomEntries = Object.entries(room).filter(([, value]) =>
    ["number", "string", "boolean"].includes(typeof value),
  );
  const boxSource = run.items.some((i) => i.box_from === "detector")
    ? "boxes recorded by the detector"
    : run.items.some((i) => i.box_from === "matched")
      ? "boxes recovered by matching crops into the photo"
      : null;

  const step = (direction: 1 | -1) => {
    if (!run.items.length) return;
    const next = (index + direction + run.items.length) % run.items.length;
    onSelect(run.items[next].name);
  };

  /** The address bar already carries the run and the object; this just saves
   * the trip to it, which matters when the panel is a phone sheet. */
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success("Link copied", { description: "Opens on this exact object." });
    } catch {
      toast.error("Could not copy the link");
    }
  };

  return (
    <ScrollArea className="h-full">
      <div className="space-y-5 p-4 pb-safe">
        {run.photo ? (
          <Section title="Source photo">
            <PhotoWithBoxes
              photo={run.photo}
              items={run.items}
              selected={selected}
              onSelect={onSelect}
            />
            <StatusLegend run={run} />
            <p className="font-display text-[13px] leading-snug text-ink-muted">
              {run.photo.name}
              {run.photo.width ? ` · ${run.photo.width}×${run.photo.height}` : ""}
              {boxSource ? ` · ${boxSource}` : ""}
            </p>
          </Section>
        ) : (
          <p className="text-xs text-ink-muted">No source photo for this run.</p>
        )}

        {run.items.length > 0 && (
          <Section title="Pipeline · photo → crops → scene">
            <PipelineStrip run={run} selected={selected} onSelect={onSelect} />
          </Section>
        )}

        {item && (
          <>
            <Separator />
            <ObjectStory
              item={item}
              onClose={() => onSelect(null)}
              onStep={step}
              position={{ at: index, of: run.items.length }}
            />
          </>
        )}

        {!item && (
          <>
            <Separator />
            <Section title="Run">
              <div className="space-y-1.5">
                <Row label="id" value={run.id} />
                <Row label="kind" value={run.kind} />
                <Row
                  label="assembled GLB"
                  value={
                    run.render
                      ? `${run.render.name} · ${formatBytes(run.render.bytes)}`
                      : "not assembled"
                  }
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
                  <FileLink href={run.render.url} download={run.render.name} icon={Download}>
                    Download GLB
                  </FileLink>
                )}
                {run.spec?.url && (
                  <FileLink href={run.spec.url} icon={FileJson}>
                    scene.json
                  </FileLink>
                )}
                <button
                  type="button"
                  onClick={copyLink}
                  className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-paper px-2 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:bg-paper-deep hover:text-ink"
                >
                  <Link2 className="size-3.5 text-brand" aria-hidden /> Copy link
                </button>
              </div>
              {run.kind === "scene" && (
                <p className="font-display pt-1 text-[13px] leading-snug text-ink-muted">
                  A scene.json beside its GLB — edit it and rebuild with dioramic-assemble,
                  without re-running any model.
                </p>
              )}
              {run.kind === "images" && (
                <p className="font-display pt-1 text-[13px] leading-snug text-ink-muted">
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
