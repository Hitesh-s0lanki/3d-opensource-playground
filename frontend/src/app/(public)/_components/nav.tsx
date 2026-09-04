/** The landing page header: who this is, where the page goes, and the way in.
 *
 * It floats - a pill held off the top edge rather than a bar ruled across it -
 * so the demo below reads as the page and the chrome reads as something laid
 * over it. Section links live in one shared list and appear here from `md` up;
 * below that they move into a drawer, because three labels and the button do
 * not fit on a phone without one of them shrinking past the point of being
 * tappable. The one control beside them is the offer itself - a header that
 * says "sign in" asks the visitor for something before it has given them
 * anything. Signed in, it stops selling and points at the studio - and only
 * that: the account menu belongs to the studio, where there is something to
 * do with an account, not to a page whose whole job is the door.
 */

import Link from "next/link";
import { Show, SignUpButton } from "@clerk/nextjs";
import { Logo } from "@/components/logo";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MobileNav } from "./mobile-nav";
import { NAV_LINKS } from "./nav-links";

export function LandingNav() {
  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-6 sm:pt-4">
      <nav
        aria-label="Main"
        className="pointer-events-auto mx-auto flex h-14 max-w-5xl items-center gap-2 rounded-full border border-line-strong bg-surface/80 pl-3 pr-2 shadow-[0_18px_45px_-30px_rgb(17_24_39/0.55)] backdrop-blur-xl sm:pl-5 sm:pr-3"
      >
        <Link href="/" className="focus-ring flex items-center gap-2.5 rounded-full">
          <Logo className="size-8 shrink-0" />
          <span className="font-display text-xl font-bold tracking-[-0.02em] text-ink">
            dioramic
          </span>
        </Link>

        <div className="ml-auto hidden items-center gap-0.5 md:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="focus-ring rounded-full px-3 py-2 text-sm font-medium text-ink-soft transition-colors hover:bg-muted hover:text-ink"
            >
              {link.label}
            </a>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1.5 md:ml-4">
          <Show when="signed-out">
            <SignUpButton mode="modal">
              <Button size="lg" className="h-10 rounded-full px-4">
                Try free
              </Button>
            </SignUpButton>
          </Show>
          <Show when="signed-in">
            <Link
              href="/app"
              className={cn(buttonVariants({ size: "lg" }), "h-10 rounded-full px-4")}
            >
              Open studio
            </Link>
          </Show>
          <MobileNav />
        </div>
      </nav>
    </header>
  );
}
