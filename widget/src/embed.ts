import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatWidget, type WidgetOptions } from "./ChatWidget";
import css from "./widget.css?inline";

let root: Root | null = null;
let host: HTMLElement | null = null;

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
  root.render(createElement(ChatWidget, { opts }));
}

function destroy(): void {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
}

(window as any).SupportChat = { init, destroy };
