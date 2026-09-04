"use client";

/** The same section links, for a pill too narrow to hold them.
 *
 * A drawer rather than a dropdown, because the targets are scroll positions on
 * this page and a full-height panel gives them a comfortable tap size. Picking
 * one closes the panel; the browser does the scrolling.
 */

import { useState } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Logo } from "@/components/logo";
import { NAV_LINKS } from "./nav-links";

export function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open menu"
        aria-expanded={open}
        className="size-9 rounded-full text-ink-muted md:hidden"
        onClick={() => setOpen(true)}
      >
        <Menu />
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" title="Menu" className="md:hidden">
          <div className="flex items-center gap-2.5 px-5 pb-2 pt-5">
            <Logo className="size-7 shrink-0" />
            <span className="font-display text-lg font-bold tracking-[-0.02em] text-ink">
              dioramic
            </span>
          </div>
          <nav aria-label="Sections" className="flex flex-col gap-1 p-3">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="focus-ring flex min-h-11 items-center rounded-full px-4 text-base font-medium text-ink-soft transition-colors hover:bg-sidebar-accent hover:text-ink"
              >
                {link.label}
              </a>
            ))}
          </nav>
        </SheetContent>
      </Sheet>
    </>
  );
}
