// Live document preview shared by the web editor and the VS Code extension.
//
// Two modes:
//   "pdf"   – the real PDF rendered by Chromium, displayed with pdf.js
//   "paged" – paginated HTML (paged.js) for instant feedback while typing
//
// Renders are debounced, stale requests are aborted, and the new render is
// prepared off-screen before being swapped in so the view never flickers.

import { api } from "./api.js";
import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;

const PAGE_GAP = 16;
const CSS_PX_PER_PT = 96 / 72;

export class Preview {
  /**
   * @param {HTMLElement} root  element the preview fills
   * @param {object} options
   * @param {(status: object) => void} [options.onStatus]
   */
  constructor(root, { onStatus = () => {}, mode = "pdf", zoom = "fit" } = {}) {
    this.root = root;
    this.onStatus = onStatus;
    this.mode = mode;
    this.zoom = zoom;
    this.input = null;
    this.timer = null;
    this.seq = 0;
    this.controller = null;
    this.pdfBytes = null;
    this.pdfTask = null;
    this.observer = null;

    root.classList.add("emd-preview");
    this.scroller = document.createElement("div");
    this.scroller.className = "emd-preview-scroller";
    this.error = document.createElement("div");
    this.error.className = "emd-preview-error";
    this.error.hidden = true;
    this.placeholder = document.createElement("div");
    this.placeholder.className = "emd-preview-placeholder";
    this.placeholder.textContent = "Preview will appear here";
    root.append(this.scroller, this.error);
    this.scroller.append(this.placeholder);
    this.scroller.addEventListener("click", (e) => this.onPdfClick(e));

    let lastWidth = 0;
    new ResizeObserver(() => {
      const width = this.scroller.clientWidth;
      if (Math.abs(width - lastWidth) < 4) return;
      lastWidth = width;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.relayout(), 150);
    }).observe(this.scroller);
  }

  /** Queue a render of `{ markdown, css, baseDir }`. */
  update(input, { immediate = false } = {}) {
    this.input = input;
    clearTimeout(this.timer);
    const delay = immediate ? 0 : this.mode === "pdf" ? 450 : 250;
    this.timer = setTimeout(() => this.render(), delay);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.pdfBytes = null;
    if (this.input) this.update(this.input, { immediate: true });
  }

  setZoom(zoom) {
    this.zoom = zoom;
    this.relayout();
  }

  refresh() {
    if (this.input) this.update(this.input, { immediate: true });
  }

  async render() {
    if (!this.input) return;
    const seq = ++this.seq;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const started = performance.now();
    this.onStatus({ state: "rendering" });

    try {
      const response = await api("/api/render", {
        method: "POST",
        raw: true,
        signal: controller.signal,
        body: {
          markdown: this.input.markdown,
          css: this.input.css || null,
          base_dir: this.input.baseDir || null,
          format: this.mode === "pdf" ? "pdf" : "paged",
        },
      });
      if (this.mode === "pdf") {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (seq !== this.seq) return;
        this.pdfBytes = bytes;
        const pages = await this.showPdf(bytes, seq);
        if (pages == null) return;
        this.finish(seq, started, pages);
      } else {
        const html = await response.text();
        if (seq !== this.seq) return;
        const pages = await this.showPaged(html, seq);
        if (pages == null) return;
        this.finish(seq, started, pages);
      }
    } catch (err) {
      if (err.name === "AbortError" || seq !== this.seq) return;
      this.error.textContent = err.message;
      this.error.hidden = false;
      this.onStatus({ state: "error", message: err.message });
    }
  }

  finish(seq, started, pages) {
    if (seq !== this.seq) return;
    this.error.hidden = true;
    this.onStatus({ state: "ok", pages, ms: Math.round(performance.now() - started) });
  }

  relayout() {
    if (this.mode === "pdf" && this.pdfBytes) {
      this.showPdf(this.pdfBytes, this.seq);
    } else if (this.mode === "paged") {
      const frame = this.scroller.querySelector("iframe");
      if (frame) this.applyPagedZoom(frame);
    }
  }

  // ---------------------------------------------------------------- PDF mode

  scrollRatio() {
    const s = this.scroller;
    const max = s.scrollHeight - s.clientHeight;
    return max > 0 ? s.scrollTop / max : 0;
  }

  async showPdf(bytes, seq) {
    // pdf.js transfers the buffer to its worker, so hand it a copy.
    const task = pdfjsLib.getDocument({ data: bytes.slice() });
    const doc = await task.promise;
    if (seq !== this.seq) {
      task.destroy();
      return null;
    }
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) pages.push(await doc.getPage(i));
    if (seq !== this.seq) {
      task.destroy();
      return null;
    }

    const available = Math.max(100, this.scroller.clientWidth - 2 * PAGE_GAP);
    const firstWidthPx = pages[0].getViewport({ scale: 1 }).width * CSS_PX_PER_PT;
    const cssScale = this.zoom === "fit" ? available / firstWidthPx : Number(this.zoom) / 100;
    const scale = cssScale * CSS_PX_PER_PT;

    const container = document.createElement("div");
    container.className = "emd-pdf-pages";
    const items = pages.map((page, index) => {
      const viewport = page.getViewport({ scale });
      const div = document.createElement("div");
      div.className = "emd-pdf-page";
      div.style.width = `${Math.floor(viewport.width)}px`;
      div.style.height = `${Math.floor(viewport.height)}px`;
      div.dataset.index = index;
      container.append(div);
      return { page, viewport, div, rendered: false };
    });

    // Work out which pages will be visible after the swap and render those
    // first so the update is seamless.
    const ratio = this.scrollRatio();
    let total = PAGE_GAP;
    const offsets = items.map((item) => {
      const top = total;
      total += Math.floor(item.viewport.height) + PAGE_GAP;
      return top;
    });
    const viewHeight = this.scroller.clientHeight;
    const targetTop = Math.max(0, ratio * Math.max(0, total - viewHeight));
    const visible = items.filter(
      (_, i) => offsets[i] + items[i].viewport.height >= targetTop - 200 && offsets[i] <= targetTop + viewHeight + 200,
    );
    await Promise.all(visible.map((item) => this.renderPage(item)));
    if (seq !== this.seq) {
      task.destroy();
      return null;
    }

    this.observer?.disconnect();
    this.scroller.replaceChildren(container);
    this.scroller.scrollTop = targetTop;
    this.pdfTask?.destroy();
    this.pdfTask = task;

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const item = items[Number(entry.target.dataset.index)];
          if (!item.rendered) this.renderPage(item);
        }
      },
      { root: this.scroller, rootMargin: "800px 0px" },
    );
    items.forEach((item) => this.observer.observe(item.div));
    this.pageItems = items;
    return pages.length;
  }

  async renderPage(item) {
    if (item.rendered) return;
    item.rendered = true;
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(item.viewport.width * dpr);
    canvas.height = Math.floor(item.viewport.height * dpr);
    canvas.style.width = `${Math.floor(item.viewport.width)}px`;
    canvas.style.height = `${Math.floor(item.viewport.height)}px`;
    try {
      await item.page.render({
        canvas,
        canvasContext: canvas.getContext("2d"),
        viewport: item.viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      }).promise;
      item.div.replaceChildren(canvas);
    } catch {
      item.rendered = false;
    }
  }

  // -------------------------------------------------------------- Paged mode

  async showPaged(html, seq) {
    const old = this.scroller.querySelector("iframe");
    let ratio = 0;
    if (old?.contentWindow) {
      const d = old.contentDocument?.documentElement;
      const max = d ? d.scrollHeight - old.clientHeight : 0;
      ratio = max > 0 ? old.contentWindow.scrollY / max : 0;
    }

    const frame = document.createElement("iframe");
    frame.className = "emd-paged-frame";
    frame.title = "Document preview";
    // Lay out off-screen without visibility:hidden, which makes Firefox
    // throttle the frame and slows pagination down ~40x.
    frame.style.opacity = "0";
    frame.style.pointerEvents = "none";
    const done = new Promise((resolve) => {
      const timeout = setTimeout(resolve, 15000);
      frame.addEventListener("paged", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    frame.srcdoc = html;
    this.scroller.append(frame);
    await done;

    if (seq !== this.seq) {
      frame.remove();
      return null;
    }
    this.observer?.disconnect();
    this.pdfTask?.destroy();
    this.pdfTask = null;
    for (const child of [...this.scroller.children]) {
      if (child !== frame) child.remove();
    }
    // paged.js rewrites stylesheets in the document head, so add the
    // on-screen page layout once pagination has finished.
    const style = frame.contentDocument?.createElement("style");
    if (style) {
      style.textContent =
        ".pagedjs_pages{display:flex;flex-direction:column;align-items:safe center;width:max-content;min-width:100%;box-sizing:border-box;padding:16px}" +
        ".pagedjs_page{box-shadow:0 2px 12px rgba(0,0,0,.18);margin-bottom:16px}" +
        "html,body{background:transparent!important}" +
        "[data-split-to]{text-align-last:auto!important}";
      frame.contentDocument.head.append(style);
      // Links would navigate the preview away from the document: scroll to
      // internal targets instead, and open web links in a new window.
      frame.contentDocument.addEventListener("click", (e) => {
        const a = e.target.closest?.("a[href]");
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute("href") || "";
        if (href.startsWith("#")) {
          frame.contentDocument.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ behavior: "smooth", block: "start" });
        } else if (/^(https?|mailto):/i.test(href)) {
          window.open(href, "_blank", "noopener");
        }
      });
      frame.contentDocument.addEventListener("dragstart", (e) => e.preventDefault());
    }
    frame.style.opacity = "";
    frame.style.pointerEvents = "";
    this.applyPagedZoom(frame);
    const d = frame.contentDocument?.documentElement;
    if (d) frame.contentWindow.scrollTo(0, ratio * (d.scrollHeight - frame.clientHeight));
    return frame.contentDocument?.querySelectorAll(".pagedjs_page").length ?? 0;
  }

  applyPagedZoom(frame) {
    const doc = frame.contentDocument;
    if (!doc?.body) return;
    const page = doc.querySelector(".pagedjs_page");
    let zoom = 1;
    if (this.zoom === "fit" && page) {
      const width = page.getBoundingClientRect().width / (Number(doc.documentElement.style.zoom) || 1);
      zoom = Math.max(0.2, (this.scroller.clientWidth - 2 * PAGE_GAP) / width);
    } else if (this.zoom !== "fit") {
      zoom = Number(this.zoom) / 100;
    }
    doc.documentElement.style.zoom = String(zoom);
  }

  // ------------------------------------------------- text lookup (PDF mode)

  async pageText(index) {
    this.textCache ||= new Map();
    const key = `${this.seq}:${index}`;
    if (this.textCache.has(key)) return this.textCache.get(key);
    const items = this.pageItems?.[index];
    if (!items) return null;
    const content = await items.page.getTextContent();
    const entries = content.items
      .filter((i) => i.str.trim())
      .map((i) => ({ str: i.str, y: i.transform[5], x: i.transform[4], height: i.height }));
    const result = { entries, text: entries.map((e) => e.str).join(" ").replace(/\s+/g, " ") };
    this.textCache.set(key, result);
    return result;
  }

  /** Scroll to the first occurrence of `snippet` in the PDF. */
  async revealText(snippet) {
    const needle = (snippet || "").replace(/\s+/g, " ").trim().slice(0, 30);
    if (!needle || !this.pageItems) return false;
    for (let i = 0; i < this.pageItems.length; i++) {
      const page = await this.pageText(i);
      if (!page || !page.text.includes(needle)) continue;
      const item = this.pageItems[i];
      const words = needle.split(" ").slice(0, 3).join(" ");
      const entry = page.entries.find((e) => e.str.includes(words) || words.includes(e.str.trim())) || page.entries[0];
      const viewport = item.viewport;
      const [, y] = viewport.convertToViewportPoint(entry.x, entry.y);
      const top = item.div.offsetTop + y - (entry.height || 10) * viewport.scale;
      this.scroller.scrollTo({ top: Math.max(0, top - this.scroller.clientHeight / 3), behavior: "smooth" });
      const mark = document.createElement("div");
      mark.className = "emd-pdf-mark";
      mark.style.top = `${y + 2}px`;
      item.div.append(mark);
      setTimeout(() => mark.remove(), 1700);
      return true;
    }
    return false;
  }

  async onPdfClick(e) {
    const div = e.target.closest(".emd-pdf-page");
    if (!div || !this.pageItems) return;
    const item = this.pageItems[Number(div.dataset.index)];
    const page = await this.pageText(Number(div.dataset.index));
    if (!page) return;
    const rect = div.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let best = null;
    let bestDist = Infinity;
    for (const entry of page.entries) {
      const [ex, ey] = item.viewport.convertToViewportPoint(entry.x, entry.y);
      const d = Math.abs(ey - y) * 3 + Math.abs(ex - x) * 0.2;
      if (d < bestDist) {
        bestDist = d;
        best = entry;
      }
    }
    this.lastClickedText = best?.str || null;
  }

  /** The last rendered PDF, if any (used for downloads). */
  get lastPdf() {
    return this.mode === "pdf" ? this.pdfBytes : null;
  }
}
