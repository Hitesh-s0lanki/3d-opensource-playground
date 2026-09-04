"use client";

/** The centre column: the mesh, in 3D, plus the inspection toolbar and the
 * keyboard shortcuts of the original viewer (F/W/G/B/E/R, 1-4, ↑/↓).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Camera,
  Contrast,
  Download,
  Grid3x3,
  Keyboard,
  Loader2,
  Focus,
  Maximize2,
  Minimize2,
  MousePointerClick,
  RotateCw,
  Scan,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatCount, formatVec } from "@/lib/format";
import { looksLikeImage } from "@/lib/image-input";
import {
  DEFAULT_TOGGLES,
  GlbStage,
  type StageStats,
  type StageToggles,
  type ViewName,
} from "@/components/three/glb-stage";
import { GeneratingOverlay } from "./generating-overlay";
import type { JobSnapshot } from "@/lib/types";

interface StageProps {
  src: string | null;
  name: string | null;
  /** The part currently selected elsewhere in the app, mirrored into the scene. */
  activePart: string | null;
  /** A part was clicked in the 3D scene. */
  onPickPart: (name: string | null) => void;
  /** ↑/↓ move through the run's objects; null disables them. */
  onStep: ((direction: 1 | -1) => void) | null;
  onDropImage: (file: File) => void;
  /** Opens the new-run dialog from the empty state's call to action. */
  onNew: () => void;
  /** Shown as a download button once something real is on screen. */
  download: { url: string; name: string } | null;
  /** Opens the shortcut reference. */
  onShowShortcuts: () => void;
  /** Runs still out at the GPU, newest first. The viewport is the only panel
   * that is always on screen, so it is where a generation in flight has to be
   * visible - as the whole empty state when there is nothing else to show, and
   * as a pill in the corner when there is. */
  liveJobs: JobSnapshot[];
}

const TOOLS: {
  key: keyof StageToggles;
  label: string;
  hotkey: string;
  icon: typeof Grid3x3;
}[] = [
  { key: "wireframe", label: "Wireframe", hotkey: "W", icon: Scan },
  { key: "grid", label: "Ground grid", hotkey: "G", icon: Grid3x3 },
  { key: "bbox", label: "Bounding box", hotkey: "B", icon: Box },
  { key: "backdrop", label: "Flip backdrop", hotkey: "E", icon: Contrast },
  { key: "spin", label: "Spin", hotkey: "R", icon: RotateCw },
];

const VIEW_KEYS: { view: ViewName; label: string; hotkey: string }[] = [
  { view: "iso", label: "Iso", hotkey: "1" },
  { view: "front", label: "Front", hotkey: "2" },
  { view: "right", label: "Side", hotkey: "3" },
  { view: "top", label: "Top", hotkey: "4" },
];

function isTyping(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (el as HTMLElement).isContentEditable ||
    el.closest("[role=dialog]") !== null
  );
}

/** One icon button in the floating toolbar. Icon-only, so the accessible name
 * has to come from `label` - the tooltip is a hover affordance, not a name,
 * and never appears on touch at all. */
function ToolButton({
  label,
  hotkey,
  active,
  onClick,
  children,
}: {
  label: string;
  hotkey?: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={hotkey ? `${label} (${hotkey})` : label}
            aria-pressed={active === undefined ? undefined : active}
            className={cn(
              "size-9 sm:size-8",
              active && "bg-accent text-accent-foreground",
            )}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {hotkey ? ` — ${hotkey}` : ""}
      </TooltipContent>
    </Tooltip>
  );
}

const PILL =
  "flex items-center gap-0.5 rounded-xl border border-line-strong bg-surface/90 p-1 shadow-sm backdrop-blur";

export function Stage({
  src,
  name,
  activePart,
  onPickPart,
  onStep,
  onDropImage,
  onNew,
  download,
  onShowShortcuts,
  liveJobs,
}: StageProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<GlbStage | null>(null);
  const [stats, setStats] = useState<StageStats | null>(null);
  const [toggles, setToggles] = useState<StageToggles>(DEFAULT_TOGGLES);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  // A dropped .glb takes over the viewport until the selection changes.
  const [droppedName, setDroppedName] = useState<string | null>(null);

  // The pick handler is re-created on every render; the stage is constructed
  // once, so it reads the current one out of a ref instead of being rebuilt.
  const pickRef = useRef(onPickPart);
  useEffect(() => {
    pickRef.current = onPickPart;
  }, [onPickPart]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const stage = new GlbStage(container, {
      onStats: setStats,
      onToggles: (next) => setToggles({ ...next }),
      onProgress: setProgress,
      onPick: (part) => pickRef.current(part),
      onHover: setHovered,
      onError: (message) => {
        setLoading(false);
        toast.error("Could not load mesh", { description: message });
      },
    });
    stageRef.current = stage;
    return () => {
      stageRef.current = null;
      stage.dispose();
    };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    setDroppedName(null);
    if (!src) {
      stage.clear();
      setLoading(false);
      return;
    }
    setLoading(true);
    setProgress(null);
    void stage.load(src, name ?? "mesh").finally(() => {
      setLoading(false);
      setProgress(null);
    });
  }, [src, name]);

  useEffect(() => {
    stageRef.current?.highlight(activePart);
  }, [activePart, src]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen().catch(() => {});
  }, []);

  const snapshot = useCallback(() => {
    const data = stageRef.current?.snapshot();
    if (!data) {
      toast.error("Nothing on the stage to capture");
      return;
    }
    const anchor = document.createElement("a");
    anchor.href = data;
    anchor.download = `${(droppedName ?? name ?? "mesh").replace(/[^\w.-]+/g, "-")}.png`;
    anchor.click();
    toast.success("Snapshot saved");
  }, [droppedName, name]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping()) return;
      const stage = stageRef.current;
      if (!stage) return;
      const key = event.key.toLowerCase();
      const tool = TOOLS.find((t) => t.hotkey.toLowerCase() === key);
      const view = VIEW_KEYS.find((v) => v.hotkey === event.key);
      if (tool) stage.toggle(tool.key);
      else if (view) stage.view(view.view);
      else if (key === "f") stage.focusSelection();
      else if (key === "s") snapshot();
      else if (event.key === "?") onShowShortcuts();
      else if (event.key === "Escape" && activePart) pickRef.current(null);
      else if (event.key === "ArrowUp" && onStep) onStep(-1);
      else if (event.key === "ArrowDown" && onStep) onStep(1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStep, snapshot, onShowShortcuts, activePart]);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (!file) return;
      const lower = file.name.toLowerCase();
      if (lower.endsWith(".glb") || lower.endsWith(".gltf")) {
        setLoading(true);
        setDroppedName(file.name);
        void stageRef.current?.loadFile(file).finally(() => setLoading(false));
      } else if (looksLikeImage(file)) {
        onDropImage(file);
      } else {
        toast.error("Drop a .glb to inspect it, or an image to generate from it");
      }
    },
    [onDropImage],
  );

  const shown = droppedName ?? name;
  const empty = !src && !droppedName && !loading;
  const generating = liveJobs[0] ?? null;
  const pickable = (stats?.parts ?? 0) > 1;

  return (
    <div
      ref={rootRef}
      className="relative h-full min-w-0 flex-1 overflow-hidden bg-paper-deep"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div ref={containerRef} className="absolute inset-0" />

      {/* Toolbars. On a phone they sit along the bottom, where a thumb reaches,
          and scroll sideways rather than covering the model. */}
      <div
        className={cn(
          "pointer-events-none absolute z-20 flex gap-2",
          "no-scrollbar inset-x-2 bottom-2 items-end justify-start overflow-x-auto pb-safe",
          "sm:inset-x-auto sm:bottom-auto sm:right-3 sm:top-3 sm:flex-col sm:items-end sm:overflow-visible",
        )}
      >
        <div className={cn(PILL, "pointer-events-auto shrink-0")}>
          <ToolButton label="Fit to selection" hotkey="F" onClick={() => stageRef.current?.focusSelection()}>
            <Focus />
          </ToolButton>
          {TOOLS.map((tool) => (
            <ToolButton
              key={tool.key}
              label={tool.label}
              hotkey={tool.hotkey}
              active={toggles[tool.key]}
              onClick={() => stageRef.current?.toggle(tool.key)}
            >
              <tool.icon />
            </ToolButton>
          ))}
        </div>

        <div className={cn(PILL, "pointer-events-auto shrink-0")}>
          {VIEW_KEYS.map((view) => (
            <Tooltip key={view.view}>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 px-2.5 text-[11px] font-semibold tracking-wide sm:h-7"
                    onClick={() => stageRef.current?.view(view.view)}
                  />
                }
              >
                {view.label}
              </TooltipTrigger>
              <TooltipContent>
                {view.label} view — {view.hotkey}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>

        <div className={cn(PILL, "pointer-events-auto shrink-0")}>
          <ToolButton label="Save a PNG of this view" hotkey="S" onClick={snapshot}>
            <Camera />
          </ToolButton>
          {download && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Download ${download.name}`}
                    className="size-9 sm:size-8"
                    nativeButton={false}
                    render={<a href={download.url} download={download.name} />}
                  />
                }
              >
                <Download />
              </TooltipTrigger>
              <TooltipContent>Download {download.name}</TooltipContent>
            </Tooltip>
          )}
          <ToolButton
            label={fullscreen ? "Leave fullscreen" : "Fullscreen"}
            active={fullscreen}
            onClick={toggleFullscreen}
          >
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
          </ToolButton>
          <ToolButton label="Keyboard shortcuts" hotkey="?" onClick={onShowShortcuts}>
            <Keyboard />
          </ToolButton>
        </div>
      </div>

      {/* What is on the stage. Sits opposite the toolbar in both layouts. */}
      {stats && (
        <div
          className={cn(
            "pointer-events-none absolute z-10 flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-x-3 gap-y-0.5",
            "rounded-xl border border-line-strong bg-surface/90 px-3 py-1.5 text-[11px] text-ink-muted shadow-sm backdrop-blur",
            "left-2 top-2 sm:bottom-3 sm:left-3 sm:top-auto",
          )}
        >
          <span className="font-display truncate text-sm font-bold text-ink">{shown}</span>
          <span className="tabular-nums">{formatCount(stats.triangles)} tris</span>
          <span className="tabular-nums">
            {stats.materials} mat{stats.materials === 1 ? "" : "s"}
          </span>
          {stats.size && (
            <span className="whitespace-nowrap tabular-nums">{formatVec(stats.size)}</span>
          )}
          {pickable && (
            <span className="inline-flex items-center gap-1 text-brand">
              <MousePointerClick className="size-3" aria-hidden />
              {stats.parts} parts — select one
            </span>
          )}
        </div>
      )}

      {/* The part under the cursor, so a click is never a guess. */}
      {hovered && hovered !== activePart && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 z-10 flex justify-center">
          <span className="font-display rounded-md bg-ink/85 px-2.5 py-1 text-sm font-semibold text-background shadow-sm">
            {hovered}
          </span>
        </div>
      )}

      {loading && (
        <div
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="size-7 animate-spin text-brand" aria-hidden />
          {/* An indeterminate spinner on a 40 MB room mesh says nothing; a real
              percentage is the difference between waiting and giving up. */}
          <div className="h-1 w-40 overflow-hidden rounded-full bg-line-strong">
            <div
              className={cn(
                "h-full rounded-full bg-brand transition-[width] duration-200",
                progress == null && "w-1/3 animate-shimmer",
              )}
              style={progress == null ? undefined : { width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <span className="sr-only">
            {progress == null ? "Loading mesh" : `Loading mesh, ${Math.round(progress * 100)}%`}
          </span>
        </div>
      )}

      {generating && (
        <GeneratingOverlay
          key={generating.id}
          job={generating}
          others={liveJobs.length - 1}
          compact={!empty}
        />
      )}

      {empty && !generating && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="font-display max-w-md text-xl font-semibold text-ink-soft sm:text-2xl">
            Pick a run on the left, or drop a .glb anywhere in this viewport
          </p>
          <Button onClick={onNew} className="mt-1">
            <Upload data-icon="inline-start" /> Generate from a photo
          </Button>
          <p className="mt-2 max-w-sm text-xs leading-relaxed tracking-wide text-ink-muted">
            drag to orbit · right-drag to pan · scroll to zoom · double-click to set the pivot
          </p>
          <Button variant="ghost" size="sm" onClick={onShowShortcuts} className="text-ink-muted">
            <Keyboard data-icon="inline-start" /> Keyboard shortcuts
          </Button>
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-brand/60 bg-brand/5">
          <p className="font-display rounded-md bg-surface/95 px-3 py-1.5 text-base font-semibold text-ink shadow-sm">
            Drop a .glb to inspect · drop an image to generate
          </p>
        </div>
      )}
    </div>
  );
}
