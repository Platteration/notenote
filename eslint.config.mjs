import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The service worker is plain browser JS served as-is, outside the bundle and its types.
    "public/sw.js",
  ]),
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      // Thumbnails come from arbitrary platform CDNs (and data: URIs in demo mode), so
      // next/image's loader and domain allow-list don't apply here.
      "@next/next/no-img-element": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
]);

export default eslintConfig;
