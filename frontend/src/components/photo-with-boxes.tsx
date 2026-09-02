"use client";

/** The source photo with each detection drawn on it. Clicking a box selects
 * that object's story in the detail column - the same gesture as clicking its
 * tile in the pipeline strip.
 */

import { cn } from "@/lib/utils";
import type { ImageRef, RunItem } from "@/lib/types";

interface PhotoWithBoxesProps {
  photo: ImageRef;
  items: RunItem[];
  selected: string | null;
  onSelect: (name: string | null) => void;
}

export function PhotoWithBoxes({ photo, items, selected, onSelect }: PhotoWithBoxesProps) {
  const boxed = photo.width && photo.height ? items.filter((item) => item.box) : [];
  return (
    <div className="relative overflow-hidden rounded-lg border border-line-strong bg-paper-deep shadow-xs">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photo.url ?? undefined}
        alt={photo.name}
        className="block w-full cursor-pointer select-none"
        onClick={() => onSelect(null)}
        draggable={false}
      />
      {boxed.map((item) => {
        const [x0, y0, x1, y1] = item.box!;
        const width = photo.width!;
        const height = photo.height!;
        const active = item.name === selected;
        return (
          <button
            key={item.name}
            type="button"
            title={`${item.name}${item.score != null ? ` · ${(item.score * 100).toFixed(0)}%` : ""}`}
            onClick={() => onSelect(active ? null : item.name)}
            className={cn(
              "absolute rounded-sm border-2 transition-colors",
              active
                ? "z-10 border-brand bg-brand/15"
                : item.status === "dropped"
                  ? "border-danger/80 hover:bg-danger/10"
                  : "border-box/70 hover:bg-box/10",
            )}
            style={{
              left: `${(x0 / width) * 100}%`,
              top: `${(y0 / height) * 100}%`,
              width: `${((x1 - x0) / width) * 100}%`,
              height: `${((y1 - y0) / height) * 100}%`,
            }}
          >
            <span
              className={cn(
                "absolute -top-0.5 left-0 -translate-y-full rounded-sm px-1 py-px text-[10px] font-medium leading-tight text-white",
                active ? "bg-brand" : item.status === "dropped" ? "bg-danger/90" : "bg-box/90",
              )}
            >
              {item.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}
