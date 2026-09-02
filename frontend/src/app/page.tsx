import { SignInButton, SignUpButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { ViewerApp } from "@/components/viewer-app";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";

/** Signed out there is nothing to show: every run, job and mesh belongs to a
 * user, so the viewer would only ever render an empty shell. Ask first. */
export default async function Home() {
  const { userId } = await auth();
  if (!userId) return <SignedOutLanding />;
  return <ViewerApp />;
}

function SignedOutLanding() {
  return (
    <main className="flex h-full min-h-svh items-center justify-center bg-background p-6">
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
          <SignUpButton mode="modal">
            <Button size="lg">Create an account</Button>
          </SignUpButton>
          <SignInButton mode="modal">
            <Button size="lg" variant="outline">
              Sign in
            </Button>
          </SignInButton>
        </div>
      </div>
    </main>
  );
}
