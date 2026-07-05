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
- **Routing**: `src/pages/index.astro` (top page, lists works + speaking/writing), `src/pages/experience.astro` (career history), `src/pages/works/[slug].astro` (dynamic case-study page generated per collection entry via `getStaticPaths`, with a "next case" link that wraps around the sorted work list), `src/pages/sound.astro` (SOUND — full-viewport WebGL fluid-ink visualization of the ambient sound; linked from the sidebar `.sound-area` block above the ambient toggle).
- **`src/layouts/Base.astro`** is the single shared layout: handles `<head>`/meta/OG tags (`public/og.png` is the share image), the sidebar/mobile nav shell, ambient sound toggles, and a shared scroll-reveal `IntersectionObserver` (elements with class `rv` fade/slide in; respects `prefers-reduced-motion`). All pages wrap their content in `<Base>`.
- **Styling**: `src/styles/global.css` is only an `@import` entry point — the actual rules live in ordered partials in `src/styles/` (cascade order matters, don't reorder imports): `base.css` (tokens/reset/typography), `shell.css` (sidebar/mobile bar), `motion.css` (rv reveal/ripple/intro veil), `home.css` (hero/work grid/side work/kind words/footer), `case-study.css`, `experience.css`, `contact.css`, `sound.css` (SOUND page stage/statement/hint + `body.sound-ui-idle` museum-mode chrome fade), `misc.css` (404/password gate). No CSS modules/utility framework. Fonts are Google Fonts (Inter Tight, Instrument Serif, Noto Sans JP) loaded in `Base.astro`. Grep the partial, not global.css.
- **Assets**: work thumbnails are `public/works/*.webp`; supporting inline illustrations are `-a`/`-b` SVG/webp variants referenced in the markdown body. Markdown images get `loading="lazy" decoding="async"` via the rehype plugin in `astro.config.mjs`.
- **Interactive behaviors** live as modules in `src/scripts/`, each exporting an idempotent `init*()` bound on `astro:page-load` by the page that needs it: `ambient.js` (generative sound; dispatches `akinen:tone` per note and `akinen:ambient-state` on toggle), `sound-ink.js` (SOUND page: stable-fluids GPU sim rendering notes as blue ink blooms — pitch maps to darkness/drop size, mouse stirs velocity only, loop stops and field clears when silent), `fluid-photo.js` (WebGL fluid distortion over images — used on `.work-thumb` on the top page and `.xp-photo` on experience; falls back to the plain `<img>` without WebGL), `kind-words.js` (typewriter reveal for the Kind Words quotes), `accordion.js` (WAAPI height animation for `details.xp-entry`), `private-mode.js` (password modal for the private resume detail), `load-more.js` (work-grid reveal). `[slug].astro` keeps its metric count-up inline; `HeroField.astro` contains its own WebGL dot-field script.

## Content conventions

- Case study markdown follows a consistent section structure: 課題 (problem) → 構造化/プロセス (approach) → 事業インパクト (business impact) → リーダーシップと学び (leadership/learnings), with inline illustration images between sections.
- `experience.astro` contains an expandable "もっと詳しく" (more detail) block per role (`data-private-open` / `.private-only`) for extended, more sensitive resume detail — check the corresponding JS behavior before restructuring this markup.
