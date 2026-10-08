import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { HERO_URL: "https://hero.test/graphql", HERO_API_KEY: "hero-key", PUBLIC_URL: "https://hero-mcp.test" },
      },
    }),
  ],
});
