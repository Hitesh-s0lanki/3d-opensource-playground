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
        // A box that starts near the top has no room for a label above it, so
        // that one sits inside the box instead of off the top of the photo.
        const labelInside = y0 / height < 0.09;
        return (
          <button
            key={item.name}
            type="button"
            aria-pressed={active}
            aria-label={`${item.name}${item.label ? `, ${item.label}` : ""}${
              item.score != null ? `, ${(item.score * 100).toFixed(0)}% confidence` : ""
            }, ${item.status}`}
            onClick={() => onSelect(active ? null : item.name)}
            className={cn(
              "focus-ring absolute rounded-sm border-2 transition-colors",
              active
                ? "z-10 border-brand bg-brand/15"
                : item.status === "dropped"
                  ? "border-danger/80 hover:bg-danger/10"
                  : item.status === "orphan"
                    ? "border-honey/80 hover:bg-honey/10"
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
              aria-hidden
              className={cn(
                "absolute left-0 max-w-35 truncate rounded-sm px-1 py-px text-[10px] font-medium leading-tight text-white",
                labelInside ? "top-0" : "-top-0.5 -translate-y-full",
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
