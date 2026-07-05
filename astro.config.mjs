import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import remarkCjkFriendly from "remark-cjk-friendly";

// 記事本文（markdown）内の画像を遅延読み込みにする小さなrehypeプラグイン
const lazyImages = () => (tree) => {
  const visit = (node) => {
    if (node.type === "element" && node.tagName === "img") {
      node.properties.loading ??= "lazy";
      node.properties.decoding ??= "async";
    }
    node.children?.forEach(visit);
  };
  visit(tree);
};

export default defineConfig({
  site: "https://akinen.com",
  output: "static",
  trailingSlash: "ignore",
  integrations: [sitemap()],
  markdown: {
    remarkPlugins: [remarkCjkFriendly],
    rehypePlugins: [lazyImages]
  }
});
