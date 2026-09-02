import { errorResponse, requireUserId } from "@/lib/auth";
import { cancelJob } from "@/lib/jobs";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    // cancelJob filters on the user id, so one user cannot cancel another's
    // job by guessing its uuid - it simply will not be found.
    const ok = await cancelJob(userId, decodeURIComponent(id));
    return Response.json({ cancelled: ok }, { status: ok ? 200 : 409 });
  } catch (exc) {
    return errorResponse(exc);
  }
}
