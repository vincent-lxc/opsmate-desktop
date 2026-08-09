import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Vitest config for the admin frontend (jsdom).
 *
 * Kept separate from vite.config.ts so production builds stay unaffected by
 * test-only plugins and the jsdom environment.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    // @ant-design/pro-components ships both an ESM `es/` build (`module` field)
    // and a CJS `lib/` build (`main` field) inside a package.json marked
    // `"type":"module"`. Vite's SSR resolver was picking the CJS `lib/` entry,
    // which crashes under ESM ("exports is not defined in ES module scope").
    // Pin the bare specifier to the ESM `es/index.js` entry so pro-components
    // (ProTable/ProForm/...) mounts under jsdom for the U6+ admin page tests.
    // Production builds are unaffected — they already resolve the `module` field.
    alias: {
      "@ant-design/pro-components": path.resolve(
        __dirname,
        "node_modules/@ant-design/pro-components/es/index.js",
      ),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/__tests__/**/*.test.{ts,tsx}"],
    css: false,
    // Inline-transform pro-components so Vite resolves the ESM `es/` tree's
    // directory imports (e.g. `export * from "./card"`) instead of handing them
    // to Node's ESM resolver, which rejects bare directory imports.
    server: {
      deps: {
        inline: [/@ant-design\/pro-/],
      },
    },
  },
});