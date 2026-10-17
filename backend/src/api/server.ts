import cors from "@fastify/cors";
import Fastify from "fastify";
import { config } from "../config.js";
import { adminRoutes } from "./admin.js";
import { agentRoutes } from "./agent.js";
import { conversationRoutes } from "./conversations.js";
import { customerRoutes } from "./customer.js";

export async function startApi(): Promise<void> {
  // Never log request bodies; fastify's default request logging only records method/url/status.
  const app = Fastify({ logger: { level: "info", redact: ["req.headers.authorization"] } });
  // accept an empty body even when Content-Type: application/json (e.g. POST .../accept from a browser)
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try { done(null, body === "" ? {} : JSON.parse(body as string)); }
    catch { done(Object.assign(new Error("Invalid JSON"), { statusCode: 400 }), undefined); }
  });
  await app.register(cors, { origin: true, methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] }); // no allowedHeaders list: the browser's requested headers (X-Customer-*, custom ones) are reflected
  app.get("/api/health", async () => ({ ok: true }));
  await app.register(customerRoutes);
  await app.register(conversationRoutes);
  await app.register(agentRoutes);
  await app.register(adminRoutes);
  await app.listen({ port: config.backendPort, host: "0.0.0.0" });
}
