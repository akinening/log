// Kind Words — スクロールインでキーボード入力のような文字送りで表示する。
// 文字はJSで分割・非表示化するため、JS無効環境では全文がそのまま見える。
import tapSoundUrl from "../sound/tap_05.wav";

const PAUSE_AFTER = new Set(["、", "。", "！", "？", "，"]);
const SPEED = 1.2;
const TAP_VOLUME = 0.16;

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

  const quotes = Array.from(section.querySelectorAll(".kind-quote"));
  if (!quotes.length) return;
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

  // 一番長いテキストのカードだけ、文字が増えるたびにタップ音を鳴らす
  const longest = prepared.reduce((a, b) => (b.chars.length > a.chars.length ? b : a));
  const playTap = createTapPlayer();

  const type = ({ quote, chars }) => {
    const withSound = quote === longest.quote;
    const caret = document.createElement("span");
    caret.className = "kw-caret";
    caret.setAttribute("aria-hidden", "true");
    let i = 0;
    const step = () => {
      if (i >= chars.length) {
        quote.classList.add("is-typed");
        setTimeout(() => caret.remove(), 1100);
        return;
      }
      const ch = chars[i];
      ch.classList.add("is-on");
      ch.after(caret);
      if (withSound) playTap();
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

  // 複数カードが同時に見えたときは開始を300msずつずらす
  let lastStart = 0;
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        io.unobserve(entry.target);
        const item = prepared.find((p) => p.quote === entry.target);
        if (!item) return;
        const now = performance.now();
        const startAt = Math.max(now + 150, lastStart + 300);
        lastStart = startAt;
        setTimeout(() => type(item), startAt - now);
      });
    },
    { threshold: 0.3 }
  );

  // パスワードゲートで隠れている間はタイプを始めない
  const wrap = section.querySelector("[data-gate-wrap]");
  const observeAll = () => prepared.forEach((p) => io.observe(p.quote));
  if (wrap && !wrap.classList.contains("is-unlocked")) {
    const mo = new MutationObserver(() => {
      if (wrap.classList.contains("is-unlocked")) {
        mo.disconnect();
        observeAll();
      }
    });
    mo.observe(wrap, { attributes: true, attributeFilter: ["class"] });
  } else {
    observeAll();
  }
};
