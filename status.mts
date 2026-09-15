import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

export default async (req: Request, context: Context) => {
  const id = new URL(req.url).searchParams.get("jobId");
  if (!id) return Response.json({ error: "jobId requerido" }, { status: 400 });
  const store = getStore("forma-jobs", { consistency: "strong" });
  const status = await store.get(`jobs/${id}/status.json`, { type: "json" });
  if (!status) return Response.json({ status: "queued", progress: 0, message: "En cola…" });
  return Response.json(status);
};

export const config: Config = { path: "/api/status", method: "GET" };
