"use client";

/** The centre column: the mesh, in 3D, plus the inspection toolbar and the
 * keyboard shortcuts of the original viewer (F/W/G/B/E/R, ↑/↓).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Contrast,
  Grid3x3,
  Loader2,
  Maximize,
  RotateCw,
  Scan,
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
import { GlbStage, type StageStats, type StageToggles } from "./three/glb-stage";

interface StageProps {
  src: string | null;
  name: string | null;
  /** ↑/↓ move through the run's objects; null disables them. */
  onStep: ((direction: 1 | -1) => void) | null;
  onDropImage: (file: File) => void;
}

const TOOLS: { key: keyof StageToggles; label: string; hotkey: string; icon: typeof Grid3x3 }[] = [
  { key: "wireframe", label: "Wireframe", hotkey: "W", icon: Scan },
  { key: "grid", label: "Ground grid", hotkey: "G", icon: Grid3x3 },
  { key: "bbox", label: "Bounding box", hotkey: "B", icon: Box },
  { key: "backdrop", label: "Dark backdrop", hotkey: "E", icon: Contrast },
  { key: "spin", label: "Spin", hotkey: "R", icon: RotateCw },
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

export function Stage({ src, name, onStep, onDropImage }: StageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<GlbStage | null>(null);
  const [stats, setStats] = useState<StageStats | null>(null);
  const [toggles, setToggles] = useState<StageToggles | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  // A dropped .glb takes over the viewport until the selection changes.
  const [droppedName, setDroppedName] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const stage = new GlbStage(
      container,
      (next) => setStats(next),
      (next) => setToggles({ ...next }),
      (message) => {
        setLoading(false);
        toast.error("Could not load mesh", { description: message });
      },
    );
    stageRef.current = stage;
    setToggles({ ...stage.toggles });
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
    void stage.load(src, name ?? "mesh").finally(() => setLoading(false));
  }, [src, name]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping()) return;
      const stage = stageRef.current;
      if (!stage) return;
      const key = event.key.toLowerCase();
      const tool = TOOLS.find((t) => t.hotkey.toLowerCase() === key);
      if (tool) stage.toggle(tool.key);
      else if (key === "f") stage.fit();
      else if (event.key === "ArrowUp" && onStep) onStep(-1);
      else if (event.key === "ArrowDown" && onStep) onStep(1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStep]);

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
      } else if (file.type.startsWith("image/")) {
        onDropImage(file);
      } else {
        toast.error("Drop a .glb to inspect it, or an image to generate from it");
      }
    },
    [onDropImage],
  );

  const shown = droppedName ?? name;
  const empty = !src && !droppedName && !loading;

  return (
    <div
      className="relative h-full min-w-0 flex-1 overflow-hidden"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div ref={containerRef} className="absolute inset-0" />

      {/* toolbar */}
      <div className="absolute right-3 top-3 flex items-center gap-1 rounded-lg border border-line-strong bg-surface/90 p-1 shadow-sm backdrop-blur">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon-sm" onClick={() => stageRef.current?.fit()} />
            }
          >
            <Maximize />
          </TooltipTrigger>
          <TooltipContent>Fit camera — F</TooltipContent>
        </Tooltip>
        {TOOLS.map((tool) => (
          <Tooltip key={tool.key}>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn(toggles?.[tool.key] && "bg-accent text-accent-foreground")}
                  onClick={() => stageRef.current?.toggle(tool.key)}
                />
              }
            >
              <tool.icon />
            </TooltipTrigger>
            <TooltipContent>
              {tool.label} — {tool.hotkey}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>

      {/* stats */}
      {stats && (
        <div className="absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] items-center gap-3 rounded-lg border border-line-strong bg-surface/90 px-3 py-1.5 text-xs text-ink-muted shadow-sm backdrop-blur">
          <span className="font-display truncate text-sm font-bold text-ink">{shown}</span>
          <span>{formatCount(stats.triangles)} tris</span>
          <span>{stats.materials} mat{stats.materials === 1 ? "" : "s"}</span>
          {stats.size && <span className="whitespace-nowrap">{formatVec(stats.size)}</span>}
        </div>
      )}

      {loading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 className="size-7 animate-spin text-brand" />
        </div>
      )}

      {empty && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
          <p className="font-display text-xl font-semibold italic text-ink-soft">
            Select a run, or drop a .glb anywhere in this viewport
          </p>
          <p className="text-xs tracking-wide text-ink-muted">
            drag to orbit · right-drag to pan · scroll to zoom · double-click to set the pivot
          </p>
          <p className="text-xs tracking-wide text-ink-muted/80">
            F fit · W wireframe · G grid · B bounds · E backdrop · R spin · ↑↓ objects
          </p>
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-xl border-2 border-dashed border-brand/50 bg-brand/5">
          <p className="font-display rounded-md bg-surface/90 px-3 py-1.5 text-base font-semibold italic text-ink shadow-sm">
            Drop a .glb to inspect · drop an image to generate
          </p>
        </div>
      )}
    </div>
  );
}
