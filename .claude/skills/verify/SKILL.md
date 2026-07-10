---
name: verify
description: このリポジトリ（Astro静的ポートフォリオ）の変更をヘッドレスブラウザで実走確認する手順
---

# Verify — akinen.com portfolio

## Build & serve

```bash
npm run build          # dist/ を生成
npm run preview &      # http://localhost:4321/
```

## Headless browser（スクショ確認は可能）

Playwright はプロジェクトに無いが、`~/Library/Caches/ms-playwright/chromium-1228` に
キャッシュ済みChromiumがある。scratchpad に `npm i playwright-core` して
executablePath を指定すれば起動できる:

```js
import { chromium } from "playwright-core";
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath: exe, headless: true });
```

WebGL（fluid-photo / hero-fluid）はヘッドレスでも動く。

## Gotchas

- **イントロベール**（.page-veil）は常に自動退場する（約1.6秒で要素ごと削除）。
  クリック操作は不要。退場を待つなら
  `page.waitForFunction(() => !document.querySelector(".page-veil"))`。
- `.overline` や `.brand-role` には `text-transform: uppercase` が効くため、
  `innerText` は大文字で返る。文言アサーションは大文字小文字を無視して比較する。
- rv リビール完了まで待つ（hero-fluid の有効化は `.hero.has-fluid > canvas.fluid-canvas`
  の出現を `waitForSelector` で待てる。約2〜3秒）。
- reduced-motion 経路は `page.emulateMedia({ reducedMotion: "reduce" })` で確認
  （fluid系は無効化され DOM がそのまま残るのが正）。
- CI 相当: `npx htmlhint dist/index.html`。
