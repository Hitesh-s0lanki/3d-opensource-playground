"use client";

/** A panel that slides in from an edge, for the phone layout where the run
 * list and the detail column cannot both sit beside the viewport. Built on the
 * dialog primitive so it gets the focus trap, the scroll lock and Escape for
 * free - a hand-rolled drawer gets none of those right.
 */

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Side = "left" | "right" | "bottom";

const SIDE: Record<Side, string> = {
  left: "inset-y-0 left-0 h-full w-[min(21rem,88vw)] border-r data-open:slide-in-from-left data-closed:slide-out-to-left",
  right:
    "inset-y-0 right-0 h-full w-[min(23rem,90vw)] border-l data-open:slide-in-from-right data-closed:slide-out-to-right",
  bottom:
    "inset-x-0 bottom-0 max-h-[85svh] w-full rounded-t-2xl border-t data-open:slide-in-from-bottom data-closed:slide-out-to-bottom",
};

function Sheet({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetContent({
  className,
  children,
  side = "left",
  title,
  ...props
}: DialogPrimitive.Popup.Props & { side?: Side; title: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        className="fixed inset-0 z-50 bg-ink/35 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
      />
      <DialogPrimitive.Popup
        data-slot="sheet-content"
        className={cn(
          "fixed z-50 flex flex-col bg-sidebar text-foreground shadow-xl outline-none",
          "duration-200 ease-(--ease-out-quint) data-open:animate-in data-closed:animate-out",
          SIDE[side],
          className,
        )}
        {...props}
      >
        {/* Every dialog needs a name; these panels carry their own headings, so
            the accessible one is visually hidden rather than duplicated. */}
        <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        {children}
        <DialogPrimitive.Close
          render={<Button variant="ghost" size="icon" aria-label="Close" />}
          className="absolute right-2 top-2 z-10 size-9"
        >
          <XIcon />
        </DialogPrimitive.Close>
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

export { Sheet, SheetContent };
