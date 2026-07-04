// Selected Work の「Load More」。隠れているカードをリビール付きで展開する。
export const initLoadMore = () => {
  const button = document.querySelector("[data-load-more]");
  const grid = document.querySelector("[data-work-grid]");
  if (!button || !grid || button.dataset.bound) return;
  button.dataset.bound = "true";

  button.addEventListener("click", () => {
    grid.querySelectorAll(".work-card.is-hidden").forEach((card, i) => {
      card.classList.remove("is-hidden");
      card.classList.remove("is-inview");
      card.style.setProperty("--rv-delay", `${i * 0.1}s`);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => card.classList.add("is-inview"));
      });
    });
    button.classList.add("is-done");
  });
};
