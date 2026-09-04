"use client";

/** The keyboard reference. The viewer has always had these keys; until now the
 * only place they were written down was the empty state, which disappears the
 * moment you load something.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Camera",
    rows: [
      ["F", "Fit — frames the selected object, or the whole scene"],
      ["1 2 3 4", "Iso · Front · Side · Top"],
      ["drag", "Orbit"],
      ["right-drag", "Pan"],
      ["scroll", "Zoom toward the cursor"],
      ["double-click", "Set the orbit pivot where you clicked"],
    ],
  },
  {
    title: "Display",
    rows: [
      ["W", "Wireframe"],
      ["G", "Ground grid"],
      ["B", "Bounding box"],
      ["E", "Flip the backdrop"],
      ["R", "Spin"],
    ],
  },
  {
    title: "Navigation",
    rows: [
      ["↑ ↓", "Step through the objects in this run"],
      ["click", "Select a part of an assembled scene"],
      ["Esc", "Clear the selection"],
      ["S", "Save a PNG of the current view"],
      ["?", "This list"],
    ],
  },
];

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl font-bold text-ink">
            Keyboard &amp; mouse
          </DialogTitle>
          <DialogDescription className="font-display text-[14px] leading-snug text-ink-muted">
            Everything the viewport responds to. Keys are ignored while you are
            typing in a field.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 sm:grid-cols-2">
          {GROUPS.map((group) => (
            <section key={group.title} className="space-y-2">
              <h3 className="kicker">{group.title}</h3>
              <dl className="space-y-1.5">
                {group.rows.map(([keys, what]) => (
                  <div key={keys} className="flex items-baseline gap-2.5 text-xs">
                    <dt className="w-20 shrink-0 text-right">
                      <kbd className="rounded border border-line-strong bg-paper-deep px-1.5 py-0.5 font-mono text-[10px] font-medium text-ink-soft">
                        {keys}
                      </kbd>
                    </dt>
                    <dd className="min-w-0 flex-1 leading-snug text-ink-soft">{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
