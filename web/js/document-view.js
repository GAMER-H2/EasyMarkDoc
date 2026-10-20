// Editable page view.
//
// The document is rendered by the server in "edit" format (paginated by
// paged.js, every top-level block tagged with data-src="first-last" source
// lines). Each block is contenteditable. Edits are serialised back to
// Markdown and spliced into the source as you type; the pages are re-laid
// out when you pause. Structural edits (Enter, Backspace, lists…) are
// applied to the Markdown and reflected in the page immediately where
// possible.

import { api } from "./api.js";
import {
  MARK,
  MARK_END,
  DROP,
  blockMd,
  mergeFragments,
  enterAt,
  backspaceAt,
  insertMarkers,
  findImages,
  parseAttrs,
  formatAttrs,
  plainLine,
} from "./mdtools.js";

const FRAME_CSS = new URL("../editor-frame.css", import.meta.url).href;
const REPAGINATE_DELAY = 900;

export class PageView {
  /**
   * @param {HTMLElement} root
   * @param {object} opts
   * @param {object} opts.source  adapter over the Markdown editor
   * @param {() => {css: string, baseDir: string}} opts.getInput
   * @param {(ctx: object|null) => void} opts.onContext
   * @param {(status: object) => void} opts.onStatus
   * @param {(name: string, event: KeyboardEvent) => boolean} opts.onShortcut
   * @param {(files: File[]) => Promise<string[]>} opts.onImageFiles  upload → Markdown snippets
   */
  constructor(root, opts) {
    this.root = root;
    this.opts = opts;
    this.source = opts.source;
    this.frame = null;
    this.zoom = "fit";
    this.seq = 0;
    this.controller = null;
    this.idleTimer = null;
    this.heights = new WeakMap();
    this.selected = null; // { el, line, index }
    this.masking = false;
    this.composing = false;
    this.pointerDown = false;
    root.classList.add("page-view");
    this.frameCss = fetch(FRAME_CSS).then((r) => r.text()).catch(() => "");

    new ResizeObserver(() => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.applyZoom(), 100);
    }).observe(root);
  }

  get doc() {
    return this.frame?.contentDocument || null;
  }

  // ------------------------------------------------------------- rendering

  /**
   * Re-render after the Markdown or theme changed elsewhere. With
   * `keepSelection`, the caret or selection on the page survives (used for
   * theme changes, where the page text itself didn't change).
   */
  scheduleRender(delay = 350, { keepSelection = false } = {}) {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const range = keepSelection ? this.selectionSourceRange() : null;
      this.render({ caret: range?.start ?? null, caretEnd: range?.end ?? null, reselect: this.selectedRef() });
    }, delay);
  }

  /**
   * Render the document.
   * @param {object} o
   * @param {number|null} [o.caret]  source index at which to place the caret
   * @param {number|null} [o.caretEnd]  source index of the far end of a selection
   * @param {boolean} [o.focus]      focus the page after rendering
   * @param {boolean} [o.reveal]     scroll the caret to the middle of the view
   * @param {{line:number,index:number}} [o.reselect]  image to select afterwards
   */
  async render({ caret = null, caretEnd = null, focus = false, reveal = false, reselect = null } = {}) {
    clearTimeout(this.idleTimer);
    const seq = ++this.seq;
    const version = this.source.version();
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const started = performance.now();
    this.opts.onStatus({ state: "rendering" });

    let markdown = this.source.getText();
    let fallbackLine = null;
    if (caret != null) {
      const marked = insertMarkers(markdown, caret, caretEnd);
      markdown = marked.text;
      if (!marked.marked) fallbackLine = this.source.lineOfIndex(caret);
    } else if (!markdown.trim()) {
      markdown = MARK;
      focus = true;
    }

    let html;
    try {
      const input = this.opts.getInput();
      const response = await api("/api/render", {
        method: "POST",
        raw: true,
        signal: controller.signal,
        body: { markdown, css: input.css || null, base_dir: input.baseDir || null, format: "edit" },
      });
      html = await response.text();
    } catch (err) {
      if (err.name !== "AbortError" && seq === this.seq) this.opts.onStatus({ state: "error", message: err.message });
      return;
    }
    if (seq !== this.seq) return;

    const frame = document.createElement("iframe");
    frame.className = "page-frame";
    frame.title = "Document";
    // Lay out off-screen without visibility:hidden, which makes Firefox
    // throttle the frame and slows pagination down ~40x.
    frame.style.opacity = "0";
    frame.style.pointerEvents = "none";
    const done = new Promise((resolve) => {
      const timeout = setTimeout(resolve, 20000);
      frame.addEventListener("paged", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    frame.srcdoc = html;
    this.root.append(frame);
    this.applyZoom(frame);
    await done;

    // Discard if superseded, or if the user kept typing in the old page.
    if (seq !== this.seq) {
      frame.remove();
      return;
    }
    if (this.source.version() !== version) {
      frame.remove();
      this.scheduleRepaginate();
      return;
    }

    const old = this.frame;
    const anchor = old ? this.captureScroll(old) : null;
    const hadFocus = old ? this.hasFocus() : false;
    this.prepare(frame, await this.frameCss);
    this.frame = frame;
    this.selected = null;
    this.masking = false;
    old?.remove();
    frame.style.opacity = "";
    frame.style.pointerEvents = "";
    this.applyZoom(frame);

    const caretRange = this.restoreMarker(fallbackLine);
    const win = frame.contentWindow;
    if (caretRange) {
      // Restore the caret/selection; only take focus if the page had it.
      const sel = this.doc.getSelection();
      sel.removeAllRanges();
      sel.addRange(caretRange);
      if (focus || hadFocus) {
        win.focus();
        caretRange.startContainer.parentElement?.closest("[contenteditable=true]")?.focus({ preventScroll: true });
        sel.removeAllRanges();
        sel.addRange(caretRange);
      }
    }
    if (reveal && caretRange) {
      const rect = caretRect(caretRange);
      win.scrollTo(0, Math.max(0, win.scrollY + rect.top - win.innerHeight / 3));
      this.flash(caretRange.startContainer);
    } else if (anchor) {
      this.restoreScroll(anchor, caretRange);
    }
    if (reselect) {
      const el = this.findImage(reselect.line, reselect.index);
      if (el) this.selectImage(el);
    }
    this.reportContext();

    const pages = this.doc.querySelectorAll(".pagedjs_page").length;
    this.opts.onStatus({ state: "ok", pages, ms: Math.round(performance.now() - started) });
  }

  scheduleRepaginate(delay = REPAGINATE_DELAY) {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.composing || this.pointerDown) return this.scheduleRepaginate(delay);
      const range = this.hasFocus() || this.hasTextSelection() ? this.commitSelection() : null;
      this.render({ caret: range?.start ?? null, caretEnd: range?.end ?? null, reselect: this.selectedRef() });
    }, delay);
  }

  captureScroll(frame) {
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    let caretTop = null;
    const sel = doc?.getSelection();
    if (sel?.rangeCount && this.hasFocus()) caretTop = caretRect(sel.getRangeAt(0)).top;
    return { scrollY: win.scrollY, caretTop };
  }

  restoreScroll(anchor, caretRange) {
    const win = this.frame.contentWindow;
    if (anchor.caretTop != null && caretRange) {
      const top = caretRect(caretRange).top;
      win.scrollTo(0, win.scrollY + top - anchor.caretTop);
    } else {
      win.scrollTo(0, anchor.scrollY);
    }
  }

  /** Make the freshly paginated document editable and wire up events. */
  prepare(frame, css) {
    const doc = frame.contentDocument;
    const style = doc.createElement("style");
    style.textContent = css;
    doc.head.append(style);
    doc.execCommand("styleWithCSS", false, false);
    // Firefox draws its own resize grips and table controls on editable
    // images and tables; the page view has its own handles.
    for (const cmd of ["enableObjectResizing", "enableInlineTableEditing", "enableAbsolutePositionEditor"]) {
      try {
        doc.execCommand(cmd, false, "false");
      } catch {
        /* not supported (Chromium) */
      }
    }
    doc.documentElement.classList.add("emd-editing");

    for (const el of doc.querySelectorAll("[data-src]")) {
      const locked =
        el.classList.contains("emd-raw") ||
        el.classList.contains("emd-toc-block") ||
        el.classList.contains("page-break") ||
        el.tagName === "HR";
      el.contentEditable = locked ? "false" : "true";
      el.spellcheck = true;
      this.heights.set(el, el.offsetHeight);
    }
    for (const box of doc.querySelectorAll("[data-src] input[type=checkbox]")) box.removeAttribute("disabled");
    for (const img of doc.querySelectorAll("[data-img]")) {
      if (img.classList.contains("emd-image")) {
        img.contentEditable = "false";
        img.querySelector(".emd-caption")?.setAttribute("contenteditable", "true");
      }
      img.querySelectorAll("img").forEach((i) => (i.draggable = false));
      if (img.tagName === "IMG") img.draggable = false;
    }

    doc.addEventListener("input", (e) => this.onInput(e));
    doc.addEventListener("keydown", (e) => this.onKeyDown(e));
    doc.addEventListener("paste", (e) => this.onPaste(e));
    doc.addEventListener("change", (e) => {
      if (e.target.matches("input[type=checkbox]")) this.commitBlock(this.blockOf(e.target));
    });
    doc.addEventListener("selectionchange", () => this.reportContext());
    doc.addEventListener("compositionstart", () => (this.composing = true));
    doc.addEventListener("compositionend", () => {
      this.composing = false;
      this.onInput();
    });
    doc.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    doc.addEventListener("wheel", (e) => this.onMaskWheel(e), { passive: false });
    doc.addEventListener("dblclick", (e) => {
      const img = e.target.closest?.("[data-img]");
      if (img) {
        e.preventDefault();
        this.enterMask();
      }
    });
    // Links never navigate the page view (that would replace the document);
    // clicking one just places the caret so its text can be edited.
    doc.addEventListener("click", (e) => this.onLinkClick(e), true);
    doc.addEventListener("auxclick", (e) => e.target.closest?.("a[href]") && e.preventDefault(), true);
    // Native drag and drop of page content (images, selected text) would
    // change the page behind the Markdown's back, so it's disabled: images
    // are moved with the editor's own drag, text with cut and paste.
    doc.addEventListener("dragstart", (e) => e.preventDefault());
    doc.addEventListener("dragover", (e) => {
      // Always accept, so a drop never makes the frame navigate to the data.
      e.preventDefault();
      const files = [...(e.dataTransfer?.items || [])].some((i) => i.kind === "file");
      const range = this.rangeFromPoint(e.clientX, e.clientY);
      if (e.dataTransfer) e.dataTransfer.dropEffect = files || range ? "copy" : "none";
      this.showDropCaret(range);
    });
    doc.addEventListener("dragleave", (e) => {
      if (!e.relatedTarget) this.showDropCaret(null);
    });
    doc.addEventListener("drop", (e) => this.onDrop(e));
    doc.addEventListener("focusin", () => this.opts.onFocus?.());
  }

  restoreMarker(fallbackLine) {
    const doc = this.doc;
    let found = null;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const hits = [];
    const ends = [];
    while (walker.nextNode()) {
      if (walker.currentNode.data.includes(MARK)) hits.push(walker.currentNode);
      if (walker.currentNode.data.includes(MARK_END)) ends.push(walker.currentNode);
    }
    for (const node of hits) {
      const offset = node.data.indexOf(MARK);
      node.deleteData(offset, 1);
      const editable = node.parentElement?.closest("[contenteditable=true]");
      if (!found && editable) {
        const block = this.blockOf(node);
        if (block && !block.textContent.trim() && !block.querySelector("br,img,input")) {
          block.append(doc.createElement("br"));
        }
        found = doc.createRange();
        found.setStart(node, offset);
        found.collapse(true);
      }
    }
    let end = null;
    for (const node of ends) {
      const offset = node.data.indexOf(MARK_END);
      node.deleteData(offset, 1);
      if (!end && node.parentElement?.closest("[contenteditable=true]")) end = { node, offset };
    }
    if (found && end) {
      try {
        found.setEnd(end.node, end.offset);
      } catch {
        /* end before start: keep the caret */
      }
    }
    if (!found && fallbackLine != null) {
      const block = this.blockForLine(fallbackLine);
      if (block?.isContentEditable) {
        found = doc.createRange();
        found.selectNodeContents(block);
        found.collapse(true);
      }
    }
    return found;
  }

  applyZoom(frame = this.frame) {
    if (!frame) return;
    let zoom = 1;
    if (this.zoom === "fit") {
      const page = frame.contentDocument?.querySelector(".pagedjs_page");
      const width = page ? page.offsetWidth : 794;
      zoom = Math.max(0.3, Math.min(2.5, (this.root.clientWidth - 48) / (width + 32)));
    } else {
      zoom = Number(this.zoom) / 100;
    }
    frame.style.zoom = String(zoom);
    if (frame === this.frame) this.drawSelection();
  }

  setZoom(zoom) {
    this.zoom = zoom;
    this.applyZoom();
  }

  hasFocus() {
    const doc = this.doc;
    return !!doc && doc.hasFocus() && !!doc.activeElement?.isContentEditable;
  }

  // ------------------------------------------------------------ block model

  blockOf(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    return el?.closest?.("[data-src]") || null;
  }

  rangeOf(block) {
    const [a, b] = block.dataset.src.split("-").map(Number);
    return [a, b];
  }

  fragmentsOf(block) {
    const ref = block.dataset.ref;
    if (!ref) return [block];
    return [...this.doc.querySelectorAll(`[data-src][data-ref="${ref}"]`)];
  }

  blocks() {
    const seen = new Set();
    const out = [];
    for (const el of this.doc?.querySelectorAll("[data-src]") || []) {
      const key = el.dataset.ref || el;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(el);
    }
    return out;
  }

  blockForLine(line) {
    let best = null;
    for (const block of this.blocks()) {
      const [a, b] = this.rangeOf(block);
      if (line >= a && line <= b) return block;
      if (a > line) return best || block;
      best = block;
    }
    return best;
  }

  setRange(block, a, b) {
    for (const f of this.fragmentsOf(block)) f.dataset.src = `${a}-${b}`;
  }

  /** Shift the ranges of every block starting after `afterLine`. */
  shiftRanges(afterLine, delta, except = null) {
    if (!delta) return;
    for (const el of this.doc.querySelectorAll("[data-src]")) {
      if (except && except.includes(el)) continue;
      const [a, b] = this.rangeOf(el);
      if (a > afterLine) el.dataset.src = `${a + delta}-${b + delta}`;
    }
  }

  /**
   * Serialise a block to Markdown. With `marker`, MARK is inserted at the
   * caret (if it is inside the block); with `selection` too, MARK_END is
   * inserted at the far end of a non-empty selection. The page selection
   * is left exactly as it was.
   */
  serialize(block, { marker = false, selection = false } = {}) {
    const doc = this.doc;
    const marks = [];
    let saved = null;
    const frags = this.fragmentsOf(block);
    if (marker) {
      const sel = doc.getSelection();
      if (sel.rangeCount) {
        const range = sel.getRangeAt(0);
        const inside = (node) => frags.some((f) => f.contains(node));
        if (inside(range.startContainer)) {
          saved = saveSelection(frags, sel);
          // Insert the end marker first so the start position stays valid.
          if (selection && !range.collapsed && inside(range.endContainer)) {
            const r = range.cloneRange();
            r.collapse(false);
            marks.push(insertText(doc, r, MARK_END));
          }
          const r = range.cloneRange();
          r.collapse(true);
          marks.push(insertText(doc, r, MARK));
        }
      }
    }
    const merged = mergeFragments(frags);
    const md = blockMd(merged);
    if (marks.length) {
      for (const node of marks) {
        const parent = node.parentNode;
        node.remove();
        parent?.normalize();
      }
      restoreSelection(frags, doc.getSelection(), saved);
    }
    return md;
  }

  /**
   * Write a block's current content back into the source. Returns the
   * caret's source index when `marker` is set (and, with `selection`, sets
   * `lastSelectionEnd` to the index of the selection's far end).
   */
  commitBlock(block, { marker = false, selection = false } = {}) {
    this.lastSelectionEnd = null;
    if (!block) return null;
    const md = this.serialize(block, { marker, selection });
    if (md === null) return null;
    const [a, b] = this.rangeOf(block);
    const idx = md.indexOf(MARK);
    const endIdx = md.indexOf(MARK_END);
    const clean = md.replace(MARK, "").replace(MARK_END, "");
    if (clean !== this.source.getLines(a, b)) {
      const count = clean.split("\n").length;
      this.source.replaceLines(a, b, clean);
      this.setRange(block, a, a + count - 1);
      this.shiftRanges(b, count - (b - a + 1), this.fragmentsOf(block));
    }
    const base = this.source.indexOfLine(a);
    if (endIdx >= 0 && idx >= 0) this.lastSelectionEnd = base + endIdx - (endIdx > idx ? 1 : 0);
    if (idx < 0) return null;
    return base + idx - (endIdx >= 0 && endIdx < idx ? 1 : 0);
  }

  /** Commit the block holding the caret and return the caret's source index. */
  commitCaret() {
    const sel = this.doc?.getSelection();
    if (!sel?.rangeCount) return null;
    return this.commitBlock(this.blockOf(sel.getRangeAt(0).startContainer), { marker: true });
  }

  /** Like commitCaret, but returns `{start, end}` for a selection. */
  commitSelection() {
    const sel = this.doc?.getSelection();
    if (!sel?.rangeCount) return null;
    const start = this.commitBlock(this.blockOf(sel.getRangeAt(0).startContainer), { marker: true, selection: true });
    return start == null ? null : { start, end: this.lastSelectionEnd };
  }

  /** Is there a non-empty text selection inside an editable block? */
  hasTextSelection() {
    const sel = this.doc?.getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return false;
    return !!this.blockOf(sel.getRangeAt(0).startContainer)?.isContentEditable;
  }

  /**
   * Source indexes of the page caret/selection without touching the source.
   * Null unless the block round-trips exactly.
   */
  selectionSourceRange() {
    const sel = this.doc?.getSelection();
    if (!sel?.rangeCount) return null;
    const block = this.blockOf(sel.getRangeAt(0).startContainer);
    if (!block?.isContentEditable) return null;
    const md = this.serialize(block, { marker: true, selection: true });
    if (md === null || !md.includes(MARK)) return null;
    const [a, b] = this.rangeOf(block);
    if (md.replace(MARK, "").replace(MARK_END, "") !== this.source.getLines(a, b)) return null;
    const base = this.source.indexOfLine(a);
    const idx = md.indexOf(MARK);
    const endIdx = md.indexOf(MARK_END);
    return { start: base + idx, end: endIdx > idx ? base + endIdx - 1 : null };
  }

  /**
   * Source index of the caret without rewriting the block. Exact when the
   * block's Markdown round-trips; otherwise matched by nearby text.
   */
  caretSourceIndex() {
    const sel = this.doc?.getSelection();
    if (!sel?.rangeCount) return null;
    const block = this.blockOf(sel.anchorNode);
    if (!block) return null;
    const [a, b] = this.rangeOf(block);
    const start = this.source.indexOfLine(a);
    const md = this.serialize(block, { marker: true });
    if (md === null || !md.includes(MARK)) return start;
    const idx = md.indexOf(MARK);
    const original = this.source.getLines(a, b);
    if (md.replace(MARK, "") === original) return start + idx;
    // Fuzzy: find the text just before the caret in the original block.
    const before = md.slice(0, idx);
    const lineNo = before.split("\n").length - 1;
    const lineBefore = plainLine(before.split("\n").pop());
    const lines = original.split("\n");
    const target = Math.min(lineNo, lines.length - 1);
    const snippet = lineBefore.slice(-24);
    const order = [target, ...lines.keys()].filter((v, i, arr) => arr.indexOf(v) === i);
    for (const l of order) {
      const pos = snippet ? lines[l].indexOf(snippet) : -1;
      if (pos >= 0) {
        const offset = lines.slice(0, l).reduce((n, s) => n + s.length + 1, 0);
        return start + offset + pos + snippet.length;
      }
    }
    const offset = lines.slice(0, target).reduce((n, s) => n + s.length + 1, 0);
    return start + offset;
  }

  // ------------------------------------------------------------- editing

  onInput() {
    if (this.composing) return;
    const sel = this.doc.getSelection();
    const block = this.blockOf(sel.anchorNode);
    if (!block) return;
    this.commitBlock(block, { marker: true });
    const frags = this.fragmentsOf(block);
    const height = frags.reduce((h, f) => h + f.offsetHeight, 0);
    const before = frags.reduce((h, f) => h + (this.heights.get(f) ?? 0), 0);
    if (frags.length > 1 || height !== before) this.scheduleRepaginate();
    this.reportContext();
  }

  /** Replace a block's Markdown (containing MARK) and re-render. */
  applyStructural(block, mdWithMark) {
    const [a, b] = this.rangeOf(block);
    const idx = mdWithMark.indexOf(MARK);
    this.source.replaceLines(a, b, mdWithMark.replace(MARK, ""));
    const caret = idx >= 0 ? this.source.indexOfLine(a) + idx : this.source.indexOfLine(a);
    return this.render({ caret, focus: true });
  }

  onKeyDown(e) {
    if (e.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();

    if (this.selected) {
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        this.deleteSelectedImage();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (this.masking) this.exitMask();
        else this.deselect();
        return;
      }
      if (!mod) this.deselect();
    }

    if (mod) {
      if (key === "b" || key === "i") {
        e.preventDefault();
        this.format(key === "b" ? "bold" : "italic");
        return;
      }
      if (this.opts.onShortcut(e)) e.preventDefault();
      return;
    }

    const sel = this.doc.getSelection();
    if (!sel.rangeCount) return;
    const block = this.blockOf(sel.anchorNode);
    if (!block || !block.isContentEditable) return;

    if (e.key === "Enter") {
      e.preventDefault();
      this.enter(block, e.shiftKey);
    } else if (e.key === "Backspace" && sel.isCollapsed) {
      this.backspace(block, e);
    } else if (e.key === "Delete" && sel.isCollapsed) {
      this.forwardDelete(block, e);
    } else if (e.key === "Tab") {
      e.preventDefault();
      this.tab(block, e.shiftKey);
    }
  }

  enter(block, shift) {
    const doc = this.doc;
    const tag = block.tagName;
    const sel = doc.getSelection();
    if (!sel.isCollapsed) doc.execCommand("delete");

    if (tag === "PRE") {
      const md = this.serialize(block, { marker: true });
      const line = md.slice(0, md.indexOf(MARK)).split("\n").pop();
      doc.execCommand("insertText", false, "\n" + line.match(/^[ \t]*/)[0]);
      return;
    }
    if (tag === "TABLE") return;
    if (shift && tag !== "H1" && !/^H\d$/.test(tag)) {
      doc.execCommand("insertLineBreak");
      return;
    }

    const md = this.serialize(block, { marker: true });
    if (md === null) return;
    const next = enterAt(md, tag, { shift });
    if (next === null) return;

    // Fast paths: split paragraphs, headings and list items in place.
    const range = sel.getRangeAt(0);
    const li = range.startContainer.parentElement?.closest("li");
    const itemEmpty = li && !li.textContent.replace(/\s/g, "") && !li.querySelector("img");
    if ((tag === "P" || /^H\d$/.test(tag)) && !block.closest("blockquote")) {
      this.splitBlockInPlace(block, next, "P");
    } else if ((tag === "UL" || tag === "OL") && li && !itemEmpty && !li.querySelector("ul,ol,p")) {
      this.splitListItemInPlace(block, li, next);
    } else {
      this.applyStructural(block, next);
    }
  }

  splitBlockInPlace(block, nextMd, newTag) {
    const doc = this.doc;
    const sel = doc.getSelection();
    const frags = this.fragmentsOf(block);
    const last = frags[frags.length - 1];
    const range = sel.getRangeAt(0).cloneRange();
    range.setEnd(last, last.childNodes.length);
    const tail = range.extractContents();
    const el = doc.createElement(newTag);
    el.contentEditable = "true";
    el.append(tail);
    for (const f of frags) if (!f.textContent && !f.querySelector("img,br")) f.append(doc.createElement("br"));
    if (!el.textContent && !el.querySelector("img")) el.append(doc.createElement("br"));
    last.after(el);

    const [a, b] = this.rangeOf(block);
    const idx = nextMd.indexOf(MARK);
    const clean = nextMd.replace(MARK, "");
    const firstPart = clean.slice(0, idx).replace(/\n+$/, "");
    const firstCount = firstPart.split("\n").length;
    const secondStart = a + clean.slice(0, idx).split("\n").length - 1;
    const total = clean.split("\n").length;
    this.source.replaceLines(a, b, clean);
    this.setRange(block, a, a + firstCount - 1);
    this.shiftRanges(b, total - (b - a + 1), [...frags, el]);
    el.dataset.src = `${secondStart}-${a + total - 1}`;
    this.heights.set(el, 0);

    const r = doc.createRange();
    r.selectNodeContents(el);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    el.focus({ preventScroll: true });
    this.scheduleRepaginate(400);
    this.reportContext();
  }

  splitListItemInPlace(block, li, nextMd) {
    const doc = this.doc;
    const sel = doc.getSelection();
    const range = sel.getRangeAt(0).cloneRange();
    range.setEnd(li, li.childNodes.length);
    const tail = range.extractContents();
    const item = doc.createElement("li");
    const box = li.querySelector(":scope > input[type=checkbox]");
    if (box) {
      item.className = li.className;
      const nb = doc.createElement("input");
      nb.type = "checkbox";
      item.append(nb, doc.createTextNode(" "));
    }
    // extractContents may have carried a checkbox clone; drop it.
    tail.querySelectorAll?.(":scope > input[type=checkbox]").forEach((n) => n.remove());
    item.append(tail);
    if (!item.textContent.trim() && !item.querySelector("img")) item.append(doc.createElement("br"));
    if (!li.textContent.trim() && !li.querySelector("img")) li.append(doc.createElement("br"));
    li.after(item);

    const [a, b] = this.rangeOf(block);
    const clean = nextMd.replace(MARK, "");
    const total = clean.split("\n").length;
    this.source.replaceLines(a, b, clean);
    this.setRange(block, a, a + total - 1);
    this.shiftRanges(b, total - (b - a + 1), this.fragmentsOf(block));

    const r = doc.createRange();
    const firstText = [...item.childNodes].find((n) => n.nodeType === 3 && n.data.trim()) || item;
    r.setStart(firstText, firstText === item ? item.childNodes.length - (item.lastChild?.nodeName === "BR" ? 1 : 0) : 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    this.scheduleRepaginate(400);
  }

  backspace(block, e) {
    const md = this.serialize(block, { marker: true });
    if (md === null) return;
    const result = backspaceAt(md);
    if (!result) return;
    e.preventDefault();
    if (result.md) {
      if (/^H\d$/.test(block.tagName) && /^#{1,6}\s/.test(md.replace(MARK, ""))) {
        // Heading → body text, in place.
        const doc = this.doc;
        for (const f of this.fragmentsOf(block)) {
          const p = doc.createElement("p");
          for (const attr of ["data-src", "data-ref", "contenteditable"]) if (f.hasAttribute(attr)) p.setAttribute(attr, f.getAttribute(attr));
          p.append(...f.childNodes);
          f.replaceWith(p);
          if (f === block) block = p;
        }
        const [a, b] = this.rangeOf(block);
        this.source.replaceLines(a, b, result.md.replace(MARK, ""));
        const r = doc.createRange();
        r.selectNodeContents(block);
        r.collapse(true);
        doc.getSelection().removeAllRanges();
        doc.getSelection().addRange(r);
        this.scheduleRepaginate(300);
        this.reportContext();
        return;
      }
      this.applyStructural(block, result.md);
      return;
    }
    // Merge into the previous block.
    const blocks = this.blocks();
    const index = blocks.findIndex((b) => this.fragmentsOf(b).includes(block));
    const prev = blocks[index - 1];
    if (!prev) return;
    this.mergeInto(prev, block, md);
  }

  forwardDelete(block, e) {
    const md = this.serialize(block, { marker: true });
    if (md === null) return;
    const after = md.slice(md.indexOf(MARK) + 1);
    if (after.trim()) return;
    const blocks = this.blocks();
    const index = blocks.findIndex((b) => this.fragmentsOf(b).includes(block));
    const next = blocks[index + 1];
    if (!next) return;
    e.preventDefault();
    const nextMd = this.serialize(next);
    if (nextMd === null) return;
    this.mergeInto(block, next, nextMd.replace(/^(#{1,6}\s+)/, ""), { caretAtJoin: true, prevMd: md });
  }

  /**
   * Merge `cur` (Markdown `curMd`, may contain MARK) onto the end of `prev`.
   */
  mergeInto(prev, cur, curMd, { prevMd = null } = {}) {
    const [pa, pb] = this.rangeOf(prev);
    const [ca, cb] = this.rangeOf(cur);
    const prevText = prevMd ?? this.source.getLines(pa, pb);
    const prevTag = prev.tagName;
    const curText = curMd.replace(/^(#{1,6}[ \t]+)/, "");

    if (prev.classList.contains("page-break") || prevTag === "HR" || prev.classList.contains("emd-toc-block")) {
      // Remove the separator block (and the blank line after it).
      const removed = this.source.replaceLines(pa, pb, null);
      const caretLine = ca - removed;
      return this.render({ caret: this.source.indexOfLine(caretLine) + Math.max(0, curMd.indexOf(MARK)), focus: true });
    }
    if (prevTag === "PRE" || prevTag === "TABLE" || prev.classList.contains("emd-raw")) return;

    let joined;
    if (prevMd != null) {
      // Forward delete: MARK sits at the end of prevMd.
      joined = prevMd.replace(/[ \t]+(?=$)/, "") + curText;
    } else {
      joined = prevText.replace(/\s+$/, "") + (curText.startsWith(MARK) ? curText : MARK + curText);
    }
    const idx = joined.indexOf(MARK);
    const clean = joined.replace(MARK, "");
    // Replace the later block first so earlier line numbers stay valid.
    this.source.replaceLines(ca, cb, null);
    this.source.replaceLines(pa, pb, clean);
    const caret = this.source.indexOfLine(pa) + idx;
    return this.render({ caret, focus: true });
  }

  tab(block, outdent) {
    if (block.tagName === "TABLE") {
      const cell = this.doc.getSelection().anchorNode?.parentElement?.closest("td,th");
      const cells = [...block.querySelectorAll("td,th")];
      const next = cells[cells.indexOf(cell) + (outdent ? -1 : 1)];
      if (next) {
        const r = this.doc.createRange();
        r.selectNodeContents(next);
        this.doc.getSelection().removeAllRanges();
        this.doc.getSelection().addRange(r);
      }
      return;
    }
    if (block.tagName !== "UL" && block.tagName !== "OL") return;
    const md = this.serialize(block, { marker: true });
    const i = md.indexOf(MARK);
    const lineStart = md.lastIndexOf("\n", i - 1) + 1;
    if (lineStart === 0 && !outdent) return; // first item can't be nested
    let line = md.slice(lineStart).split("\n")[0];
    line = outdent ? line.replace(/^ {1,4}/, "") : "    " + line;
    const rest = md.slice(lineStart).split("\n").slice(1).join("\n");
    this.applyStructural(block, md.slice(0, lineStart) + line + (rest ? "\n" + rest : ""));
  }

  onPaste(e) {
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      this.insertFiles(files);
      return;
    }
    if (!text.includes("\n")) {
      this.doc.execCommand("insertText", false, text);
      return;
    }
    // Multi-line paste is treated as Markdown.
    this.insertMarkdown(text, { block: /\n\s*\n/.test(text) });
  }

  /** Insert Markdown at the caret. Block snippets get their own paragraph. */
  insertMarkdown(snippet, { block: asBlock = false, caretOffset = null } = {}) {
    const sel = this.doc?.getSelection();
    const block = sel?.rangeCount ? this.blockOf(sel.anchorNode) : null;
    if (!block || !block.isContentEditable) return false;
    const md = this.serialize(block, { marker: true });
    if (md === null || !md.includes(MARK)) return false;
    const i = md.indexOf(MARK);
    const pos = caretOffset ?? snippet.length;
    const withCaret = snippet.slice(0, pos) + MARK + snippet.slice(pos);
    let next;
    if (asBlock) {
      const clean = md.replace(MARK, "");
      const before = md.slice(0, i).replace(/\s+$/, "");
      const after = md.slice(i + 1).replace(/^\s+/, "");
      if (!clean.trim()) next = withCaret; // empty paragraph: replace it
      else if (block.tagName !== "P" || block.closest("blockquote")) next = `${clean}\n\n${withCaret}`;
      else if (!before.trim()) next = `${withCaret}\n\n${clean}`;
      else next = [before, withCaret, after].filter((t) => t.trim()).join("\n\n");
    } else {
      next = md.slice(0, i) + withCaret + md.slice(i + 1);
    }
    this.applyStructural(block, next);
    return true;
  }

  // ------------------------------------------------------- inline formatting

  format(command, value) {
    const doc = this.doc;
    if (!doc) return;
    switch (command) {
      case "bold":
      case "italic":
      case "strikeThrough":
        doc.execCommand(command);
        break;
      case "mark":
      case "code":
        this.toggleWrap(command);
        break;
      case "link": {
        if (!value) break;
        const existing = this.linkElement();
        if (existing) existing.setAttribute("href", value);
        else doc.execCommand("createLink", false, value);
        break;
      }
      case "unlink": {
        const existing = this.linkElement();
        if (existing) unwrap(existing);
        else doc.execCommand("unlink");
        break;
      }
    }
    this.onInput();
  }

  /** The link at the caret, if any. */
  linkElement() {
    const sel = this.doc?.getSelection();
    if (!sel?.rangeCount) return null;
    const node = sel.getRangeAt(0).startContainer;
    const el = node.nodeType === 1 ? node : node.parentElement;
    const a = el?.closest("a[href]");
    return a && this.blockOf(a)?.isContentEditable ? a : null;
  }

  linkAtCaret() {
    return this.linkElement()?.getAttribute("href") ?? null;
  }

  toggleWrap(tag) {
    const doc = this.doc;
    const sel = doc.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const existing = range.commonAncestorContainer.parentElement?.closest(tag) ||
      (range.commonAncestorContainer.nodeType === 1 && range.commonAncestorContainer.closest(tag));
    if (existing) {
      const parent = existing.parentNode;
      while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
      existing.remove();
      return;
    }
    if (range.collapsed) return;
    const el = doc.createElement(tag);
    el.append(range.extractContents());
    range.insertNode(el);
    const r = doc.createRange();
    r.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /**
   * Apply character styles (`{color: "#c00", "font-family": …}`; null
   * removes) to the selected text. They're stored as `<span style>` in the
   * Markdown. Returns false when there's no text selection on the page.
   */
  applyTextStyle(props) {
    const doc = this.doc;
    const sel = doc?.getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const startBlock = this.blockOf(range.startContainer);
    if (!startBlock?.isContentEditable) return false;
    const backward = sel.anchorNode === range.endContainer && sel.anchorOffset === range.endOffset && !range.collapsed;

    // Split the text nodes at the selection's ends.
    let { startContainer: sc, startOffset: so, endContainer: ec, endOffset: eo } = range;
    if (ec.nodeType === 3 && eo > 0 && eo < ec.length) ec.splitText(eo);
    if (sc.nodeType === 3 && so > 0 && so < sc.length) {
      const tail = sc.splitText(so);
      if (ec === sc) {
        ec = tail;
        eo -= so;
      }
      sc = tail;
      so = 0;
    }
    const r = doc.createRange();
    r.setStart(sc, so);
    r.setEnd(ec, eo);
    const texts = [];
    const walker = doc.createTreeWalker(r.commonAncestorContainer.nodeType === 3 ? r.commonAncestorContainer.parentNode : r.commonAncestorContainer, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode;
      if (!t.data.length || !r.intersectsNode(t)) continue;
      if (t === ec && eo === 0) continue;
      if (t === sc && so === t.length) continue;
      const editable = t.parentElement?.closest("[contenteditable]");
      if (editable?.isContentEditable && !t.parentElement.closest(".emd-ui, pre")) texts.push(t);
    }
    if (!texts.length) return false;

    const blocks = new Set();
    for (const t of texts) {
      blocks.add(this.blockOf(t));
      // Reuse a styled span that the selection covers entirely.
      let span = null;
      for (let p = t.parentElement; p && !p.hasAttribute("data-src"); p = p.parentElement) {
        if (p.tagName === "SPAN" && p.hasAttribute("style") && !p.className) {
          const inner = textNodes([p]).filter((n) => n.data.length);
          const first = inner[0];
          const last = inner[inner.length - 1];
          if (first && r.comparePoint(first, 0) === 0 && r.comparePoint(last, last.length) === 0) span = p;
          break;
        }
      }
      if (!span) {
        span = doc.createElement("span");
        t.replaceWith(span);
        span.append(t);
      }
      for (const [prop, value] of Object.entries(props)) {
        if (value == null || value === "") span.style.removeProperty(prop);
        else span.style.setProperty(prop, value);
        // An inner span setting the same property would hide the change.
        for (const inner of span.querySelectorAll("span[style]")) inner.style.removeProperty(prop);
      }
      for (const node of [span, ...span.querySelectorAll("span[style]")]) {
        if (!node.getAttribute("style")?.trim()) unwrap(node);
      }
    }

    const first = texts[0];
    const last = texts[texts.length - 1];
    if (backward) sel.setBaseAndExtent(last, last.length, first, 0);
    else sel.setBaseAndExtent(first, 0, last, last.length);
    this.commitStyled(blocks);
    return true;
  }

  /** Remove character styles from the selection (or the styled text at the caret). */
  clearTextStyle() {
    const doc = this.doc;
    const sel = doc?.getSelection();
    if (!sel?.rangeCount) return false;
    const range = sel.getRangeAt(0);
    const block = this.blockOf(range.startContainer);
    if (!block?.isContentEditable) return false;
    const spans = new Set();
    const ancestors = (node) => {
      for (let p = node.nodeType === 1 ? node : node.parentElement; p && !p.hasAttribute("data-src"); p = p.parentElement) {
        if (p.tagName === "SPAN" && p.hasAttribute("style") && !p.className) spans.add(p);
      }
    };
    ancestors(range.startContainer);
    ancestors(range.endContainer);
    for (const frag of this.fragmentsOf(block)) {
      for (const span of frag.querySelectorAll("span[style]")) if (!span.className && range.intersectsNode(span)) spans.add(span);
    }
    if (!spans.size) return false;
    const blocks = new Set([...spans].map((sp) => this.blockOf(sp)));
    const saved = saveSelection(this.fragmentsOf(block), sel);
    for (const span of spans) if (span.isConnected) unwrap(span);
    for (const b of blocks) for (const f of this.fragmentsOf(b)) f.normalize();
    restoreSelection(this.fragmentsOf(block), sel, saved);
    this.commitStyled(blocks);
    return true;
  }

  commitStyled(blocks) {
    let resized = false;
    for (const b of blocks) {
      if (!b?.isConnected) continue;
      this.commitBlock(b);
      const frags = this.fragmentsOf(b);
      const height = frags.reduce((h, f) => h + f.offsetHeight, 0);
      if (frags.length > 1 || height !== frags.reduce((h, f) => h + (this.heights.get(f) ?? 0), 0)) resized = true;
    }
    if (resized) this.scheduleRepaginate();
    this.reportContext({ force: true });
  }

  // --------------------------------------------------------------- context

  reportContext({ force = false } = {}) {
    if (this.selected) {
      this.opts.onContext(this.imageContext());
      return;
    }
    const doc = this.doc;
    const sel = doc?.getSelection();
    if (!sel?.rangeCount || (!force && !this.hasFocus())) return;
    const node = sel.anchorNode;
    const el = node.nodeType === 1 ? node : node.parentElement;
    const block = this.blockOf(node);
    if (!block) return;
    const li = el.closest("li");
    const list = li ? (li.classList.contains("task-list-item") ? "task" : li.parentElement.tagName === "OL" ? "number" : "bullet") : "none";
    let style = "body";
    if (/^H[1-6]$/.test(block.tagName)) style = `h${block.tagName[1]}`;
    else if (block.tagName === "PRE") style = "code";
    else if (el.closest("blockquote")) style = "quote";
    else if (el.closest("table")) style = "table";
    // The text the character controls act on: the selection's start.
    const range = sel.getRangeAt(0);
    let at = range.startContainer;
    if (at.nodeType === 3 && range.startOffset === at.length && !range.collapsed) {
      const walker = doc.createTreeWalker(range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentNode, NodeFilter.SHOW_TEXT);
      walker.currentNode = at;
      at = walker.nextNode() || at;
    }
    const styleEl = at.nodeType === 1 ? at : at.parentElement;
    const cs = getComputedStyle(styleEl);
    this.opts.onContext({
      kind: "text",
      style,
      list,
      selection: !range.collapsed && block.isContentEditable,
      text: { font: cs.fontFamily, size: Math.round(parseFloat(cs.fontSize) * 0.75 * 2) / 2, color: cs.color },
      styled: !!styleEl.closest("span[style]:not([class])"),
      bold: doc.queryCommandState("bold"),
      italic: doc.queryCommandState("italic"),
      strike: doc.queryCommandState("strikeThrough") || !!el.closest("del,s"),
      mark: !!el.closest("mark"),
      code: !!el.closest("code"),
      link: !!el.closest("a"),
    });
  }

  // ----------------------------------------------------------------- images

  findImage(line, index) {
    const block = this.blocks().find((b) => this.rangeOf(b)[0] === line);
    if (!block) return null;
    for (const f of this.fragmentsOf(block)) {
      const el = f.querySelector(`[data-img="${index}"]`);
      if (el) return el;
    }
    return null;
  }

  selectedRef() {
    return this.selected ? { line: this.selected.line, index: this.selected.index } : null;
  }

  selectImage(el) {
    const block = this.blockOf(el);
    if (!block) return;
    this.selected = { el, line: this.rangeOf(block)[0], index: Number(el.dataset.img) };
    this.doc.getSelection().removeAllRanges();
    this.drawSelection();
    this.opts.onContext(this.imageContext());
  }

  deselect() {
    if (this.masking) this.exitMask(false);
    this.selected = null;
    this.doc?.querySelector(".emd-image-selection")?.remove();
    this.opts.onContext(null);
  }

  imageSource() {
    if (!this.selected) return null;
    const block = this.blockOf(this.selected.el);
    const [a, b] = this.rangeOf(block);
    const text = this.source.getLines(a, b);
    const image = findImages(text)[this.selected.index];
    return image ? { block, a, b, text, image } : null;
  }

  imageContext() {
    const found = this.imageSource();
    const img = this.selected.el.tagName === "IMG" ? this.selected.el : this.selected.el.querySelector("img");
    return {
      kind: "image",
      attrs: parseAttrs(found?.image.attrs || ""),
      alt: found?.image.alt ?? img?.alt ?? "",
      title: found?.image.title ?? null,
      src: found?.image.src ?? img?.getAttribute("src"),
      natural: img ? { width: img.naturalWidth, height: img.naturalHeight } : null,
      resolvedSrc: img?.src || "",
      masking: this.masking,
    };
  }

  /** Rewrite the selected image's Markdown. `mutate(image)` edits a copy. */
  updateSelectedImage(mutate) {
    const found = this.imageSource();
    if (!found) return;
    const { a, b, text, image } = found;
    const next = {
      alt: image.alt,
      src: image.src,
      title: image.title,
      attrs: parseAttrs(image.attrs || ""),
    };
    mutate(next);
    const attrs = formatAttrs(next.attrs);
    const dest = /[\s()<>]/.test(next.src) ? `<${next.src}>` : next.src;
    const title = next.title ? ` "${next.title.replace(/"/g, '\\"')}"` : "";
    const md = `![${next.alt.replace(/([\[\]])/g, "\\$1")}](${dest}${title})${attrs ? `{${attrs}}` : ""}`;
    this.source.replaceLines(a, b, text.slice(0, image.start) + md + text.slice(image.end));
    const reselect = this.selectedRef();
    const masking = this.masking;
    return this.render({ reselect }).then(() => {
      if (masking) this.enterMask();
    });
  }

  deleteSelectedImage() {
    const found = this.imageSource();
    if (!found) return;
    const { a, b, text, image } = found;
    const next = text.slice(0, image.start) + text.slice(image.end);
    this.source.replaceLines(a, b, next.trim() ? next : null);
    this.selected = null;
    this.opts.onContext(null);
    this.render();
  }

  /** Frame box used for selection handles. */
  imageBox(el) {
    return el.classList.contains("emd-image") ? el.querySelector(".emd-image-frame") || el : el;
  }

  drawSelection() {
    const doc = this.doc;
    if (!doc) return;
    doc.querySelector(".emd-image-selection")?.remove();
    if (!this.selected) return;
    const el = this.selected.el;
    if (!el.isConnected) {
      this.selected = null;
      return;
    }
    const rect = this.imageBox(el).getBoundingClientRect();
    const win = this.frame.contentWindow;
    const box = doc.createElement("div");
    box.className = "emd-ui emd-image-selection" + (this.masking ? " masking" : "");
    Object.assign(box.style, {
      left: `${rect.left + win.scrollX}px`,
      top: `${rect.top + win.scrollY}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    if (!this.masking) {
      for (const dir of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
        const h = doc.createElement("div");
        h.className = "emd-handle";
        h.dataset.dir = dir;
        box.append(h);
      }
      const size = doc.createElement("div");
      size.className = "emd-size-label";
      const attrs = this.imageContext().attrs;
      size.textContent = attrs.width ? `${attrs.width}` : "auto";
      box.append(size);
    } else {
      const done = doc.createElement("button");
      done.className = "emd-mask-done";
      done.textContent = "Done";
      done.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.exitMask();
      });
      const hint = doc.createElement("div");
      hint.className = "emd-mask-hint";
      hint.textContent = "Drag to reposition · scroll to zoom";
      box.append(done, hint);
    }
    doc.body.append(box);
  }

  onPointerDown(e) {
    const doc = this.doc;
    const handle = e.target.closest?.(".emd-handle");
    if (handle && this.selected) {
      e.preventDefault();
      this.resizeDrag(e, handle.dataset.dir);
      return;
    }
    if (e.target.closest?.(".emd-image-selection.masking")) {
      e.preventDefault();
      this.maskDrag(e);
      return;
    }
    if (e.target.closest?.(".emd-caption")) return;
    const img = e.target.closest?.("[data-img]");
    if (img) {
      e.preventDefault();
      this.selectImage(img);
      if (e.button === 0) this.moveDrag(e, img);
      return;
    }
    if (this.selected) this.deselect();

    // Clicking the empty part of a page puts the caret in the nearest block.
    if (!e.target.closest?.("[contenteditable=true]") && e.target.closest?.(".pagedjs_page")) {
      const page = e.target.closest(".pagedjs_page");
      const blocks = [...page.querySelectorAll("[data-src][contenteditable=true]")];
      if (!blocks.length) return;
      let best = blocks[blocks.length - 1];
      let after = true;
      for (const b of blocks) {
        const r = b.getBoundingClientRect();
        if (e.clientY < r.bottom) {
          best = b;
          after = e.clientY > r.top;
          break;
        }
      }
      e.preventDefault();
      best.focus({ preventScroll: true });
      const range = doc.createRange();
      range.selectNodeContents(best);
      range.collapse(!after);
      doc.getSelection().removeAllRanges();
      doc.getSelection().addRange(range);
    }
    // Hold off re-laying out the pages while text is being selected. The
    // release may happen outside the page view, so listen there too.
    this.pointerDown = true;
    const release = () => {
      this.pointerDown = false;
      doc.removeEventListener("pointerup", release);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("blur", release);
    };
    doc.addEventListener("pointerup", release);
    window.addEventListener("pointerup", release);
    window.addEventListener("blur", release);
  }

  /**
   * Links don't navigate. A click in editable text just places the caret;
   * on read-only parts (table of contents, footnotes), or with ⌘/Ctrl, an
   * internal link scrolls to its target and an external one opens in a tab.
   */
  onLinkClick(e) {
    const a = e.target.closest?.("a[href]");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") || "";
    const follow = e.metaKey || e.ctrlKey || !a.isContentEditable;
    if (!follow) return;
    if (href.startsWith("#")) this.scrollToAnchor(decodeURIComponent(href.slice(1)));
    else if (/^(https?|mailto):/i.test(href) && (e.metaKey || e.ctrlKey)) window.open(href, "_blank", "noopener");
  }

  scrollToAnchor(id) {
    const doc = this.doc;
    const target = id && (doc.getElementById(id) || doc.querySelector(`[name="${CSS.escape(id)}"]`));
    if (!target) return false;
    const win = this.frame.contentWindow;
    win.scrollTo({ top: Math.max(0, win.scrollY + target.getBoundingClientRect().top - 40), behavior: "smooth" });
    this.flash(target);
    return true;
  }

  /**
   * Follow a pointer drag that started with `e`. The pointer is captured so
   * the drag keeps working (and ends cleanly) when it leaves the page view,
   * e.g. over the toolbar or outside the window. Escape cancels.
   */
  trackPointer(e, { move, end }) {
    const doc = this.doc;
    const root = doc.documentElement;
    try {
      root.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    root.classList.add("emd-pointer-drag");
    this.pointerDown = true;
    let done = false;
    const finish = (ev, cancelled) => {
      if (done) return;
      done = true;
      doc.removeEventListener("pointermove", onMove);
      doc.removeEventListener("pointerup", onUp);
      doc.removeEventListener("pointercancel", onCancel);
      root.removeEventListener("lostpointercapture", onLost);
      doc.removeEventListener("keydown", onKey, true);
      try {
        root.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      root.classList.remove("emd-pointer-drag");
      this.pointerDown = false;
      end(ev, cancelled);
    };
    const onMove = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!ev.buttons) return finish(ev, false); // released somewhere we didn't see
      ev.preventDefault();
      move(ev);
    };
    const onUp = (ev) => ev.pointerId === e.pointerId && finish(ev, false);
    const onCancel = (ev) => ev.pointerId === e.pointerId && finish(ev, true);
    const onLost = (ev) => ev.pointerId === e.pointerId && setTimeout(() => finish(ev, false), 0);
    const onKey = (ev) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(ev, true);
    };
    doc.addEventListener("pointermove", onMove);
    doc.addEventListener("pointerup", onUp);
    doc.addEventListener("pointercancel", onCancel);
    root.addEventListener("lostpointercapture", onLost);
    doc.addEventListener("keydown", onKey, true);
  }

  /** Scroll the page view when a drag nears its top or bottom edge. */
  autoScroll(ev) {
    const win = this.frame.contentWindow;
    const edge = 40;
    if (ev.clientY < edge) win.scrollBy(0, -Math.ceil((edge - ev.clientY) / 2));
    else if (ev.clientY > win.innerHeight - edge) win.scrollBy(0, Math.ceil((ev.clientY - win.innerHeight + edge) / 2));
  }

  resizeDrag(e, dir) {
    const doc = this.doc;
    const el = this.selected.el;
    const box = this.imageBox(el);
    const start = box.getBoundingClientRect();
    const container = el.parentElement.closest("p, li, td, th, blockquote, .markdown-body") || el.parentElement;
    const cs = getComputedStyle(container);
    const available = container.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const ratio = start.width / Math.max(1, start.height);
    const original = { width: el.style.width, maxWidth: el.style.maxWidth };
    let width = start.width;
    let moved = false;
    this.trackPointer(e, {
      move: (ev) => {
        moved = true;
        const dx = ev.clientX - e.clientX;
        const dy = ev.clientY - e.clientY;
        let delta = 0;
        if (dir.includes("e")) delta = dx;
        else if (dir.includes("w")) delta = -dx;
        if (dir === "n") delta = -dy * ratio;
        if (dir === "s") delta = dy * ratio;
        if (dir.length === 2) delta = Math.abs(dx) > Math.abs(dy * ratio) ? delta : (dir.includes("n") ? -dy : dy) * ratio;
        width = Math.max(24, Math.min(available, start.width + delta));
        el.style.width = `${width}px`;
        el.style.maxWidth = "none";
        this.drawSelection();
        const label = doc.querySelector(".emd-size-label");
        if (label) label.textContent = `${Math.round((width / available) * 100)}%`;
      },
      end: (ev, cancelled) => {
        if (cancelled || !moved) {
          Object.assign(el.style, original);
          this.drawSelection();
          return;
        }
        const pct = Math.round((width / available) * 1000) / 10;
        this.updateSelectedImage((img) => (img.attrs.width = `${pct}%`));
      },
    });
  }

  moveDrag(e, el) {
    const doc = this.doc;
    let dragging = false;
    let ghost = null;
    let range = null;
    this.trackPointer(e, {
      move: (ev) => {
        if (!dragging && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 6) return;
        if (!dragging) {
          dragging = true;
          const img = el.tagName === "IMG" ? el : el.querySelector("img");
          ghost = doc.createElement("img");
          ghost.src = img.src;
          ghost.className = "emd-ui emd-drag-ghost";
          ghost.style.width = `${Math.min(160, this.imageBox(el).getBoundingClientRect().width)}px`;
          doc.body.append(ghost);
          doc.querySelector(".emd-image-selection")?.remove();
        }
        this.autoScroll(ev);
        ghost.style.left = `${ev.clientX + 12}px`;
        ghost.style.top = `${ev.clientY + 12}px`;
        range = this.rangeFromPoint(ev.clientX, ev.clientY);
        if (range && el.contains(range.startContainer)) range = null;
        this.showDropCaret(range);
      },
      end: (ev, cancelled) => {
        ghost?.remove();
        this.showDropCaret(null);
        if (dragging && range && !cancelled) this.moveImage(el, range);
        else if (this.selected) this.drawSelection();
      },
    });
  }

  rangeFromPoint(x, y) {
    const doc = this.doc;
    let range = null;
    if (doc.caretPositionFromPoint) {
      const pos = doc.caretPositionFromPoint(x, y);
      if (pos) {
        range = doc.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      }
    } else if (doc.caretRangeFromPoint) {
      range = doc.caretRangeFromPoint(x, y);
    }
    if (!range) return null;
    range.collapse(true);
    const el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const editable = el?.closest("[contenteditable=true]");
    if (!editable || el.closest(".emd-ui") || !this.blockOf(el)) return null;
    // Snap to the nearest word boundary rather than splitting a word.
    const node = range.startContainer;
    if (node.nodeType === 3) {
      const text = node.data;
      let a = range.startOffset;
      let b = range.startOffset;
      const word = /[\p{L}\p{N}_'’-]/u;
      while (a > 0 && word.test(text[a - 1])) a--;
      while (b < text.length && word.test(text[b])) b++;
      if (a !== b && a !== range.startOffset) {
        const offset = range.startOffset - a <= b - range.startOffset ? a : b;
        range.setStart(node, offset);
        range.collapse(true);
      }
    }
    return range;
  }

  showDropCaret(range) {
    const doc = this.doc;
    if (!doc) return;
    let caret = doc.querySelector(".emd-drop-caret");
    if (!range) {
      caret?.remove();
      return;
    }
    if (!caret) {
      caret = doc.createElement("div");
      caret.className = "emd-ui emd-drop-caret";
      doc.body.append(caret);
    }
    const rect = caretRect(range);
    const win = this.frame.contentWindow;
    Object.assign(caret.style, {
      left: `${rect.left + win.scrollX - 1}px`,
      top: `${rect.top + win.scrollY}px`,
      height: `${Math.max(16, rect.height)}px`,
    });
  }

  /** Move an image to a new position in the text flow. */
  moveImage(el, range) {
    const fromBlock = this.blockOf(el);
    const toBlock = this.blockOf(range.startContainer);
    if (!fromBlock || !toBlock) return;
    const [fa, fb] = this.rangeOf(fromBlock);
    const fromText = this.source.getLines(fa, fb);
    const image = findImages(fromText)[Number(el.dataset.img)];
    if (!image) return;
    const imageMd = fromText.slice(image.start, image.end);

    const drop = this.doc.createTextNode(DROP);
    range.insertNode(drop);
    // Don't leave a double space where the image was.
    const prev = el.previousSibling;
    const next = el.nextSibling;
    if (prev?.nodeType === 3 && next?.nodeType === 3 && /\s$/.test(prev.data) && /^\s/.test(next.data)) next.deleteData(0, 1);
    el.remove();

    const same = this.fragmentsOf(fromBlock).includes(toBlock) || fromBlock === toBlock;
    const [ta, tb] = this.rangeOf(toBlock);
    const toMd = this.serialize(toBlock);
    if (toMd === null) return this.render();
    // Keep the image separated from the words around it.
    const at = toMd.indexOf(DROP);
    const pre = at > 0 && !/\s/.test(toMd[at - 1]) ? " " : "";
    const post = at + 1 < toMd.length && !/[\s.,;:!?)]/.test(toMd[at + 1]) ? " " : "";
    const placed = toMd.replace(DROP, pre + imageMd + MARK + post);

    if (same) {
      const idx = placed.indexOf(MARK);
      this.source.replaceLines(ta, tb, placed.replace(MARK, ""));
      return this.render({ caret: this.source.indexOfLine(ta) + idx, focus: true });
    }
    let fromMd = this.serialize(fromBlock) ?? fromText.slice(0, image.start) + fromText.slice(image.end);
    // An emptied paragraph is removed entirely.
    const emptied = !fromMd.trim();
    const idx = placed.indexOf(MARK);
    const cleanTo = placed.replace(MARK, "");
    let caretLine = ta;
    if (fa > ta) {
      this.source.replaceLines(fa, fb, emptied ? null : fromMd);
      this.source.replaceLines(ta, tb, cleanTo);
    } else {
      this.source.replaceLines(ta, tb, cleanTo);
      const before = fb - fa + 1;
      if (emptied) caretLine = ta - this.source.replaceLines(fa, fb, null);
      else {
        this.source.replaceLines(fa, fb, fromMd);
        caretLine = ta + (fromMd.split("\n").length - before);
      }
    }
    return this.render({ caret: this.source.indexOfLine(caretLine) + idx, focus: true });
  }

  // ------------------------------------------------------------- crop mask

  async enterMask() {
    if (!this.selected) return;
    const ctx = this.imageContext();
    if (!ctx.attrs.aspect && ctx.natural?.width) {
      const g = gcd(ctx.natural.width, ctx.natural.height);
      const w = ctx.natural.width / g;
      const h = ctx.natural.height / g;
      const aspect = w > 100 || h > 100 ? `${Math.round((ctx.natural.width / ctx.natural.height) * 1000) / 1000}:1` : `${w}:${h}`;
      this.masking = true;
      await this.updateSelectedImage((img) => {
        img.attrs.aspect = aspect;
        img.attrs.focus = img.attrs.focus || "50,50";
      });
      return;
    }
    this.masking = true;
    this.drawSelection();
    this.opts.onContext(this.imageContext());
  }

  exitMask(notify = true) {
    this.masking = false;
    this.drawSelection();
    if (notify && this.selected) this.opts.onContext(this.imageContext());
  }

  maskDrag(e) {
    const el = this.selected.el;
    const img = el.querySelector("img");
    const frameBox = this.imageBox(el).getBoundingClientRect();
    const attrs = this.imageContext().attrs;
    const [fx, fy] = String(attrs.focus || "50,50").split(",").map(Number);
    const zoom = Number(attrs.zoom || 1);
    const original = { objectPosition: img.style.objectPosition, transformOrigin: img.style.transformOrigin };
    let focus = [fx, fy];
    this.trackPointer(e, {
      move: (ev) => {
        const dx = (((ev.clientX - e.clientX) / frameBox.width) * 100) / zoom;
        const dy = (((ev.clientY - e.clientY) / frameBox.height) * 100) / zoom;
        focus = [clamp(fx - dx, 0, 100), clamp(fy - dy, 0, 100)];
        img.style.objectPosition = `${focus[0]}% ${focus[1]}%`;
        img.style.transformOrigin = `${focus[0]}% ${focus[1]}%`;
      },
      end: (ev, cancelled) => {
        if (cancelled) return Object.assign(img.style, original);
        const value = `${Math.round(focus[0])},${Math.round(focus[1])}`;
        if (value !== `${fx},${fy}`) this.updateSelectedImage((i) => (i.attrs.focus = value));
      },
    });
  }

  /** Scroll-to-zoom while editing a crop mask. */
  onMaskWheel(ev) {
    if (!this.masking || !this.selected || !ev.target.closest?.(".emd-image-selection.masking")) return;
    ev.preventDefault();
    const img = this.selected.el.querySelector("img");
    if (!img) return;
    const current = Number(img.dataset.zoom || this.imageContext().attrs.zoom || 1);
    const next = clamp(current * (1 - ev.deltaY * 0.002), 1, 5);
    img.dataset.zoom = next;
    img.style.transform = `scale(${next})`;
    clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => {
      this.updateSelectedImage((i) => (i.attrs.zoom = Math.round(next * 100) / 100));
    }, 400);
  }

  /** Live (uncommitted) preview of an attribute while dragging a slider. */
  previewImage(key, value) {
    const el = this.selected?.el;
    if (!el) return;
    const img = el.tagName === "IMG" ? el : el.querySelector("img");
    const frame = this.imageBox(el);
    if (key === "width") el.style.width = value;
    if (key === "opacity") img.style.opacity = value;
    if (key === "rotate") frame.style.transform = `rotate(${value}deg)`;
    if (key === "radius") frame.style.borderRadius = value;
    if (key === "zoom") img.style.transform = `scale(${value})`;
    this.drawSelection();
  }

  // ------------------------------------------------------------ drop files

  async onDrop(e) {
    const all = [...(e.dataTransfer?.files || [])];
    const files = all.filter((f) => f.type.startsWith("image/"));
    this.showDropCaret(null);
    this.opts.onDragDone?.();
    e.preventDefault();
    e.stopPropagation();
    if (!all.length) {
      // Dropped text or a link: insert it as plain text where it was dropped.
      const text = e.dataTransfer?.getData("text/plain");
      const range = text ? this.rangeFromPoint(e.clientX, e.clientY) : null;
      if (!range) return;
      const block = this.blockOf(range.startContainer);
      block?.focus({ preventScroll: true });
      this.doc.getSelection().removeAllRanges();
      this.doc.getSelection().addRange(range);
      if (text.includes("\n")) this.insertMarkdown(text, { block: /\n\s*\n/.test(text) });
      else this.doc.execCommand("insertText", false, text);
      return;
    }
    if (!files.length) {
      this.opts.onOtherFiles?.(all);
      return;
    }
    const range = this.rangeFromPoint(e.clientX, e.clientY);
    if (range) {
      this.doc.getSelection().removeAllRanges();
      this.doc.getSelection().addRange(range);
    }
    this.insertFiles(files);
  }

  async insertFiles(files) {
    const sel = this.doc.getSelection();
    const block = sel.rangeCount ? this.blockOf(sel.anchorNode) : null;
    let dropNode = null;
    if (block) {
      dropNode = this.doc.createTextNode(DROP);
      sel.getRangeAt(0).insertNode(dropNode);
    }
    const snippets = await this.opts.onImageFiles(files);
    if (!snippets.length) {
      dropNode?.remove();
      return;
    }
    const md = snippets.join("\n\n");
    if (!dropNode?.isConnected || !block?.isConnected) {
      this.opts.onInsertFallback?.(md);
      return;
    }
    const serialized = this.serialize(block);
    const i = serialized.indexOf(DROP);
    const before = serialized.slice(0, i).replace(/[ \t]+$/, "");
    const after = serialized.slice(i + 1);
    // Images dropped between paragraphs get a paragraph of their own.
    const ownBlock = !before.trim() || !after.trim() || /\n$/.test(before);
    const next = ownBlock
      ? [before.trim(), md + MARK, after.trim()].filter(Boolean).join("\n\n")
      : `${before} ${md}${MARK}${after}`;
    this.applyStructural(block, next);
  }

  // ------------------------------------------------------------ navigation

  /** Put the caret at a source index (re-renders with a marker). */
  revealSource(index) {
    return this.render({ caret: index, focus: true, reveal: true });
  }

  flash(node) {
    const block = this.blockOf(node);
    if (!block) return;
    for (const f of this.fragmentsOf(block)) {
      f.classList.remove("emd-flash");
      void f.offsetWidth;
      f.classList.add("emd-flash");
    }
  }
}

function caretRect(range) {
  const rects = range.getClientRects();
  if (rects.length) return rects[0];
  const node = range.startContainer;
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (node.nodeType === 1 && node.childNodes[range.startOffset]?.getBoundingClientRect) {
    return node.childNodes[range.startOffset].getBoundingClientRect();
  }
  return el.getBoundingClientRect();
}

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function insertText(doc, range, text) {
  const node = doc.createTextNode(text);
  const { startContainer: c, startOffset: o } = range;
  // At the edge of a text node, insert beside it rather than splitting it,
  // so the selection's own nodes survive.
  if (c.nodeType === 3 && o === 0) c.before(node);
  else if (c.nodeType === 3 && o === c.length) c.after(node);
  else range.insertNode(node);
  return node;
}

/** Text nodes inside `roots`, in document order. */
function textNodes(roots) {
  const out = [];
  for (const root of roots) {
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) out.push(walker.currentNode);
  }
  return out;
}

/** A boundary point as a character offset into the text of `roots`. */
function textOffset(roots, node, offset) {
  const doc = roots[0].ownerDocument;
  const point = doc.createRange();
  try {
    point.setStart(node, offset);
  } catch {
    return null;
  }
  let n = 0;
  for (const t of textNodes(roots)) {
    if (t === node) return n + offset;
    if (point.comparePoint(t, t.length) > 0) return n; // t ends after the point
    n += t.length;
  }
  return n;
}

/** Map a character offset back to a point; `forward` prefers the start of the next node. */
function textPoint(roots, n, forward = false) {
  const nodes = textNodes(roots);
  for (const t of nodes) {
    if (forward ? n < t.length : n <= t.length) return { node: t, offset: n };
    n -= t.length;
  }
  const last = nodes[nodes.length - 1];
  return last ? { node: last, offset: last.length } : null;
}

/** Remember a selection by character offsets, which survive text-node splits. */
function saveSelection(roots, sel) {
  const raw = { anchorNode: sel.anchorNode, anchorOffset: sel.anchorOffset, focusNode: sel.focusNode, focusOffset: sel.focusOffset };
  const anchor = textOffset(roots, sel.anchorNode, sel.anchorOffset);
  const focus = textOffset(roots, sel.focusNode, sel.focusOffset);
  // A caret at the start of a text node (e.g. just after a line break)
  // belongs with the text that follows it.
  const atStart = (node, offset) => offset === 0 && (node.nodeType === 3 || !!node.childNodes[0]);
  return { raw, anchor, focus, anchorForward: atStart(sel.anchorNode, sel.anchorOffset), focusForward: atStart(sel.focusNode, sel.focusOffset) };
}

function restoreSelection(roots, sel, saved) {
  if (!saved) return;
  const { raw } = saved;
  try {
    // Use the original nodes when they survived (keeps positions next to
    // images and line breaks exact); otherwise map the text offsets back.
    if (raw.anchorNode.isConnected && raw.focusNode.isConnected &&
        raw.anchorOffset <= nodeLength(raw.anchorNode) && raw.focusOffset <= nodeLength(raw.focusNode) &&
        textOffset(roots, raw.anchorNode, raw.anchorOffset) === saved.anchor &&
        textOffset(roots, raw.focusNode, raw.focusOffset) === saved.focus) {
      sel.setBaseAndExtent(raw.anchorNode, raw.anchorOffset, raw.focusNode, raw.focusOffset);
      return;
    }
    const a = saved.anchor == null ? null : textPoint(roots, saved.anchor, saved.anchorForward);
    const f = saved.focus == null ? null : textPoint(roots, saved.focus, saved.focusForward);
    if (a && f) sel.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
  } catch {
    /* leave the selection where the browser put it */
  }
}

function nodeLength(node) {
  return node.nodeType === 3 ? node.length : node.childNodes.length;
}

function unwrap(el) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  el.remove();
}
