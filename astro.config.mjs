import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://akinen.com",
  output: "static",
  trailingSlash: "ignore",
  integrations: [sitemap()]
});
