import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatWidget, type WidgetOptions } from "./ChatWidget";
import css from "./widget.css?inline";

let root: Root | null = null;
let host: HTMLElement | null = null;
let current: WidgetOptions | null = null;

/** Mounts the widget inside a Shadow DOM so host-page CSS can't leak in (or out). */
function init(opts: WidgetOptions): void {
  if (host) return; // idempotent
  host = document.createElement("div");
  host.id = "support-chat-host";
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = css;
  const mount = document.createElement("div");
  shadow.append(style, mount);
  root = createRoot(mount);
  current = opts;
  root.render(createElement(ChatWidget, { opts }));
}

/**
 * Tell the widget who the visitor is now (call it when the user logs in, switches account or the token changes).
 * Another user => the widget drops the previous chat and starts a new session; the same user keeps theirs.
 * To end the session on logout call SupportChat.destroy() (and init() again after the next login).
 */
function identify(patch: Pick<WidgetOptions, "authToken" | "user" | "metadata">): void {
  if (!root || !current) return;
  current = { ...current, ...patch };
  root.render(createElement(ChatWidget, { opts: current }));
}

function destroy(): void {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  current = null;
}

(window as any).SupportChat = { init, identify, destroy };
