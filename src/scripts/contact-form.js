// Contact フォーム（FormSpree 送信）。
// スパム対策は三層で行う：
//   1. マークアップに endpoint を残さない（HTML を収集するボットへの露出を減らす）
//   2. honeypot（.ct-hp 内の _gotcha が埋まっていたら送信しない）
//   3. タイムトラップ（表示から一定時間未満の送信はボットとみなす）
// ボット判定時は FormSpree へ送らず成功表示だけ返し、判定手がかりを与えない。
import { haptic } from "./haptics";

const ENDPOINT = ["https://", "formspree.io", "/f/", "xlgyzewo"].join("");

const MIN_FILL_MS = 4000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const VALIDATORS = {
  name: (value) => (value.trim() ? "" : "お名前を入力してください"),
  email: (value) => {
    if (!value.trim()) return "メールアドレスを入力してください";
    return EMAIL_RE.test(value.trim()) ? "" : "メールアドレスの形式が正しくありません";
  },
  message: (value) => (value.trim() ? "" : "本文を入力してください"),
};

export function initContactForm() {
  const root = document.querySelector("[data-contact]");
  if (!(root instanceof HTMLElement) || root.dataset.contactBound) return;
  root.dataset.contactBound = "true";

  const form = root.querySelector("[data-contact-form]");
  const success = root.querySelector("[data-contact-success]");
  const failure = root.querySelector("[data-contact-failure]");
  const submit = root.querySelector("[data-contact-submit]");
  const submitLabel = root.querySelector("[data-contact-submit-label]");
  if (!form || !success || !failure || !submit || !submitLabel) return;

  const openedAt = performance.now();

  const errorOf = (input) => {
    const id = input.getAttribute("aria-describedby");
    return id ? document.getElementById(id) : null;
  };

  const setFieldError = (input, message) => {
    const error = errorOf(input);
    if (!error) return;
    error.textContent = message;
    error.classList.toggle("is-visible", Boolean(message));
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  };

  const validateField = (input) => {
    const validator = VALIDATORS[input.name];
    if (!validator) return true;
    const message = validator(input.value);
    setFieldError(input, message);
    return !message;
  };

  // 入力しなおしたらその場でエラーを解く
  form.querySelectorAll("[data-contact-field]").forEach((input) => {
    input.addEventListener("input", () => {
      if (input.getAttribute("aria-invalid")) validateField(input);
    });
  });

  const showSuccess = () => {
    form.hidden = true;
    success.hidden = false;
    success.focus({ preventScroll: false });
    haptic("success");
  };

  const setSending = (sending) => {
    submit.disabled = sending;
    submitLabel.textContent = sending ? "Sending…" : "Send Message";
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    failure.classList.remove("is-visible");

    let firstInvalid = null;
    form.querySelectorAll("[data-contact-field]").forEach((input) => {
      if (!validateField(input) && !firstInvalid) firstInvalid = input;
    });
    if (firstInvalid) {
      firstInvalid.focus();
      haptic("error");
      return;
    }

    const honeypot = form.querySelector('[name="_gotcha"]');
    const tooFast = performance.now() - openedAt < MIN_FILL_MS;
    if ((honeypot && honeypot.value) || tooFast) {
      showSuccess();
      return;
    }

    setSending(true);
    try {
      const data = new FormData(form);
      data.delete("_gotcha");
      const subject = String(data.get("subject") || "").trim();
      data.set(
        "_subject",
        subject ? `[メッセージが届きました] ${subject}` : "[メッセージが届きました] ポートフォリオからのお問い合わせ"
      );
      const res = await fetch(ENDPOINT, {
        method: "POST",
        body: data,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`formspree responded ${res.status}`);
      showSuccess();
    } catch {
      failure.classList.add("is-visible");
      setSending(false);
      haptic("error");
    }
  });
}
