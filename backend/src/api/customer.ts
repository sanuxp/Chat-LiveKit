import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { resolveProfile, mergeProfile, profileFromClaims, profileFromHeaders, storedFromRow, sameProfile, type ProvidedProfile } from "../customer/profile.js";
import { pool } from "../db/db.js";
import { getSelection } from "../voice/catalog.js";
import { customerIdentity, deleteRoom, mintToken, publish } from "../realtime/livekit.js";
import { clearFallback } from "../routing/handoff.js";
import { httpError, requireCustomer, signToken } from "./auth.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the stable external reference, visitorId and the host-supplied profile for this request,
 * per CUSTOMER_AUTH_MODE. In external_jwt mode verified JWT claims win over headers.
 */
function resolveIdentity(req: FastifyRequest): { externalRef: string; visitorId?: string; provided: ProvidedProfile } {
  const fromHeaders = profileFromHeaders(req.headers);
  if (config.customerAuthMode === "external_jwt") {
    const h = req.headers.authorization ?? "";
    if (!h.startsWith("Bearer ")) throw httpError(401, "Missing host-app JWT");
    try {
      const claims = jwt.verify(h.slice(7), config.externalJwtPublicKey) as jwt.JwtPayload;
      if (!claims.sub) throw new Error("no sub");
      const fromClaims = profileFromClaims(claims);
      const provided: ProvidedProfile = {
        name: fromClaims.name ?? fromHeaders.name,
        email: fromClaims.email ?? fromHeaders.email,
        phone: fromClaims.phone ?? fromHeaders.phone,
        metadata: fromClaims.metadata ?? fromHeaders.metadata,
      };
      return { externalRef: `ext:${claims.sub}`, provided };
    } catch {
      throw httpError(401, "Invalid host-app JWT");
    }
  }
  const body = (req.body ?? {}) as { visitorId?: string };
  const visitorId = body.visitorId && UUID_RE.test(body.visitorId) ? body.visitorId : randomUUID();
  return { externalRef: `anon:${visitorId}`, visitorId, provided: fromHeaders };
}

export async function customerRoutes(app: FastifyInstance): Promise<void> {
  // Permanently delete one of the caller's own conversations (messages are removed with it).
  app.delete<{ Params: { id: string } }>("/api/customer/conversations/:id", async (req) => {
    const claims = requireCustomer(req);
    const r = await pool.query(
      "SELECT id FROM conversations WHERE id=$1 AND customer_id=$2 AND deleted_at IS NULL",
      [req.params.id, claims.sub],
    );
    if (!r.rows[0]) throw httpError(404, "Conversation not found"); // also covers conversations owned by someone else
    clearFallback(req.params.id);
    // tell the agent (and any other participant) before the room is torn down, so their UI shows it ended
    await publish(req.params.id, { t: "state", status: "deleted", agent: null });
    await pool.query("DELETE FROM messages WHERE conversation_id=$1", [req.params.id]);
    await pool.query("UPDATE conversations SET deleted_at=now(), updated_at=now() WHERE id=$1", [req.params.id]);
    await deleteRoom(req.params.id); // disconnects everyone and ends any call
    console.log(JSON.stringify({ msg: "conversation deleted", conversationId: req.params.id }));
    return { deleted: true };
  });

  app.post("/api/customer/session", async (req) => {
    const { externalRef, visitorId, provided } = resolveIdentity(req);

    // customer row (stable per external_ref)
    const COLS = "id, name, email, phone, metadata";
    let customer = (await pool.query(`SELECT ${COLS} FROM customers WHERE external_ref=$1`, [externalRef])).rows[0];
    if (!customer) {
      customer = (
        await pool.query(
          `INSERT INTO customers (id, external_ref) VALUES ($1,$2)
           ON CONFLICT (external_ref) DO UPDATE SET external_ref = EXCLUDED.external_ref
           RETURNING ${COLS}`,
          [randomUUID(), externalRef],
        )
      ).rows[0];
    }

    // merge what the host page sent with what we stored; unsent fields keep their stored value
    const before = storedFromRow(customer);
    const merged = mergeProfile(before, provided);
    const profile = resolveProfile(merged);
    if (!sameProfile(before, merged)) {
      await pool.query("UPDATE customers SET name=$2, email=$3, phone=$4, metadata=$5 WHERE id=$1", [
        customer.id, merged.name, merged.email, merged.phone, JSON.stringify(merged.metadata),
      ]);
    }

    // open conversation or create a new one
    let conv = (
      await pool.query(
        `SELECT id, status FROM conversations
          WHERE customer_id=$1 AND deleted_at IS NULL AND status <> 'closed'
          ORDER BY created_at DESC LIMIT 1`,
        [customer.id],
      )
    ).rows[0];
    if (!conv) {
      conv = (
        await pool.query("INSERT INTO conversations (id, customer_id) VALUES ($1,$2) RETURNING id, status", [randomUUID(), customer.id])
      ).rows[0];
    }

    // AI voice assistant: available when voice is enabled in .env and switched on in Voice settings
    const aiVoice = config.enableVoice && (await getSelection().then((r) => r.selection.enabled, () => false));
    const livekitToken = await mintToken({
      conversationId: conv.id, identity: customerIdentity(customer.id), name: profile.name, role: "customer",
    });
    return {
      visitorId,
      conversationId: conv.id,
      status: conv.status,
      livekitUrl: config.livekitPublicUrl,
      livekitToken,
      backendToken: signToken({ role: "customer", sub: customer.id, conv: conv.id }),
      features: { voice: config.enableVoice, video: config.enableVideo, aiVoice },
      profile: { name: profile.name, email: profile.email, phone: profile.phone },
    };
  });
}
