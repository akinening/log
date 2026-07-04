// Experience の「もっと詳しく」— あいことば入力モーダルと
// body.is-private による詳細経歴の解錠。
export const initPrivateMode = () => {
  const privateButton = document.querySelector("[data-private-open]");
  const privateModal = document.querySelector("[data-private-modal]");
  if (!(privateModal instanceof HTMLDialogElement) || privateModal.dataset.bound) return;
  privateModal.dataset.bound = "true";

  const privateForm = privateModal.querySelector("[data-private-form]");
  const privateInput = privateModal.querySelector("[data-private-input]");
  const privateCancel = privateModal.querySelector("[data-private-cancel]");
  const privateError = privateModal.querySelector("[data-private-error]");

  const closePrivateModal = () => {
    privateModal.close();
    if (privateInput instanceof HTMLInputElement) privateInput.value = "";
    privateError?.classList.remove("is-visible");
  };

  privateButton?.addEventListener("click", (event) => {
    event.preventDefault();
    privateError?.classList.remove("is-visible");
    privateModal.showModal();
    if (privateInput instanceof HTMLInputElement) {
      privateInput.value = "";
      privateInput.focus();
    }
  });

  privateCancel?.addEventListener("click", closePrivateModal);
  privateModal.addEventListener("click", (event) => {
    if (event.target === privateModal) closePrivateModal();
  });

  privateForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (privateInput instanceof HTMLInputElement && privateInput.value === "Saudade") {
      document.body.classList.add("is-private");
      closePrivateModal();
      return;
    }
    privateError?.classList.add("is-visible");
    privateModal.classList.remove("is-shake");
    requestAnimationFrame(() => privateModal.classList.add("is-shake"));
    if (privateInput instanceof HTMLInputElement) {
      privateInput.value = "";
      privateInput.focus();
    }
  });
};
