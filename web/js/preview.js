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
    frame.style.visibility = "hidden";
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
    frame.style.visibility = "";
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

  /** The last rendered PDF, if any (used for downloads). */
  get lastPdf() {
    return this.mode === "pdf" ? this.pdfBytes : null;
  }
}
