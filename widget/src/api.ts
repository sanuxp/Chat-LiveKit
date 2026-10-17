const VISITOR_KEY = "supportchat.visitorId";
const safeStorage = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

/** Details about the person, supplied by the host web page. All optional; the backend applies defaults. */
export interface CustomerInfo { name?: string; email?: string; phone?: string }
export type CustomerMetadata = Record<string, string | number | boolean>;

export interface SessionExtras {
  user?: CustomerInfo;
  metadata?: CustomerMetadata;
  /** Extra HTTP headers sent verbatim with the session request (e.g. for a gateway in front of the backend). */
  customHeaders?: Record<string, string>;
}

export interface Session {
  visitorId?: string;
  conversationId: string;
  status: string;
  livekitUrl: string;
  livekitToken: string;
  backendToken: string;
  features: { voice: boolean; video: boolean };
  profile: { name: string; email: string; phone: string };
}

// HTTP header values are Latin-1 only, so values are URI-encoded (the backend decodes them).
const enc = (v: string) => encodeURIComponent(v);

export function sessionHeaders(authToken: string | null, extras: SessionExtras = {}): Record<string, string> {
  // custom headers first, so the widget's own headers (Content-Type, Authorization, X-Customer-*) always win
  const headers: Record<string, string> = { ...(extras.customHeaders ?? {}), "Content-Type": "application/json" };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const u = extras.user ?? {};
  if (u.name) headers["X-Customer-Name"] = enc(u.name);
  if (u.email) headers["X-Customer-Email"] = enc(u.email);
  if (u.phone) headers["X-Customer-Phone"] = enc(u.phone);
  if (extras.metadata && Object.keys(extras.metadata).length) headers["X-Customer-Meta"] = enc(JSON.stringify(extras.metadata));
  return headers;
}

export async function createSession(backendUrl: string, authToken: string | null, extras: SessionExtras = {}): Promise<Session> {
  const res = await fetch(`${backendUrl}/api/customer/session`, {
    method: "POST",
    headers: sessionHeaders(authToken, extras),
    body: JSON.stringify({ visitorId: safeStorage.get(VISITOR_KEY) ?? undefined }),
  });
  if (!res.ok) throw new Error(`session failed (${res.status})`);
  const s = (await res.json()) as Session;
  if (s.visitorId) safeStorage.set(VISITOR_KEY, s.visitorId);
  return s;
}

export async function deleteConversation(backendUrl: string, s: Session): Promise<void> {
  const res = await fetch(`${backendUrl}/api/customer/conversations/${encodeURIComponent(s.conversationId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${s.backendToken}` },
  });
  if (!res.ok) throw new Error(`delete failed (${res.status})`);
}
