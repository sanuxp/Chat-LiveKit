import type { IncomingHttpHeaders } from "node:http";
import { pool } from "../db/db.js";

/**
 * Customer profile supplied by the host web page (name / email / phone / free-form metadata).
 *
 * Where it comes from:
 *   - anonymous mode:   request headers  X-Customer-Name, X-Customer-Email, X-Customer-Phone, X-Customer-Meta
 *   - external_jwt mode: claims `name`, `email`, `phone` (or `phone_number`), `metadata` of the verified JWT
 *                        (verified claims win over headers)
 * Anything missing or invalid is ignored: the stored value is kept, otherwise the default is used.
 * NEVER log profile values (they are personal data).
 */

export type MetaValue = string | number | boolean;
export type Metadata = Record<string, MetaValue>;

export interface Profile { name: string; email: string; phone: string; metadata: Metadata }
export interface ProvidedProfile { name?: string; email?: string; phone?: string; metadata?: Metadata }
export interface StoredProfile { name: string | null; email: string | null; phone: string | null; metadata: Metadata }

export const DEFAULT_PROFILE = {
  name: process.env.DEFAULT_CUSTOMER_NAME || "Test User",
  email: process.env.DEFAULT_CUSTOMER_EMAIL || "testuser@test.com",
  phone: process.env.DEFAULT_CUSTOMER_PHONE || "+9876543210",
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
const clean = (s: string) => s.replace(CONTROL, " ").replace(/\s+/g, " ").trim();

export function sanitizeName(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = clean(v);
  return s && s.length <= 100 ? s : undefined;
}

export function sanitizeEmail(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = clean(v);
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : undefined;
}

export function sanitizePhone(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = clean(v);
  return /^\+?[0-9][0-9 ()-]{5,19}$/.test(s) ? s : undefined;
}

/** Up to 20 keys; key [A-Za-z0-9_]{1,40}; value string (<=200 chars) / number / boolean. Invalid entries are dropped. */
export function sanitizeMetadata(v: unknown): Metadata | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Metadata = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 20)) {
    if (!/^[A-Za-z0-9_]{1,40}$/.test(k)) continue;
    if (typeof val === "string") { const s = clean(val); if (s.length <= 200) out[k] = s; }
    else if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
    else if (typeof val === "boolean") out[k] = val;
  }
  return out;
}

/** HTTP header values are Latin-1 only, so the widget URI-encodes them; decode defensively. */
function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name.toLowerCase()];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string" || v.length > 2048) return undefined;
  try { return decodeURIComponent(v); } catch { return v; }
}

export function profileFromHeaders(headers: IncomingHttpHeaders): ProvidedProfile {
  let metadata: Metadata | undefined;
  const rawMeta = headerValue(headers, "x-customer-meta");
  if (rawMeta) { try { metadata = sanitizeMetadata(JSON.parse(rawMeta)); } catch { /* ignore bad JSON */ } }
  return {
    name: sanitizeName(headerValue(headers, "x-customer-name")),
    email: sanitizeEmail(headerValue(headers, "x-customer-email")),
    phone: sanitizePhone(headerValue(headers, "x-customer-phone")),
    metadata,
  };
}

export function profileFromClaims(claims: Record<string, unknown>): ProvidedProfile {
  return {
    name: sanitizeName(claims.name),
    email: sanitizeEmail(claims.email),
    phone: sanitizePhone(claims.phone ?? claims.phone_number),
    metadata: sanitizeMetadata(claims.metadata),
  };
}

/** Provided values override stored ones; anything not provided keeps what we already had. */
export function mergeProfile(stored: StoredProfile, provided: ProvidedProfile): StoredProfile {
  return {
    name: provided.name ?? stored.name,
    email: provided.email ?? stored.email,
    phone: provided.phone ?? stored.phone,
    metadata: provided.metadata ?? stored.metadata,
  };
}

/** Apply defaults for anything never provided. */
export function resolveProfile(p: StoredProfile): Profile {
  return {
    name: p.name ?? DEFAULT_PROFILE.name,
    email: p.email ?? DEFAULT_PROFILE.email,
    phone: p.phone ?? DEFAULT_PROFILE.phone,
    metadata: p.metadata ?? {},
  };
}

export function storedFromRow(row: { name?: string | null; email?: string | null; phone?: string | null; metadata?: Metadata | null }): StoredProfile {
  return { name: row.name ?? null, email: row.email ?? null, phone: row.phone ?? null, metadata: row.metadata ?? {} };
}

export const sameProfile = (a: StoredProfile, b: StoredProfile) =>
  a.name === b.name && a.email === b.email && a.phone === b.phone && JSON.stringify(a.metadata) === JSON.stringify(b.metadata);

const norm = (v?: string | null) => (v ?? "").trim().toLowerCase();

/**
 * Anonymous mode only (nothing is verified): does the user the host page sends now look like a different person
 * from the one this browser's visitor id was created for? Email decides, then name, then phone.
 * A page that stops sending any user (logged out) counts as a different person. A visitor that was anonymous before
 * and now sends details is treated as the same person (they just logged in).
 */
export function isDifferentPerson(stored: StoredProfile, provided: ProvidedProfile): boolean {
  const keys = ["email", "name", "phone"] as const;
  if (!keys.some((k) => norm(stored[k]))) return false;
  if (!keys.some((k) => norm(provided[k]))) return true;
  for (const k of keys) {
    if (norm(stored[k]) && norm(provided[k])) return norm(stored[k]) !== norm(provided[k]);
  }
  return false;
}

/** Resolved profile (defaults applied) of the customer who owns a conversation room. */
export async function getProfileByConversation(conversationId: string): Promise<Profile> {
  const r = await pool.query(
    `SELECT cu.name, cu.email, cu.phone, cu.metadata
       FROM conversations c JOIN customers cu ON cu.id = c.customer_id
      WHERE c.id = $1`,
    [conversationId],
  );
  return resolveProfile(storedFromRow(r.rows[0] ?? {}));
}

/** Template variables derived from the profile: {{customer_name}}, {{customer_phone}}, {{meta_<key>}} ... */
export function profileVars(p: Profile): Record<string, string> {
  const vars: Record<string, string> = {
    customer_name: p.name,
    customer_email: p.email, // an explicit tool argument of the same name overrides this
    customer_phone: p.phone,
    customer_meta: Object.entries(p.metadata).map(([k, v]) => `${k}: ${v}`).join("\n"),
  };
  for (const [k, v] of Object.entries(p.metadata)) vars[`meta_${k}`] = String(v);
  return vars;
}
