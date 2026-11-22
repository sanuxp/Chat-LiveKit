import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrast } from "./test/contrast";

const css = readFileSync(join(__dirname, "styles.css"), "utf8");

// [description, foreground, background] -- must stay in sync with styles.css (checked below)
const TEXT: [string, string, string][] = [
  ["body text on page", "#1c2430", "#f3f5f9"],
  ["muted text on page", "#566070", "#f3f5f9"],
  ["muted text on card", "#566070", "#ffffff"],
  ["muted text on timeline", "#566070", "#f8fafc"],
  ["primary button text", "#ffffff", "#2563eb"],
  ["online button text", "#ffffff", "#15803d"],
  ["secondary button text", "#1c2430", "#e3e8f0"],
  ["error on card", "#b42318", "#ffffff"],
  ["error on banner", "#b42318", "#fef3f2"],
  ["own-message sender label", "#ffffff", "#2563eb"],
  ["AI summary label", "#b45309", "#fffbeb"],
  ["summary body text", "#4b5563", "#ffffff"],
  ["customer link", "#1d4ed8", "#f8fafc"],
];
const NON_TEXT: [string, string, string][] = [
  ["input border", "#7a8496", "#ffffff"],
  ["focus ring on page", "#1d4ed8", "#f3f5f9"],
  ["offline status dot on card", "#566070", "#ffffff"],
];

describe("styles.css colour contrast (WCAG 1.4.3 / 1.4.11)", () => {
  it.each(TEXT)("%s >= 4.5:1", (_n, fg, bg) => expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5));
  it.each(NON_TEXT)("%s >= 3:1", (_n, fg, bg) => expect(contrast(fg, bg)).toBeGreaterThanOrEqual(3));
  it("every checked colour is really used in styles.css", () => {
    for (const hex of new Set([...TEXT, ...NON_TEXT].flatMap(([, a, b]) => [a, b]))) {
      if (hex === "#ffffff") continue;
      expect(css.toLowerCase()).toContain(hex);
    }
  });
  it("respects prefers-reduced-motion", () => expect(css).toMatch(/prefers-reduced-motion:\s*reduce/));
});
