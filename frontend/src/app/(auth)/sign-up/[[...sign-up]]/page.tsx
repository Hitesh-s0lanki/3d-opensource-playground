import { SignUp } from "@clerk/nextjs";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { FREE_CREDITS } from "@/lib/credits";

/** The other half of the door. The allowance is repeated here because it is
 * the reason someone is filling the form in, and the landing page that said so
 * is now behind a modal. */
export default function SignUpPage() {
  return (
    <>
      <div className="text-center">
        <Link href="/" className="focus-ring inline-flex items-center gap-2.5 rounded-lg">
          <Logo className="size-9" />
          <span className="font-display text-xl font-bold tracking-[-0.02em] text-ink">
            dioramic
          </span>
        </Link>
        <p className="mt-2 text-xs text-ink-muted">
          {FREE_CREDITS} free generations, no card.
        </p>
      </div>
      <SignUp />
    </>
  );
}
