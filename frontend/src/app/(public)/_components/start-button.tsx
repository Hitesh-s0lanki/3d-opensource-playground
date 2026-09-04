/** The one call to action, in both places it appears.
 *
 * What it says depends on who is reading: a visitor is offered the account and
 * its five free generations, and someone already signed in is offered the door
 * they actually want. Sign-up is a modal so the page - and the example they
 * were just turning around - stays behind it.
 */

import Link from "next/link";
import { Show, SignUpButton } from "@clerk/nextjs";
import { ArrowRight } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SIZING = "h-12 gap-2 rounded-full px-7 text-base";

export function StartButton({ label = "Start free" }: { label?: string }) {
  return (
    <>
      <Show when="signed-out">
        <SignUpButton mode="modal">
          <Button size="lg" className={SIZING}>
            {label} <ArrowRight className="size-4" aria-hidden />
          </Button>
        </SignUpButton>
      </Show>
      <Show when="signed-in">
        <Link href="/app" className={cn(buttonVariants({ size: "lg" }), SIZING)}>
          Open the studio <ArrowRight className="size-4" aria-hidden />
        </Link>
      </Show>
    </>
  );
}
