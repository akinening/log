// Perspectives ページの図解切り替え。動的なのはドライバーマップ（01）のリーフ選択
// だけで、ほかのセクションは全情報を静的に表示する。全パネルは静的HTMLとして
// 描画済みで、ここでは is-active / aria-pressed の付け替えのみ行う。
// 自動再生はしない（読んでいる最中に内容が入れ替わるのを避ける）。
// View Transitions でDOMごと差し替わるため astro:page-load で毎回呼ばれるが、
// data-pv-init ガードで二重配線を防ぐ（初期化は冪等）。

export function initPerspectives() {
  const tree = document.querySelector("[data-pv-tree]");
  if (!(tree instanceof HTMLElement) || tree.dataset.pvInit) return;
  tree.dataset.pvInit = "true";

  const leaves = tree.querySelectorAll("[data-pv-leaf]");
  const actions = tree.querySelectorAll("[data-pv-action]");
  const branches = tree.querySelectorAll("[data-pv-branch]");

  leaves.forEach((btn) => {
    btn.addEventListener("click", () => {
      const { pvLeaf, pvBranchOf } = btn.dataset;
      leaves.forEach((el) => {
        const active = el === btn;
        el.classList.toggle("is-active", active);
        el.setAttribute("aria-pressed", String(active));
      });
      actions.forEach((panel) => {
        panel.classList.toggle("is-active", panel.dataset.pvAction === pvLeaf);
      });
      branches.forEach((el) => {
        el.classList.toggle("is-active", el.dataset.pvBranch === pvBranchOf);
      });
    });
  });
}
