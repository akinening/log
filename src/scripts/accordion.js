// <details> の開閉を高さアニメーションでなめらかにする。
// ネイティブの details は瞬時に開閉するため、summary クリックを
// 乗っ取り WAAPI で高さとコンテンツのフェードを制御する。
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

export const initAccordions = (selector = "details.xp-entry") => {
  document.querySelectorAll(selector).forEach((el) => {
    if (!(el instanceof HTMLElement) || el.dataset.accBound) return;
    el.dataset.accBound = "true";
    const summary = el.querySelector(":scope > summary");
    if (!summary) return;

    const contents = () => Array.from(el.children).filter((c) => c !== summary);
    let heightAnim = null;
    let contentAnims = [];
    let closing = false;

    const closedHeight = () => {
      const cs = getComputedStyle(el);
      return summary.offsetHeight + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    };

    const cancelAnims = () => {
      if (heightAnim) {
        heightAnim.onfinish = null;
        heightAnim.cancel();
        heightAnim = null;
      }
      contentAnims.forEach((a) => a.cancel());
      contentAnims = [];
    };

    const settle = () => {
      el.classList.remove("is-anim");
      heightAnim = null;
    };

    summary.addEventListener("click", (e) => {
      e.preventDefault();
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        el.open = !el.open;
        return;
      }

      const opening = !el.open || closing;
      // 進行中のアニメーションがあれば現在の見た目の高さから引き継ぐ
      const startHeight = el.getBoundingClientRect().height;
      cancelAnims();
      el.classList.add("is-anim");

      if (opening) {
        closing = false;
        el.classList.remove("is-closing");
        el.open = true;
        const endHeight = el.offsetHeight;
        heightAnim = el.animate(
          { height: [`${startHeight}px`, `${endHeight}px`] },
          { duration: 560, easing: EASE }
        );
        contentAnims = contents().map((c) =>
          c.animate(
            { opacity: [0, 1], transform: ["translateY(-10px)", "translateY(0)"] },
            { duration: 520, delay: 140, easing: EASE, fill: "backwards" }
          )
        );
        heightAnim.onfinish = settle;
      } else {
        closing = true;
        el.classList.add("is-closing");
        heightAnim = el.animate(
          { height: [`${startHeight}px`, `${closedHeight()}px`] },
          { duration: 480, easing: EASE }
        );
        contentAnims = contents().map((c) =>
          c.animate({ opacity: [1, 0] }, { duration: 200, easing: "ease-out", fill: "forwards" })
        );
        heightAnim.onfinish = () => {
          el.open = false;
          closing = false;
          el.classList.remove("is-closing");
          contentAnims.forEach((a) => a.cancel());
          contentAnims = [];
          settle();
        };
      }
    });
  });
};
