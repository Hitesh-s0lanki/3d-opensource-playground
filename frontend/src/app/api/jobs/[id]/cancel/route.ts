import { getRunner } from "@/lib/jobs";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const ok = getRunner().cancel(decodeURIComponent(id));
  return Response.json({ cancelled: ok }, { status: ok ? 200 : 409 });
}
