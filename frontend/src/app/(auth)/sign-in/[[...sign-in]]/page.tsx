import { SignIn } from "@clerk/nextjs";
import Link from "next/link";
import { Logo } from "@/components/logo";

/** Between the landing page and the studio. Clerk draws the form; the page
 * around it only has to look like the same product - and that frame is the
 * `(auth)` layout, so all that is left here is the wordmark. */
export default function SignInPage() {
  return (
    <>
      <Link href="/" className="focus-ring flex items-center gap-2.5 rounded-lg">
        <Logo className="size-9" />
        <span className="font-display text-xl font-bold tracking-[-0.02em] text-ink">
          dioramic
        </span>
      </Link>
      <SignIn />
    </>
  );
}
