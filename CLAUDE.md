# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal portfolio site for Akinori Ozawa (product designer), built with Astro as a fully static site. Content is Japanese (`lang="ja"`). Deployed to GitHub Pages at akinen.com.

## Commands

```bash
npm run dev       # local dev server
npm run build     # static build to dist/
npm run preview   # preview the production build
```

There is no test suite or linter configured. CI (`.github/workflows/html.yml`) runs `npm run build` then `htmlhint dist/index.html` on every push/PR — keep the built homepage HTML valid. `.github/workflows/deploy.yml` builds and deploys `dist/` to GitHub Pages on pushes to `main`/`master`.

## Architecture

- **Astro static site**, `output: "static"`, single content collection. No client framework (no React/Vue) — interactivity is vanilla `<script>` blocks using `astro:page-load` (fires on Astro View Transitions navigation, so init logic must be idempotent/re-runnable, not just `DOMContentLoaded`).
- **Content collection `works`** (`src/content/works/*.md`, schema in `src/content/config.ts`): each file is one case study with required frontmatter (`title`, `summary`, `company`, `period`, `team`, `role`, `year`, `thumbnail`, `tags`, exactly 3 `metrics` entries, `order`). Markdown body is rendered as the case study's prose. `order` controls display order everywhere (not filename or date).
- **Routing**: `src/pages/index.astro` (top page, lists works + speaking/writing), `src/pages/experience.astro` (career history), `src/pages/works/[slug].astro` (dynamic case-study page generated per collection entry via `getStaticPaths`, with a "next case" link that wraps around the sorted work list).
- **`src/layouts/Base.astro`** is the single shared layout: handles `<head>`/meta/OG tags, the sidebar/mobile nav shell, and a shared scroll-reveal `IntersectionObserver` (elements with class `rv` fade/slide in; respects `prefers-reduced-motion`). All pages wrap their content in `<Base>`.
- **Styling**: one global stylesheet `src/styles/global.css` (~1200 lines), no CSS modules/scoped styles/utility framework. Fonts are Google Fonts (Inter Tight, Instrument Serif, Noto Sans JP) loaded in `Base.astro`.
- **Assets**: work thumbnails/illustrations live in `public/works/*.svg`. Each case study typically has a base thumbnail plus `-a`/`-b` supporting illustration variants referenced inline in the markdown body.
- **Per-page interactive scripts**: `index.astro` has a "Load More" work-grid reveal; `[slug].astro` has a count-up animation for metric values (parses a numeric prefix out of `data-count` elements). Both re-bind on `astro:page-load`.

## Content conventions

- Case study markdown follows a consistent section structure: 課題 (problem) → 構造化/プロセス (approach) → 事業インパクト (business impact) → リーダーシップと学び (leadership/learnings), with inline illustration images between sections.
- `experience.astro` contains an expandable "もっと詳しく" (more detail) block per role (`data-private-open` / `.private-only`) for extended, more sensitive resume detail — check the corresponding JS behavior before restructuring this markup.
