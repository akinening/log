// Perspectives ページの図解切り替え。全パネルは静的HTMLとして描画済みで、
// ここでは is-active / aria-pressed の付け替えだけを行う。
// View Transitions でDOMごと差し替わるため astro:page-load で毎回呼ばれるが、
// data-pv-init ガードで二重配線を防ぐ（初期化は冪等）。
//
// 選択中カードは5秒ごとに次へ進みループする。手動で選ぶとタイマーを
// 巻き戻し、タブが非表示のあいだは進めない。reduced-motion 環境では
// 自動再生しない。タイマーは astro:before-swap で必ず止める。

const AUTOPLAY_MS = 5000;

const createAutoplay = (advance) => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return { reset: () => {} };
  }
  const tick = () => {
    if (!document.hidden) advance();
  };
  let timer = setInterval(tick, AUTOPLAY_MS);
  document.addEventListener("astro:before-swap", () => clearInterval(timer), { once: true });
  return {
    reset() {
      clearInterval(timer);
      timer = setInterval(tick, AUTOPLAY_MS);
    }
  };
};

export function initPerspectives() {
  const cycle = document.querySelector("[data-pv-cycle]");
  if (cycle instanceof HTMLElement && !cycle.dataset.pvInit) {
    cycle.dataset.pvInit = "true";
    const buttons = cycle.querySelectorAll("[data-pv-step]");
    const panels = cycle.querySelectorAll("[data-pv-panel]");
    let current = 0;

    const select = (index) => {
      current = index;
      buttons.forEach((btn) => {
        const active = Number(btn.dataset.pvStep) === index;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
      panels.forEach((panel) => {
        panel.classList.toggle("is-active", Number(panel.dataset.pvPanel) === index);
      });
    };

    const autoplay = createAutoplay(() => select((current + 1) % panels.length));

    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        select(Number(btn.dataset.pvStep));
        autoplay.reset();
      });
    });
  }

  const tree = document.querySelector("[data-pv-tree]");
  if (tree instanceof HTMLElement && !tree.dataset.pvInit) {
    tree.dataset.pvInit = "true";
    const leaves = tree.querySelectorAll("[data-pv-leaf]");
    const actions = tree.querySelectorAll("[data-pv-action]");
    const branches = tree.querySelectorAll("[data-pv-branch]");
    const order = Array.from(leaves).map((btn) => ({
      leaf: btn.dataset.pvLeaf,
      branch: btn.dataset.pvBranchOf
    }));
    let current = 0;

    const select = (index) => {
      current = index;
      const { leaf, branch } = order[index];
      leaves.forEach((btn) => {
        const active = btn.dataset.pvLeaf === leaf;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
      actions.forEach((panel) => {
        panel.classList.toggle("is-active", panel.dataset.pvAction === leaf);
      });
      branches.forEach((el) => {
        el.classList.toggle("is-active", el.dataset.pvBranch === branch);
      });
    };

    const autoplay = createAutoplay(() => select((current + 1) % order.length));

    leaves.forEach((btn, index) => {
      btn.addEventListener("click", () => {
        select(index);
        autoplay.reset();
      });
    });
  }
}
