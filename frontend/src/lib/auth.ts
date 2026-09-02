/** Who is asking. Every API route starts here.
 *
 * There is no unauthenticated view of anything any more: runs, jobs and blobs
 * are all keyed by the Clerk user id, and a route that cannot name the caller
 * has nothing it is allowed to return.
 */

import { auth } from "@clerk/nextjs/server";

export class Unauthorized extends Error {
  constructor() {
    super("sign in to continue");
    this.name = "Unauthorized";
  }
}

/** The signed-in user's id, or throw. Catch with `unauthorizedResponse`. */
export async function requireUserId(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new Unauthorized();
  return userId;
}

/** The signed-in user's id, or null - for routes that degrade rather than fail. */
export async function currentUserId(): Promise<string | null> {
  const { userId } = await auth();
  return userId ?? null;
}

/** Turn a thrown `Unauthorized` into a 401 and anything else into a 500. */
export function errorResponse(exc: unknown): Response {
  if (exc instanceof Unauthorized) {
    return Response.json({ error: exc.message }, { status: 401 });
  }
  const message = exc instanceof Error ? exc.message : String(exc);
  console.error("[api]", message);
  return Response.json({ error: message }, { status: 500 });
}
