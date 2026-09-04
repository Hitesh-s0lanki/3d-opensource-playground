import Link from "next/link";
import { ArrowLeft } from "lucide-react";

/** The doorway. Sign-in and sign-up are the same page with a different form in
 * the middle, so the frame around the form lives here and each page supplies
 * only its heading and its Clerk component.
 *
 * Not folded into `(public)` even though nobody has to be signed in to see it:
 * these two routes are a step on the way somewhere else, and the landing page
 * is a destination. Different jobs, different chrome, different group.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background p-6">
      {children}
      <Link
        href="/"
        className="focus-ring inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-ink-muted hover:text-ink"
      >
        <ArrowLeft className="size-3" aria-hidden /> Back to the examples
      </Link>
    </div>
  );
}
