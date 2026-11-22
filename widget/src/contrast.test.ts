import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrast } from "./test/contrast";

const css = readFileSync(join(__dirname, "widget.css"), "utf8");

/** Reads the custom properties declared in a rule such as `.sc-root { --fg0: #000; ... }`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,6})/g)].map((m) => [m[1], m[2]]));
}

const light = tokens(".sc-root");
const dark = { ...light, ...tokens(".sc-root.sc-dark") };

// [description, foreground token, background token]
const TEXT: [string, string, string][] = [
  ["body text on panel", "foreground", "bg1"],
  ["body text on control bar", "foreground", "background"],
  ["own bubble text", "foreground", "bg3"],
  ["title / names / hints", "fg3", "bg1"],
  ["title / names / hints on bar", "fg3", "background"],
  ["placeholder text", "fg4", "background"],
  ["toggle text", "fg1", "bg2"],
  ["error text on panel", "fgSerious", "bg1"],
  ["error text on delete confirmation", "fgSerious", "bgSerious"],
  ["agent bubble text", "fgAccent", "bgAccentPrimary"],
  ["primary button text", "primary-fg", "primary"],
  ["primary button text (hover)", "primary-fg", "primary-hover"],
];

describe.each([["light", light], ["dark", dark]] as const)("widget.css %s theme contrast (WCAG 1.4.3)", (_theme, t) => {
  it.each(TEXT)("%s >= 4.5:1", (_n, fg, bg) => {
    expect(t[fg]).toBeDefined();
    expect(t[bg]).toBeDefined();
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
  });
});

describe("widget.css fixed colours", () => {
  it("launcher icon on the launcher >= 3:1 (graphic) and text-safe 4.5:1", () => {
    expect(contrast("#ffffff", light.call)).toBeGreaterThanOrEqual(4.5);
  });
  it("delete button text >= 4.5:1 in both themes", () => {
    expect(contrast("#ffffff", light.fgSerious)).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#0a0a0a", dark.fgSerious)).toBeGreaterThanOrEqual(4.5);
  });
  it("respects prefers-reduced-motion", () => expect(css).toMatch(/prefers-reduced-motion:\s*reduce/));
  it("never removes the focus outline without a replacement", () => {
    expect(css).toMatch(/\.sc-bar:focus-within\s*\{[^}]*outline/);
    expect(css).toMatch(/\.sc-trigger:focus-visible\s*\{[^}]*outline/);
  });
});
