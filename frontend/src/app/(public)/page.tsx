import Link from "next/link";
import type { Metadata } from "next";
import { Logo } from "@/components/logo";
import { buttonVariants } from "@/components/ui/button";

/** The front door.
 *
 * `/` used to be the studio behind an auth check: signed in you got the
 * viewer, signed out you got this card. That made one route mean two
 * different things, and meant the only public page in the app was a fallback
 * inside a protected one. The studio is `/app` now and this is a page in its
 * own right - still a card, for the moment, but a `(public)` one that is
 * nobody's fallback.
 */
export const metadata: Metadata = {
  title: "dioramic",
  description: "Turn a photo into a 3D object.",
};

export default function LandingPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm text-center">
        <Logo className="mx-auto size-16" />
        <h1 className="font-display mt-5 text-3xl font-bold tracking-[0.01em] text-ink">
          dioramic
        </h1>
        <p className="mt-2 text-sm text-ink-muted">
          Turn a photo into a 3D object. Your uploads and meshes are private to
          your account.
        </p>
        <div className="mt-7 flex items-center justify-center gap-3">
          <Link href="/sign-up" className={buttonVariants({ size: "lg" })}>
            Create an account
          </Link>
          <Link
            href="/sign-in"
            className={buttonVariants({ size: "lg", variant: "outline" })}
          >
            Sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
