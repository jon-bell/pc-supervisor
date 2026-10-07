// ESLint flat config for every workspace.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// AGENTS.md: never read the time directly; use server/src/clock.ts.
const NO_DIRECT_NOW = [
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: "Use server/src/clock.ts (Clock.now()) instead of Date.now(); PCS_NOW must be able to pin time.",
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: "Use server/src/clock.ts (Clock.now()) instead of new Date(); PCS_NOW must be able to pin time.",
  },
  {
    selector: "CallExpression[callee.name='Date']",
    message: "Date() returns the current time as a string; use server/src/clock.ts.",
  },
];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "e2e/argos-canary/**",
      "playwright-report/**",
      "test-results/**",
      "data/**",
      ".claude/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-restricted-syntax": ["error", ...NO_DIRECT_NOW],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      eqeqeq: ["error", "always"],
      // With noUncheckedIndexedAccess, `xs[i]!` after a bounds check is the idiom.
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["web/src/**"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // The one place allowed to read the wall clock, plus tests.
    files: ["server/src/clock.ts", "**/test/**", "e2e/**"],
    rules: { "no-restricted-syntax": "off" },
  },
);
