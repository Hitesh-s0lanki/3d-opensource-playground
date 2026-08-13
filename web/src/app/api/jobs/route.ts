import { getRunner, isJobKind, storeUpload } from "@/lib/jobs";
import { pythonExe } from "@/lib/paths";

export async function GET(): Promise<Response> {
  return Response.json(
    { jobs: getRunner().snapshot() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Take an uploaded image and queue the pipeline against it.
 *
 * multipart/form-data with a `file` field, a `kind` field ("object" | "room")
 * and any CLI options as further string fields.
 */
export async function POST(request: Request): Promise<Response> {
  if (pythonExe() === null) {
    return Response.json(
      { error: "generation is disabled - no Python venv found (run setup.ps1)" },
      { status: 403 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "expected multipart form data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File) || !file.size) {
    return Response.json({ error: "no image in the request body" }, { status: 400 });
  }
  const kind = String(form.get("kind") ?? "object");
  if (!isJobKind(kind)) {
    return Response.json({ error: `unknown job kind: ${kind}` }, { status: 400 });
  }

  const options: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (key === "file" || key === "kind" || typeof value !== "string" || !value) continue;
    options[key] = value;
  }

  try {
    const stored = await storeUpload(file.name, Buffer.from(await file.arrayBuffer()));
    const job = getRunner().submit(kind, stored, options);
    return Response.json({ job });
  } catch (exc) {
    return Response.json({ error: exc instanceof Error ? exc.message : String(exc) }, { status: 400 });
  }
}
