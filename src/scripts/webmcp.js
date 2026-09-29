// WebMCP（https://github.com/webmachinelearning/webmcp）でサイトの情報を
// AIエージェント向けの「ツール」として公開する。スクレイピングやスクリーン
// ショット頼みではなく、構造化された入力・出力でプロフィール／ケーススタディ／
// 各ページ本文を読めるようにし、画面遷移とお問い合わせの下書きも人と協調して行える。
//
// - 仕様は document.modelContext に移行中。初期実装の navigator.modelContext にも対応する
// - 非対応ブラウザでは静かに何もしない
// - サイト共通の読み取りツールは一度だけ登録（View Transitions で document は差し替わらない）
// - お問い合わせ下書きツールは Contact ページ表示中だけ登録し、離れたら解除する
// - 「もっと詳しく」（.private-only）の非公開経歴は、どのツールからも返さない
import { navigate } from "astro:transitions/client";

const WORKS_URL = "/agent/works.json";

const PAGES = {
  top: "/",
  experience: "/experience/",
  perspectives: "/perspectives/",
  contact: "/contact/"
};

// 本文抽出時に除外する要素。装飾・操作UI・フォーム、非公開経歴（.private-only）、
// あいことばゲートの中身（aria-hidden）とゲート自体の案内文
const STRIP_SELECTOR = [
  "script",
  "style",
  "noscript",
  "template",
  "dialog",
  "svg",
  "canvas",
  "img",
  "video",
  "form",
  "button",
  "[hidden]",
  "[aria-hidden='true']",
  "[data-private-open]",
  "[data-gate]",
  ".private-only"
].join(", ");

const PROFILE = {
  name: "Akinori Ozawa",
  role: "Senior Product Designer",
  company: "株式会社ambr",
  location: "Tokyo, Japan",
  summary:
    "UX/UIデザインおよびエンジニアリングにおける8年超の専門性を基盤に、デザイン思考で事業を推進するプロダクトデザイナー。自社事業「gogh」はグローバル300万DL／売上30万本を突破。toC/toB双方の知見と実装力を武器に、グロースと事業価値の向上にコミットする。",
  pages: {
    top: new URL(PAGES.top, location.origin).href,
    experience: new URL(PAGES.experience, location.origin).href,
    perspectives: new URL(PAGES.perspectives, location.origin).href,
    contact: new URL(PAGES.contact, location.origin).href
  },
  links: {
    linkedin: "https://www.linkedin.com/in/akinen",
    note: "https://note.com/012",
    zenn: "https://zenn.dev/012",
    speakerDeck: "https://speakerdeck.com/akinen"
  },
  contact: "お仕事のご相談・登壇や執筆のご依頼は Contact ページのフォームから（LinkedIn でも可）。"
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const getModelContext = () => document.modelContext ?? navigator.modelContext ?? null;

const textResult = (value) => ({
  content: [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }
  ]
});

const errorResult = (message) => ({ ...textResult(message), isError: true });

let worksPromise = null;
const loadWorks = () => {
  worksPromise ??= fetch(WORKS_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`${WORKS_URL} responded ${res.status}`);
      return res.json();
    })
    .catch((error) => {
      worksPromise = null;
      throw error;
    });
  return worksPromise;
};

const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "SECTION",
  "ARTICLE",
  "HEADER",
  "FOOTER",
  "NAV",
  "ASIDE",
  "FIGURE",
  "FIGCAPTION",
  "BLOCKQUOTE",
  "DETAILS",
  "SUMMARY",
  "DL",
  "DT",
  "DD",
  "TABLE",
  "TR"
]);

// ページのDOMを、見出し・リスト・リンクを保った軽量な markdown に落とす
const toMarkdown = (root) => {
  const lines = [];
  let prefix = "";
  let line = "";

  const flush = () => {
    const text = line.replace(/\s+/g, " ").trim();
    if (text) lines.push(prefix + text);
    prefix = "";
    line = "";
  };

  const walk = (node, depth) => {
    if (node.nodeType === Node.TEXT_NODE) {
      line += node.textContent;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    const children = () => node.childNodes.forEach((child) => walk(child, depth));

    if (tag === "BR") {
      flush();
    } else if (/^H[1-6]$/.test(tag)) {
      flush();
      lines.push("");
      prefix = `${"#".repeat(Number(tag[1]))} `;
      children();
      flush();
    } else if (tag === "UL" || tag === "OL") {
      flush();
      node.childNodes.forEach((child) => walk(child, depth + 1));
    } else if (tag === "LI") {
      flush();
      prefix = `${"  ".repeat(Math.max(depth - 1, 0))}- `;
      children();
      flush();
    } else if (tag === "A") {
      const href = node.getAttribute("href");
      const text = node.textContent.replace(/\s+/g, " ").trim();
      if (!text) return;
      line += href && !href.startsWith("#") ? ` [${text}](${new URL(href, location.origin).href}) ` : text;
    } else if (BLOCK_TAGS.has(tag)) {
      flush();
      children();
      flush();
    } else {
      children();
    }
  };

  walk(root, 0);
  flush();
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const pageCache = new Map();
const readPage = async (path) => {
  if (pageCache.has(path)) return pageCache.get(path);
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} responded ${res.status}`);
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");
  const root = doc.querySelector("main .page") ?? doc.querySelector("main");
  if (!root) throw new Error(`${path} has no main content`);
  root.querySelectorAll(STRIP_SELECTOR).forEach((el) => el.remove());
  const page = {
    url: new URL(path, location.origin).href,
    title: doc.title,
    description: doc.querySelector('meta[name="description"]')?.getAttribute("content") ?? "",
    content: toMarkdown(root)
  };
  pageCache.set(path, page);
  return page;
};

const summarizeWork = ({ body, ...work }) => work;

const siteTools = [
  {
    name: "get-profile",
    description:
      "Returns a short profile of Akinori Ozawa, the product designer who owns this portfolio site: role, company, location, summary, page URLs and external links (LinkedIn, note, Zenn, Speaker Deck). Start here to understand who this site is about. Content is in Japanese.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: () => textResult(PROFILE)
  },
  {
    name: "list-case-studies",
    description:
      "Lists all portfolio case studies in display order, with slug, URL, title, summary, company, period, team, role, tags, outcome metrics and a problem/approach/outcome TL;DR. Use get-case-study with a slug to read the full write-up. Content is in Japanese.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      try {
        return textResult((await loadWorks()).map(summarizeWork));
      } catch {
        return errorResult("Could not load the case study list. Please try again.");
      }
    }
  },
  {
    name: "get-case-study",
    description:
      "Returns one portfolio case study in full: metadata, outcome metrics, TL;DR and the complete Markdown body (problem, approach, business impact, learnings). Content is in Japanese.",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "The case study slug, as returned by list-case-studies (e.g. \"gogh-global\")."
        }
      },
      required: ["slug"]
    },
    annotations: { readOnlyHint: true },
    execute: async ({ slug } = {}) => {
      let works;
      try {
        works = await loadWorks();
      } catch {
        return errorResult("Could not load case studies. Please try again.");
      }
      const key = String(slug ?? "").trim().replace(/^\/?(works\/)?|\/$/g, "");
      const work = works.find((w) => w.slug === key);
      if (!work) {
        return errorResult(
          `No case study with slug "${slug}". Available slugs: ${works.map((w) => w.slug).join(", ")}.`
        );
      }
      return textResult(work);
    }
  },
  {
    name: "read-page",
    description:
      "Returns the text content of one page of this site as Markdown, without navigating. \"top\": overview, speaking and writing (use list-case-studies for the work). \"experience\": career history, speaking, skills and links. \"perspectives\": the designer's framework for linking design to business value. \"contact\": how to get in touch. Content is in Japanese.",
    inputSchema: {
      type: "object",
      properties: {
        page: {
          type: "string",
          enum: Object.keys(PAGES),
          description: "Which page to read."
        }
      },
      required: ["page"]
    },
    annotations: { readOnlyHint: true },
    execute: async ({ page } = {}) => {
      const path = PAGES[page];
      if (!path) {
        return errorResult(`Unknown page "${page}". Use one of: ${Object.keys(PAGES).join(", ")}.`);
      }
      try {
        return textResult(await readPage(path));
      } catch {
        return errorResult(`Could not load the ${page} page. Please try again.`);
      }
    }
  },
  {
    name: "open-page",
    description:
      "Navigates the user's browser tab to a page of this site so they can see it. Use it when the user wants to look at a page or case study themselves; use read-page or get-case-study to just read content.",
    inputSchema: {
      type: "object",
      properties: {
        page: {
          type: "string",
          enum: [...Object.keys(PAGES), "case-study"],
          description: "Which page to open. Use \"case-study\" together with slug."
        },
        slug: {
          type: "string",
          description: "Case study slug from list-case-studies. Required when page is \"case-study\"."
        }
      },
      required: ["page"]
    },
    execute: async ({ page, slug } = {}) => {
      let path = PAGES[page];
      if (page === "case-study") {
        let works;
        try {
          works = await loadWorks();
        } catch {
          return errorResult("Could not load case studies. Please try again.");
        }
        const work = works.find((w) => w.slug === String(slug ?? "").trim());
        if (!work) {
          return errorResult(
            `Pass a valid slug with page "case-study". Available slugs: ${works.map((w) => w.slug).join(", ")}.`
          );
        }
        path = `/works/${work.slug}/`;
      }
      if (!path) {
        return errorResult(
          `Unknown page "${page}". Use one of: ${[...Object.keys(PAGES), "case-study"].join(", ")}.`
        );
      }
      await navigate(path);
      return textResult(`Opened ${new URL(path, location.origin).href}`);
    }
  }
];

// Contact フォームへの下書き入力。送信は必ず本人がボタンを押して行う
// （honeypot／タイムトラップを含む既存の送信処理をそのまま通すため、ここでは送信しない）
const contactTool = {
  name: "draft-contact-message",
  description:
    "Fills in the contact form on this page with a message to Akinori Ozawa (job inquiries, speaking or writing requests, other messages). It does not send the message: after filling it, ask the user to review the form and press the \"Send Message\" button themselves.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The sender's name." },
      email: { type: "string", description: "The sender's email address for the reply." },
      subject: { type: "string", description: "Optional subject line." },
      message: { type: "string", description: "The message body. Japanese or English is fine." }
    },
    required: ["name", "email", "message"]
  },
  execute: ({ name = "", email = "", subject = "", message = "" } = {}) => {
    const form = document.querySelector("[data-contact-form]");
    if (!(form instanceof HTMLFormElement) || form.hidden) {
      return errorResult("The contact form is not available on the current page (it may already have been sent).");
    }
    const missing = [];
    if (!String(name).trim()) missing.push("name");
    if (!EMAIL_RE.test(String(email).trim())) missing.push("email (a valid address)");
    if (!String(message).trim()) missing.push("message");
    if (missing.length) {
      return errorResult(`Missing or invalid: ${missing.join(", ")}. Ask the user for these and try again.`);
    }

    const values = { name, email, subject, message };
    Object.entries(values).forEach(([field, value]) => {
      const input = form.elements.namedItem(field);
      if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
        input.value = String(value).trim();
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    const submit = form.querySelector("[data-contact-submit]");
    if (submit instanceof HTMLElement) {
      submit.scrollIntoView({ block: "center", behavior: "smooth" });
      submit.focus({ preventScroll: true });
    }
    return textResult(
      "The contact form is filled in but NOT sent yet. Ask the user to review it and press \"Send Message\" to send."
    );
  }
};

// 仕様の registerTool(tool, { signal }) で登録し、signal の abort で解除する。
// 初期実装（unregisterTool(name) のみ対応）向けに解除処理も併せて行う
const register = async (modelContext, tool, signal) => {
  try {
    await modelContext.registerTool(tool, signal ? { signal } : undefined);
    signal?.addEventListener(
      "abort",
      () => {
        try {
          modelContext.unregisterTool?.(tool.name);
        } catch {
          // signal による解除で既に外れている
        }
      },
      { once: true }
    );
  } catch (error) {
    console.warn(`[webmcp] failed to register "${tool.name}"`, error);
  }
};

let siteToolsRegistered = false;
let contactController = null;

export const initWebMCP = () => {
  const modelContext = getModelContext();
  if (!modelContext || typeof modelContext.registerTool !== "function") return;

  if (!siteToolsRegistered) {
    siteToolsRegistered = true;
    siteTools.forEach((tool) => register(modelContext, tool));
  }

  // ページ遷移ごとに Contact 用ツールの有無を付け替える
  contactController?.abort();
  contactController = null;
  if (document.querySelector("[data-contact-form]")) {
    contactController = new AbortController();
    register(modelContext, contactTool, contactController.signal);
  }
};
