// ヒーロー／ページ見出し（Experience・Contactの.xp-head・.ct-headなど）の流体ディストーション。
// DOM（見出し・リード文・下線画像）をレイアウト実測どおりに 2D キャンバスへ
// スナップショットし、fluid-photo と同じフローマップシェーダーで
// カーソルに合わせてぐにゃりと歪ませる。静止すればフローが減衰して元に戻る。
// スナップショットは等倍で DOM に重なるため、置き換えは見た目上シームレス。
// WebGL 不可・reduced-motion 環境では DOM がそのまま残る。

import { FluidPhoto } from "./fluid-photo";

// 文字ごとに Range で実座標を測って描くので、letter-spacing や
// text-wrap: balance を含む折り返しがそのまま再現される
const drawTextNodes = (ctx, hero, heroRect) => {
  const walker = document.createTreeWalker(hero, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node;
  while ((node = walker.nextNode())) {
    if (!node.data.trim()) continue;
    const el = node.parentElement;
    if (!el) continue;
    // [data-fluid-exclude] の子孫は歪ませず、DOM のまま残す（職務経歴書ボタン等）
    if (el.closest("[data-fluid-exclude]")) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    ctx.fillStyle = cs.color;
    const m = ctx.measureText("Mg");
    const ascent = m.fontBoundingBoxAscent ?? parseFloat(cs.fontSize) * 0.8;
    const descent = m.fontBoundingBoxDescent ?? parseFloat(cs.fontSize) * 0.2;
    for (let i = 0; i < node.data.length; i += 1) {
      const ch = node.data[i];
      if (!ch.trim()) continue;
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const baseline = r.top - heroRect.top + r.height * (ascent / (ascent + descent));
      ctx.fillText(ch, r.left - heroRect.left, baseline);
    }
  }
};

const snapshot = (hero) => {
  const heroRect = hero.getBoundingClientRect();
  if (!heroRect.width || !heroRect.height) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cv = document.createElement("canvas");
  cv.width = Math.round(heroRect.width * dpr);
  cv.height = Math.round(heroRect.height * dpr);
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);

  let bg = getComputedStyle(document.body).backgroundColor;
  if (!bg || bg === "transparent" || bg === "rgba(0, 0, 0, 0)") {
    bg = getComputedStyle(document.documentElement).backgroundColor;
  }
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, heroRect.width, heroRect.height);

  // overline の ::before（アクセント色の短い罫線）
  const overline = hero.querySelector(".overline");
  if (overline) {
    const ps = getComputedStyle(overline, "::before");
    const w = parseFloat(ps.width) || 0;
    const h = parseFloat(ps.height) || 0;
    if (w && h) {
      const r = overline.getBoundingClientRect();
      ctx.fillStyle = ps.backgroundColor;
      ctx.fillRect(r.left - heroRect.left, r.top - heroRect.top + (r.height - h) / 2, w, h);
    }
  }

  drawTextNodes(ctx, hero, heroRect);

  // 手描き下線などの画像（テキストの上に重なる想定なので最後に描く）
  hero.querySelectorAll("img").forEach((img) => {
    if (img.closest("[data-fluid-exclude]")) return;
    if (!img.complete || !img.naturalWidth) return;
    const r = img.getBoundingClientRect();
    ctx.drawImage(img, r.left - heroRect.left, r.top - heroRect.top, r.width, r.height);
  });

  return cv;
};

// rv リビール（下線がある場合は最後に終わる clip-path）を待ってから差し替える。
// transitionend が拾えないケースに備えてタイムアウトで必ず先へ進む
const waitForIntro = (hero) =>
  new Promise((resolve) => {
    const underline = hero.querySelector(".hero-underline");
    if (!underline) {
      // 下線を持たない見出し（xp-head/ct-headなど）は rv の opacity/transform
      // （--dur 0.7s + 最大rv-delay）が終わる頃合いで十分
      setTimeout(resolve, 900);
      return;
    }
    const timer = setTimeout(resolve, 2800);
    underline.addEventListener(
      "transitionend",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

export const initHeroFluid = async (selector = ".hero") => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const hero = document.querySelector(selector);
  if (!(hero instanceof HTMLElement) || hero.dataset.fluidBound) return;
  hero.dataset.fluidBound = "true";

  await Promise.all([
    document.fonts?.ready,
    ...[...hero.querySelectorAll("img")].map((img) => img.decode().catch(() => {}))
  ]);
  await waitForIntro(hero);
  if (!hero.isConnected) return;

  const source = snapshot(hero);
  if (!source) return;

  let fluid;
  try {
    // 写真より狭い範囲を強く歪ませ、インクが混ざり合うような質感に。
    // 色分離（虹色）はヒーローでは使わず、復帰もやや速めにする
    fluid = new FluidPhoto(hero, source, {
      falloff: 0.008,
      dissipation: 0.94,
      strength: 0.19,
      velocity: 16,
      spread: 0
    });
  } catch {
    return;
  }
  if (!fluid.gl) return;

  // リサイズで折り返し位置が変わるため、落ち着いてから再スナップショット
  let timer = 0;
  const ro = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!hero.isConnected) {
        ro.disconnect();
        return;
      }
      const next = snapshot(hero);
      if (next) fluid.setSource(next);
    }, 160);
  });
  ro.observe(hero);
};
