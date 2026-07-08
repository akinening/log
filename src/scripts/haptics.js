// タップ時に要素の役割に応じた振動を返すハプティックフィードバック。
// 語彙・発火条件・上書き方法の設計指針は docs/haptic-guidelines.md を参照。
// Vibration API 非対応環境（iOS Safari 等）では静かに何もしない。

const PATTERNS = {
  light: [10],
  medium: [20],
  "toggle-on": [12, 40, 16],
  "toggle-off": [10],
  success: [14, 60, 14, 60, 30],
  error: [45, 50, 45],
};

// 既定でハプティックを返す要素（Base.astro のクリック音の対象と揃える）
const DEFAULT_SELECTOR =
  'a, button, summary, input[type="submit"], input[type="button"], input[type="reset"], [role="button"]';

// 直近のポインタ入力のモダリティ。タッチのときだけ振動させる。
// タイムスタンプではなくフラグで持つことで、タップから始まった
// 非同期の結果（フォーム送信完了など）にも振動を返せる。
// keydown では更新しない — スマホの仮想キーボード（「Enter で送信」の
// フォーム等）も keydown を発火させるため、タッチ判定を壊してしまう。
let touchInput = false;
let bound = false;

export const haptic = (type) => {
  if (!touchInput || !("vibrate" in navigator)) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const pattern = PATTERNS[type];
  if (!pattern) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Permissions Policy 等で拒否されても UI には影響させない
  }
};

const resolveType = (el) => {
  const named = el.closest("[data-haptic]");
  if (named) {
    const type = named.dataset.haptic;
    if (type === "none") return null;
    // toggle は要素側のハンドラが aria-pressed を更新した後
    // （委譲リスナーは後から呼ばれる）に新しい状態を読む
    if (type === "toggle") {
      return named.getAttribute("aria-pressed") === "true" ? "toggle-on" : "toggle-off";
    }
    return type;
  }
  const target = el.closest(DEFAULT_SELECTOR);
  if (!target) return null;
  return target.matches('a:not([role="button"])') ? "light" : "medium";
};

export const initHaptics = () => {
  // document への委譲のみで View Transitions を跨いで生きるため一度だけ登録する
  if (bound) return;
  bound = true;

  document.addEventListener(
    "pointerdown",
    (e) => {
      touchInput = e.pointerType === "touch";
    },
    { capture: true, passive: true }
  );

  document.addEventListener("click", (e) => {
    if (!(e.target instanceof Element)) return;
    const type = resolveType(e.target);
    if (type) haptic(type);
  });
};
