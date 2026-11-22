/** @type {import("jest").Config} */
module.exports = {
  testEnvironment: "jsdom",
  roots: ["<rootDir>/src"],
  setupFilesAfterEnv: ["<rootDir>/src/test/setup.ts"],
  transform: {
    "^.+\\.(t|j)sx?$": ["@swc/jest", { jsc: { parser: { syntax: "typescript", tsx: true }, transform: { react: { runtime: "automatic" } } } }],
  },
  moduleNameMapper: { "\\.css(\\?inline)?$": "<rootDir>/src/test/styleStub.cjs" },
  restoreMocks: true,
  testTimeout: 30000,
};
