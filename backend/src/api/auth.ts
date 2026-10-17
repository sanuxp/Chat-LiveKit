import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { pool } from "../db/db.js";

export function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

/** Backend session token: issued to a customer (bound to one conversation) or to a human agent. */
export type Claims =
  | { role: "customer"; sub: string; conv: string }   // sub = customers.id
  | { role: "agent"; sub: string };                    // sub = agents.username

export const signToken = (claims: Claims) => jwt.sign(claims, config.jwtSecret, { expiresIn: "12h" });

export function verifyToken(req: FastifyRequest): Claims {
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Bearer ")) throw httpError(401, "Missing token");
  try {
    return jwt.verify(h.slice(7), config.jwtSecret) as Claims;
  } catch {
    throw httpError(401, "Invalid token");
  }
}

export function requireCustomer(req: FastifyRequest): Extract<Claims, { role: "customer" }> {
  const c = verifyToken(req);
  if (c.role !== "customer") throw httpError(403, "Customer token required");
  return c;
}

/** Verifies the token and that the agent account still exists. */
export async function requireAgent(req: FastifyRequest): Promise<{ username: string }> {
  const c = verifyToken(req);
  if (c.role !== "agent") throw httpError(403, "Agent token required");
  const r = await pool.query("SELECT 1 FROM agents WHERE username=$1", [c.sub]);
  if (!r.rowCount) throw httpError(401, "Unknown agent");
  return { username: c.sub };
}

// --- agent passwords (scrypt) ----------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
