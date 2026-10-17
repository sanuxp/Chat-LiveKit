import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { loadTools, ToolConfigError } from "../tools/registry.js";
import { httpError } from "./auth.js";

function tokenOk(provided: string): boolean {
  const a = Buffer.from(provided), b = Buffer.from(config.adminApiToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/admin/reload-config", async (req, reply) => {
    if (!config.adminApiToken) throw httpError(503, "ADMIN_API_TOKEN is not configured");
    const h = req.headers.authorization ?? "";
    const provided = h.startsWith("Bearer ") ? h.slice(7) : String(req.headers["x-admin-token"] ?? "");
    if (!provided || !tokenOk(provided)) throw httpError(401, "Invalid admin token");
    try {
      await loadTools();
      return { ok: true };
    } catch (e) {
      if (e instanceof ToolConfigError) return reply.code(400).send({ ok: false, error: e.message });
      throw e;
    }
  });
}
