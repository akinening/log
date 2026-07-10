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
  // View Transitions でのページ遷移時、外部CSSの読み込み待ちで
  // スタイル未適用のまま表示される（リロードで直る）FOUCを防ぐため、
  // CSSを各ページのHTMLへインライン化してHTMLと一体で差し替える
  build: { inlineStylesheets: "always" },
  integrations: [sitemap()],
  markdown: {
    remarkPlugins: [remarkCjkFriendly],
    rehypePlugins: [lazyImages]
  }
});
