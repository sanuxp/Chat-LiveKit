// In production the console is served by Caddy on the same origin as the backend.
// With `vite dev` (port 5174) the backend lives behind Caddy at :8080 unless overridden.
const defaultOrigin = location.port === "5174" ? "http://localhost:8080" : location.origin;
export const BACKEND_URL: string = import.meta.env.VITE_BACKEND_URL ?? defaultOrigin;

const KEY = "supportchat.agent.session";

export interface Session { username: string; displayName: string; token: string }

export const loadSession = (): Session | null => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "null"); } catch { return null; }
};
export const saveSession = (s: Session | null) => {
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* ignore */ }
};

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function api<T = any>(token: string | null, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as any).message ?? `request failed (${res.status})`, res.status);
  return data as T;
}

export async function login(username: string, password: string): Promise<Session> {
  const r = await api<{ username: string; displayName: string; token: string }>(null, "POST", "/api/agent/login", { username, password });
  const s = { username: r.username, displayName: r.displayName, token: r.token };
  saveSession(s);
  return s;
}
