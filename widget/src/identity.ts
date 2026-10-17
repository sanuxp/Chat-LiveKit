import type { WidgetOptions } from "./ChatWidget";

/** The `sub` claim of a JWT, read without verifying it (only used to notice that the logged-in user changed). */
function jwtSubject(token: string): string | undefined {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const sub = JSON.parse(atob(payload)).sub;
    return typeof sub === "string" ? sub : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Who the widget is talking for. When it changes (another user logs in, or the user logs out) the widget drops its
 * session and starts a fresh one, so a chat is never shown to someone else. A refreshed token of the same user does not change it.
 */
export function identityKey(opts: WidgetOptions): string {
  if (opts.authToken) return `jwt:${jwtSubject(opts.authToken) ?? opts.authToken}`;
  const u = opts.user;
  return `user:${(u?.email || u?.name || u?.phone || "").trim().toLowerCase()}`;
}
