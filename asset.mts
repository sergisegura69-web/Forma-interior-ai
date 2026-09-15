import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  const name = url.searchParams.get("name");
  if (!jobId || !name || name.includes("..") || name.includes("/")) return new Response("Bad request", { status: 400 });
  const store = getStore("forma-jobs");
  const result = await store.getWithMetadata(`jobs/${jobId}/${name}`, { type: "arrayBuffer" });
  if (!result?.data) return new Response("Not found", { status: 404 });
  const contentType = (result.metadata as any)?.contentType || "image/png";
  return new Response(result.data, { headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=31536000, immutable" } });
};

export const config: Config = { path: "/api/asset", method: "GET" };
