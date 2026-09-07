import next from "eslint-config-next";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".next/**", "node_modules/**", "public/sw.js", "next-env.d.ts"] },
  ...next,
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      // Thumbnails come from arbitrary platform CDNs (and data: URIs in demo mode), so
      // next/image's loader and domain allow-list don't apply here.
      "@next/next/no-img-element": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
