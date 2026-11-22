import { configureAxe } from "jest-axe";

/**
 * axe-core configured for jsdom. Colour contrast needs real layout/rendering, so it is covered by
 * contrast.test.ts instead; "region" is irrelevant when a single component is rendered on its own.
 */
export const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});
