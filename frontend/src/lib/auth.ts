/** Who is asking. Every API route starts here.
 *
 * There is no unauthenticated view of anything any more: runs, jobs and blobs
 * are all keyed by the Clerk user id, and a route that cannot name the caller
 * has nothing it is allowed to return.
 */

import { auth } from "@clerk/nextjs/server";
import { FigurineLimit, OutOfCredits } from "./credits";

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

/** Turn a thrown `Unauthorized` into a 401, a spent allowance into a 402, a
 * met daily limit into a 429, and anything else into a 500. All three are
 * answers about the caller rather than about the request, which is why they
 * are mapped here once instead of in every route that could raise them. */
export function errorResponse(exc: unknown): Response {
  if (exc instanceof Unauthorized) {
    return Response.json({ error: exc.message }, { status: 401 });
  }
  if (exc instanceof OutOfCredits) {
    return Response.json({ error: exc.message, out_of_credits: true }, { status: 402 });
  }
  if (exc instanceof FigurineLimit) {
    return Response.json({ error: exc.message, limit_reached: true }, { status: 429 });
  }
  const message = exc instanceof Error ? exc.message : String(exc);
  console.error("[api]", message);
  return Response.json({ error: message }, { status: 500 });
}
