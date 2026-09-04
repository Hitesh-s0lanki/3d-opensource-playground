import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

/** The gate for every route under `(protected)`.
 *
 * The check used to sit inside the studio page. It lives here instead so that
 * the answer to "is this route signed-in only?" is the folder it is filed
 * under, not a line somewhere in the middle of a component - a new page added
 * to this group is protected by existing.
 *
 * The group adds no segment to the URL, so the studio is still `/app`.
 */
export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");
  return <>{children}</>;
}
