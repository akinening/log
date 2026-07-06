// Kind Words — 推薦文を1枚ずつ前面に表示するカルーセル。
// スライドが切り替わるたびにタイプライター演出とタップ音を再生する。
// カルーセル化・文字分割はJSで行うため、JS無効環境では全文がグリッドのまま見える。
import tapSoundUrl from "../sound/tap_05.wav";

const PAUSE_AFTER = new Set(["、", "。", "！", "？", "，"]);
const SPEED = 1.2;
const TAP_VOLUME = 0.16;
// カードのスライドインが落ち着いてからタイプを打ち始めるまでの間
const ENTER_MS = 360;

// 短い間隔で連続再生されるため、1つのAudioを使い回さずプールする
const createTapPlayer = () => {
  const pool = Array.from({ length: 4 }, () => {
    const audio = new Audio(tapSoundUrl);
    audio.preload = "auto";
    audio.volume = TAP_VOLUME;
    return audio;
  });
  let i = 0;
  return () => {
    const audio = pool[i];
    i = (i + 1) % pool.length;
    audio.currentTime = 0;
    audio.play().catch(() => {});
  };
};

export const initKindWords = () => {
  const section = document.getElementById("kind-words");
  if (!section || section.dataset.kwBound) return;
  section.dataset.kwBound = "true";

  const carousel = section.querySelector("[data-kw-carousel]");
  const quotes = Array.from(section.querySelectorAll(".kind-quote"));
  if (!carousel || !quotes.length) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const segmenter = "Segmenter" in Intl ? new Intl.Segmenter("ja") : null;
  const split = (text) =>
    segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);

  const prepared = quotes.map((quote) => {
    quote.classList.add("kw-typing");
    const chars = [];
    quote.querySelectorAll(".kind-quote-text, .kind-quote-emphasis").forEach((el) => {
      const text = (el.textContent ?? "").trim();
      el.textContent = "";
      split(text).forEach((ch) => {
        const span = document.createElement("span");
        span.className = "kw-char";
        span.textContent = ch;
        el.appendChild(span);
        chars.push(span);
      });
    });
    return { quote, chars };
  });

  carousel.classList.add("is-carousel");
  const nav = carousel.querySelector("[data-kw-nav]");
  nav?.removeAttribute("hidden");
  const currentEl = carousel.querySelector("[data-kw-current]");
  const totalEl = carousel.querySelector("[data-kw-total]");
  if (totalEl) totalEl.textContent = String(prepared.length).padStart(2, "0");

  const playTap = createTapPlayer();

  // 進行中のタイプを打ち切るためのトークン。値が進んだら古いタイプは停止する。
  let typeToken = 0;

  const resetQuote = ({ quote, chars }) => {
    quote.classList.remove("is-typed");
    quote.querySelectorAll(".kw-caret").forEach((caret) => caret.remove());
    chars.forEach((ch) => ch.classList.remove("is-on"));
  };

  const type = ({ quote, chars }, token) => {
    const caret = document.createElement("span");
    caret.className = "kw-caret";
    caret.setAttribute("aria-hidden", "true");
    let i = 0;
    const step = () => {
      if (token !== typeToken) {
        caret.remove();
        return;
      }
      if (i >= chars.length) {
        quote.classList.add("is-typed");
        setTimeout(() => caret.remove(), 1100);
        return;
      }
      const ch = chars[i];
      ch.classList.add("is-on");
      ch.after(caret);
      playTap();
      i += 1;
      const next = chars[i];
      let delay = 26 + Math.random() * 44;
      if (PAUSE_AFTER.has(ch.textContent ?? "")) delay += 240;
      // 引用本文から強調行へ移るときはひと呼吸おく
      if (next && next.parentElement !== ch.parentElement) delay += 340;
      setTimeout(step, delay / SPEED);
    };
    chars[0]?.before(caret);
    step();
  };

  let index = 0;
  let started = false;

  const show = (i, dir) => {
    const token = ++typeToken;
    const entering = prepared[i];
    index = i;

    prepared.forEach(({ quote }) => {
      if (quote !== entering.quote) quote.classList.remove("is-active");
      quote.classList.remove("kw-enter-prev", "kw-enter-next");
    });
    resetQuote(entering);
    // スライドインのアニメーションを確実に再生し直すためリフローを挟む
    void entering.quote.offsetWidth;
    entering.quote.classList.add("is-active", dir < 0 ? "kw-enter-prev" : "kw-enter-next");
    if (currentEl) currentEl.textContent = String(i + 1).padStart(2, "0");

    setTimeout(() => {
      if (token === typeToken) type(entering, token);
    }, ENTER_MS);
  };

  const go = (dir) => {
    started = true;
    const n = prepared.length;
    show((index + dir + n) % n, dir);
  };

  carousel.querySelector("[data-kw-prev]")?.addEventListener("click", () => go(-1));
  carousel.querySelector("[data-kw-next]")?.addEventListener("click", () => go(1));

  carousel.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      go(1);
    }
  });

  // タッチスワイプ（マウスのドラッグ選択には反応させない）
  let swipeX = null;
  carousel.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    swipeX = e.clientX;
  });
  carousel.addEventListener("pointerup", (e) => {
    if (swipeX === null) return;
    const dx = e.clientX - swipeX;
    swipeX = null;
    if (Math.abs(dx) > 48) go(dx < 0 ? 1 : -1);
  });

  // 1枚目は表示だけしておき、スクロールインでタイプを打ち始める
  prepared[0].quote.classList.add("is-active");

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        if (started) return;
        started = true;
        const token = ++typeToken;
        setTimeout(() => {
          if (token === typeToken) type(prepared[index], token);
        }, 150);
      });
    },
    { threshold: 0.25 }
  );

  // パスワードゲートで隠れている間はタイプを始めない
  const wrap = section.querySelector("[data-gate-wrap]");
  const startObserving = () => io.observe(carousel);
  if (wrap && !wrap.classList.contains("is-unlocked")) {
    const mo = new MutationObserver(() => {
      if (wrap.classList.contains("is-unlocked")) {
        mo.disconnect();
        startObserving();
      }
    });
    mo.observe(wrap, { attributes: true, attributeFilter: ["class"] });
  } else {
    startObserving();
  }
};
