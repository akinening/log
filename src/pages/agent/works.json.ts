import type { APIRoute } from "astro";
import { getCollection } from "astro:content";

// WebMCP ツール（src/scripts/webmcp.js）がケーススタディを返すための静的JSON。
// 本文は markdown のまま渡す（AIエージェントにはHTMLより扱いやすい）。
// 表示順はサイトと同じく order に従う
export const GET: APIRoute = async ({ site }) => {
  const works = (await getCollection("works")).sort(
    (a, b) => a.data.order - b.data.order
  );
  const abs = (path: string) => new URL(path, site).href;

  const body = works.map((work) => {
    const { data } = work;
    return {
      slug: work.slug,
      url: abs(`/works/${work.slug}/`),
      title: data.title,
      summary: data.summary,
      company: data.company,
      period: data.period,
      team: data.team,
      role: data.role,
      year: data.year,
      tags: data.tags,
      metrics: data.metrics,
      tldr: data.tldr ?? null,
      thumbnail: abs(data.thumbnail),
      // 本文中の画像はルート相対パスなので、ページ外でも辿れる絶対URLにする
      body: work.body.replace(/\]\((\/[^)\s]+)\)/g, (_, path) => `](${abs(path)})`).trim()
    };
  });

  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
};
