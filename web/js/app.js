// EasyMarkDoc web editor.

import { api, ApiError } from "./api.js";
import { parseVars, setVar, removeVar } from "./cssvars.js";
import { Preview } from "./preview.js";
import { PageView } from "./document-view.js";
import { Inspector } from "./inspector.js";
import { ICONS } from "./icons.js";
import { plainLine } from "./mdtools.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const store = {
  get: (k, d = null) => localStorage.getItem(`emd.${k}`) ?? d,
  set: (k, v) => (v == null ? localStorage.removeItem(`emd.${k}`) : localStorage.setItem(`emd.${k}`, v)),
};
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

const WELCOME = `# Welcome to EasyMarkDoc

Type straight onto the page, or edit the **Markdown** on the left: both stay
in sync. Use the arrow buttons between the panels to jump between your cursor
in the source and on the page.

[TOC]

## Writing

You can use *emphasis*, **bold**, ~~strikethrough~~, ==highlights==, \`inline code\`
and [links](https://example.com). Footnotes work too.[^1]

- Bulleted lists
  - with nesting
- [x] and checklists

1. Numbered lists
2. that keep counting

> [!TIP]
> Open **Document** in the toolbar to change the page setup or try a style set.

## Images

Add images with **Media** or by dropping them onto the page. Click an image to
resize it with its handles, drag it to move it, double-click to crop it, and use
the **Format** bar to style it, wrap text around it, rotate it and more.

## Code

\`\`\`rust
fn main() {
    println!("Hello, PDF!");
}
\`\`\`

## Tables

| Feature        | Supported |
|:---------------|:---------:|
| Page numbers   |    Yes    |
| Custom themes  |    Yes    |

[^1]: Footnotes are collected at the end of the document.
`;

const state = {
  markdown: "",
  css: "",
  defaultVars: new Map(),
  docName: "document",
  filePath: null,
  baseDir: null,
  outputDir: null,
  lastDir: store.get("lastDir"),
  dirty: false,
  separator: "/",
  focus: "page", // which side last had the caret: "page" | "source"
  proof: false,
  pages: 0,
};

let mdEditor;
let cssEditor;
let page;
let proof;
let inspector;
let suppressCssChange = false;
let sourceVersion = 0;
let fromPage = false;

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function init() {
  let server;
  try {
    server = await api("/api/state");
  } catch (err) {
    document.body.innerHTML = `<p style="padding:2em;font-family:system-ui">Could not connect to the EasyMarkDoc server: ${err.message}</p>`;
    window.emdBooted = true;
    return;
  }

  state.defaultVars = parseVars(server.default_css);
  state.baseDir = server.base_dir;
  state.outputDir = server.output_dir;
  state.separator = server.path_separator || "/";

  const openParam = new URLSearchParams(location.search).get("open");
  let opened = null;
  if (openParam) {
    try {
      opened = await api("/api/open", { method: "POST", body: { path: openParam } });
    } catch (err) {
      console.warn("Could not open", openParam, err);
    }
  }

  if (opened) {
    state.markdown = opened.content;
    state.filePath = opened.path;
    state.baseDir = opened.directory;
    state.docName = stripExt(opened.name);
    history.replaceState(null, "", location.pathname);
  } else if (server.markdown != null) {
    state.markdown = server.markdown;
    state.filePath = server.file_path;
    state.docName = stripExt(server.file_name || "document");
  } else {
    state.markdown = store.get("markdown", WELCOME);
    state.filePath = store.get("filePath");
    state.docName = store.get("docName", "document");
    const savedBase = store.get("baseDir");
    if (state.filePath && savedBase) state.baseDir = savedBase;
  }
  state.css = opened?.theme ?? server.css ?? store.get("css", "");

  for (const node of $$("[data-icon]")) node.innerHTML = ICONS[node.dataset.icon] || "";

  setupEditors();
  setupPage();
  setupInspector(server.code_themes);
  setupToolbar();
  setupPopovers();
  setupSplitter();
  setupShortcuts();
  setupPicker();
  setupDragAndDrop();
  applyLayout();
  updateFileInfo();
  updateStatus();
  page.render();
  window.emdBooted = true;

  window.addEventListener("beforeunload", (e) => {
    if (state.dirty && state.filePath) e.preventDefault();
  });
}

function effectiveVar(name, depth = 0) {
  if (!name) return "";
  const value = parseVars(state.css).get(name) ?? state.defaultVars.get(name) ?? "";
  // Follow references such as `--link-color: var(--accent-color)`.
  const ref = value.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)$/);
  if (ref && depth < 8) return effectiveVar(ref[1], depth + 1) || (ref[2] ?? "").trim();
  return value;
}

const stripExt = (name) => name.replace(/\.(md|markdown|mdown|txt)$/i, "");
const dirname = (p) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
};
const basename = (p) => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
const joinPath = (dir, name) => (dir.endsWith("/") || dir.endsWith("\\") ? dir + name : dir + state.separator + name);

// ---------------------------------------------------------------------------
// Source editors
// ---------------------------------------------------------------------------

function setupEditors() {
  const mod = isMac ? "Cmd" : "Ctrl";
  mdEditor = CodeMirror($("#markdown-editor"), {
    value: state.markdown,
    mode: { name: "gfm", highlightFormatting: true },
    lineWrapping: true,
    indentUnit: 4,
    tabSize: 4,
    placeholder: "Start writing Markdown…",
    historyEventDelay: 600,
    allowDropFileTypes: ["application/x-none"],
    extraKeys: {
      Enter: "newlineAndIndentContinueMarkdownList",
      Tab: (cm) => (cm.somethingSelected() ? cm.indentSelection("add") : cm.replaceSelection("    ")),
      "Shift-Tab": (cm) => cm.indentSelection("subtract"),
      [`${mod}-B`]: () => formatText("bold"),
      [`${mod}-I`]: () => formatText("italic"),
      [`${mod}-K`]: () => formatText("link"),
      [`${mod}-Alt-1`]: () => paragraphAction("style", "h1"),
      [`${mod}-Alt-2`]: () => paragraphAction("style", "h2"),
      [`${mod}-Alt-3`]: () => paragraphAction("style", "h3"),
      [`${mod}-Alt-0`]: () => paragraphAction("style", "body"),
    },
  });
  mdEditor.on("change", () => {
    sourceVersion++;
    state.markdown = mdEditor.getValue();
    store.set("markdown", state.markdown);
    setDirty(true);
    updateStatus();
    if (!fromPage) page.scheduleRender();
    if (state.proof) proofUpdate();
  });
  mdEditor.on("focus", () => {
    state.focus = "source";
    page.deselect();
  });
  mdEditor.on("cursorActivity", () => {
    if (state.focus === "source") inspector?.setContext(sourceContext());
  });

  cssEditor = CodeMirror($("#css-editor"), {
    value: state.css,
    mode: "css",
    lineNumbers: true,
    indentUnit: 4,
    tabSize: 4,
    allowDropFileTypes: ["application/x-none"],
    placeholder: "/* Custom theme, layered on top of the default theme.\n   The inspector writes its settings here; you can add any CSS. */",
  });
  let cssTimer;
  cssEditor.on("change", () => {
    if (suppressCssChange) return;
    clearTimeout(cssTimer);
    cssTimer = setTimeout(() => {
      state.css = cssEditor.getValue();
      store.set("css", state.css);
      inspector.refresh();
      page.scheduleRender(100);
      if (state.proof) proofUpdate();
    }, 300);
  });

  for (const tab of $$("[data-editor]")) tab.addEventListener("click", () => showEditor(tab.dataset.editor));
}

/** Adapter the page view uses to read and edit the Markdown. */
const source = {
  version: () => sourceVersion,
  getText: () => mdEditor.getValue(),
  getLines(a, b) {
    const last = mdEditor.lastLine();
    const out = [];
    for (let l = a; l <= Math.min(b, last); l++) out.push(mdEditor.getLine(l));
    return out.join("\n");
  },
  /** Replace lines a..b with text; null deletes them (returns lines removed). */
  replaceLines(a, b, text) {
    const doc = mdEditor;
    const last = doc.lastLine();
    fromPage = true;
    try {
      if (text === null) {
        // Delete the lines together with one blank line before them.
        if (a > 0 && !doc.getLine(a - 1).trim()) a--;
        b = Math.min(b, last);
        const from = a > 0 ? { line: a - 1, ch: doc.getLine(a - 1).length } : { line: 0, ch: 0 };
        const to = a > 0 || b >= last ? { line: b, ch: doc.getLine(b).length } : { line: b + 1, ch: 0 };
        doc.replaceRange("", from, to, "+page");
        return b - a + 1;
      } else if (a > last) {
        doc.replaceRange("\n".repeat(a - last) + text, { line: last, ch: doc.getLine(last).length }, undefined, "+page");
      } else {
        const end = Math.min(b, last);
        doc.replaceRange(text, { line: a, ch: 0 }, { line: end, ch: doc.getLine(end).length }, "+page");
      }
    } finally {
      fromPage = false;
    }
  },
  indexOfLine(line) {
    if (line > mdEditor.lastLine()) return mdEditor.getValue().length;
    return mdEditor.indexFromPos({ line, ch: 0 });
  },
  lineOfIndex: (index) => mdEditor.posFromIndex(index).line,
};

function showEditor(which) {
  for (const tab of $$("[data-editor]")) tab.classList.toggle("active", tab.dataset.editor === which);
  $("#markdown-editor").hidden = which !== "markdown";
  $("#css-editor").hidden = which !== "css";
  if (state.sourceHidden) toggleSource(true);
  const cm = which === "css" ? cssEditor : mdEditor;
  cm.refresh();
  cm.focus();
}

function setMarkdown(text, { dirty = false } = {}) {
  mdEditor.setValue(text);
  mdEditor.clearHistory();
  state.markdown = text;
  store.set("markdown", text);
  setDirty(dirty);
  page.render();
}

function setCss(css, { live = false } = {}) {
  state.css = css;
  store.set("css", css);
  suppressCssChange = true;
  const scroll = cssEditor.getScrollInfo();
  const cursor = cssEditor.getCursor();
  cssEditor.setValue(css);
  cssEditor.setCursor(cursor);
  cssEditor.scrollTo(scroll.left, scroll.top);
  suppressCssChange = false;
  if (!live) inspector?.refresh();
  page.scheduleRender(live ? 300 : 60, { keepSelection: true });
  if (state.proof) proofUpdate();
}

function applyVarChanges(changes, { live = false } = {}) {
  let css = state.css;
  for (const [name, value] of Object.entries(changes)) {
    if (!name) continue;
    css = value == null ? removeVar(css, name) : setVar(css, name, value);
  }
  setCss(css, { live });
}

function setDirty(dirty) {
  state.dirty = dirty;
  $("#doc-edited").hidden = !dirty || !state.filePath;
}

function updateFileInfo() {
  $("#file-path").textContent = state.filePath ? `‎${state.filePath}‎` : "Not saved to disk";
  $("#file-path").title = `${state.filePath || "Unsaved document"}\nImages resolve relative to ${state.baseDir}`;
  $("#doc-title").textContent = state.docName;
  document.title = `${state.docName} — EasyMarkDoc`;
  $("#doc-name").value = state.docName;
  $("#doc-location").textContent = state.filePath ? state.filePath : `Not saved · images from ${state.baseDir}`;
  store.set("filePath", state.filePath);
  store.set("baseDir", state.filePath ? state.baseDir : null);
  store.set("docName", state.docName);
  setDirty(state.dirty);
}

function updateStatus(render) {
  if (render) {
    if (render.state === "rendering") return;
    if (render.state === "error") {
      $("#status").textContent = `Error: ${render.message}`;
      $("#status").classList.add("error");
      return;
    }
    state.pages = render.pages ?? state.pages;
  }
  const text = state.markdown.replace(/```[\s\S]*?```/g, " ").replace(/[#>*_`~\-|[\]()!]/g, " ");
  const words = text.split(/\s+/).filter(Boolean).length;
  $("#status").classList.remove("error");
  $("#status").textContent = `${state.pages ? `${state.pages} page${state.pages === 1 ? "" : "s"} · ` : ""}${words.toLocaleString()} words`;
}

// ---------------------------------------------------------------------------
// Page view, proof view and inspector
// ---------------------------------------------------------------------------

function setupPage() {
  page = new PageView($("#page-view"), {
    source,
    getInput: () => ({ css: state.css, baseDir: state.baseDir }),
    onContext: (ctx) => {
      if (ctx) state.focus = "page";
      inspector?.setContext(ctx ?? (state.focus === "page" ? { kind: "text", style: "body", list: "none" } : sourceContext()));
      if (ctx?.kind === "image" && inspector.mode !== "format") setInspectorMode("format");
    },
    onFocus: () => (state.focus = "page"),
    onStatus: (s) => updateStatus(s),
    onShortcut: (e) => handleShortcut(e, "page"),
    onImageFiles: (files) => uploadImages(files),
    onOtherFiles: (files) => openDroppedFiles(files),
    onDragDone: () => document.body.classList.remove("dragging"),
    onInsertFallback: (md) => insertIntoSource(md, true),
  });
  page.zoom = store.get("zoom", "fit");
  updateZoomLabel();

  proof = new Preview($("#proof-view"), { mode: "pdf", zoom: page.zoom, onStatus: (s) => updateStatus(s) });
  $("#proof-view").addEventListener("click", () => (state.focus = "proof"));
}

function proofUpdate(immediate = false) {
  proof.update({ markdown: state.markdown, css: state.css, baseDir: state.baseDir }, { immediate });
}

function setProof(on) {
  state.proof = on;
  $("#proof-view").hidden = !on;
  $("#proof-banner").hidden = !on;
  $("#page-view").hidden = on;
  $("#proof-toggle").classList.toggle("on", on);
  if (on) proofUpdate(true);
  else page.render();
  syncViewChecks();
}

function setupInspector(codeThemes) {
  inspector = new Inspector($("#inspector"), {
    getVar: effectiveVar,
    setVars: applyVarChanges,
    codeThemes,
    applyStyle: (style) => paragraphAction("style", style),
    setList: (kind) => paragraphAction("list", kind),
    formatText,
    textStyle,
    clearTextStyle,
    themeCommand: (id) => command(id),
    image: {
      update: (mutate) => page.updateSelectedImage(mutate),
      preview: (key, value) => page.previewImage(key, value),
      toggleMask: () => (page.masking ? page.exitMask() : page.enterMask()),
      remove: () => page.deleteSelectedImage(),
      replace: () => pickImages((files) => replaceSelectedImage(files[0])),
    },
  });
  inspector.setContext({ kind: "text", style: "body", list: "none" });
  setInspectorMode(store.get("inspectorMode", "format"));
}

function setInspectorMode(mode) {
  inspector.setMode(mode);
  store.set("inspectorMode", mode);
  if (state.inspectorHidden) toggleInspector(true);
  $("#show-format").classList.toggle("on", mode === "format");
  $("#show-document").classList.toggle("on", mode === "document");
}

/** Paragraph context from the source editor's cursor. */
function sourceContext() {
  const line = mdEditor.getLine(mdEditor.getCursor().line) || "";
  let style = "body";
  const h = line.match(/^(#{1,6})\s/);
  if (h) style = `h${h[1].length}`;
  else if (/^\s*>/.test(line)) style = "quote";
  let list = "none";
  if (/^\s*[-+*]\s+\[[ xX]\]/.test(line)) list = "task";
  else if (/^\s*[-+*]\s/.test(line)) list = "bullet";
  else if (/^\s*\d+[.)]\s/.test(line)) list = "number";
  return { kind: "text", style, list, styled: mdEditor.somethingSelected() && /<span style=/.test(mdEditor.getSelection()) };
}

// ---------------------------------------------------------------------------
// Editing actions (apply to whichever side has the caret)
// ---------------------------------------------------------------------------

/** Run a Markdown edit at the caret, wherever the caret is. */
function atCaret(edit) {
  if (state.focus === "page") {
    const idx = page.commitCaret();
    if (idx != null) {
      mdEditor.setCursor(mdEditor.posFromIndex(idx));
      fromPage = true;
      try {
        edit(mdEditor);
      } finally {
        fromPage = false;
      }
      page.render({ caret: mdEditor.indexFromPos(mdEditor.getCursor()), focus: true });
      return;
    }
  }
  edit(mdEditor);
  mdEditor.focus();
}

function paragraphAction(kind, value) {
  atCaret((cm) => {
    if (kind === "style") {
      if (value === "code") return wrapCodeBlock(cm);
      if (value === "quote") return togglePrefix(cm, "quote", true);
      togglePrefix(cm, "quote", false, true);
      setHeading(cm, value === "body" ? 0 : Number(value.slice(1)));
    } else if (kind === "list") {
      if (value === "none") return stripListPrefix(cm);
      togglePrefix(cm, { bullet: "bullets", number: "numbers", task: "tasks" }[value], true);
    }
  });
}

/** Font, size or colour for the text selected on the page (stored as `<span style>`). */
function textStyle(props) {
  if (state.focus !== "page" || !page.applyTextStyle(props)) toast("Select some text on the page first");
}

function clearTextStyle() {
  if (state.focus === "page") {
    if (!page.clearTextStyle()) toast("No text style to remove here");
    return;
  }
  const text = mdEditor.getSelection();
  const cleaned = text.replace(/<span style="[^"]*">([\s\S]*?)<\/span>/g, "$1");
  if (cleaned !== text) mdEditor.replaceSelection(cleaned, "around");
  mdEditor.focus();
}

function formatText(cmd) {
  if (state.focus === "page") {
    if (cmd === "link") {
      const current = page.linkAtCaret();
      if (current == null && !page.hasTextSelection()) return insertAction("link");
      const url = prompt(current != null ? "Link address (leave empty to remove the link):" : "Link address:", current ?? "https://");
      if (url === null) return;
      if (!url.trim()) page.format("unlink");
      else page.format("link", url.trim());
      return;
    }
    page.format(cmd === "strike" ? "strikeThrough" : cmd);
    return;
  }
  const wraps = { bold: ["**", "bold text"], italic: ["*", "italic text"], strike: ["~~", "struck text"], mark: ["==", "highlighted"], code: ["`", "code"] };
  if (cmd === "link") {
    const text = mdEditor.getSelection() || "link text";
    const url = prompt("Link address:", "https://");
    if (url) mdEditor.replaceSelection(`[${text}](${url})`);
  } else {
    const [d, ph] = wraps[cmd];
    wrap(mdEditor, d, d, ph);
  }
  mdEditor.focus();
}

function wrap(cm, before, after, placeholder) {
  if (!cm.somethingSelected()) {
    const cur = cm.getCursor();
    cm.replaceRange(before + placeholder + after, cur);
    cm.setSelection({ line: cur.line, ch: cur.ch + before.length }, { line: cur.line, ch: cur.ch + before.length + placeholder.length });
    return;
  }
  const from = cm.getCursor("from");
  const to = cm.getCursor("to");
  const outerFrom = { line: from.line, ch: Math.max(0, from.ch - before.length) };
  const outerTo = { line: to.line, ch: to.ch + after.length };
  if (cm.getRange(outerFrom, from) === before && cm.getRange(to, outerTo) === after) {
    cm.replaceRange(cm.getSelection(), outerFrom, outerTo);
    return;
  }
  cm.replaceSelection(before + cm.getSelection() + after, "around");
}

function selectedLines(cm) {
  const from = cm.getCursor("from").line;
  let to = cm.getCursor("to").line;
  if (to > from && cm.getCursor("to").ch === 0) to--;
  // Expand to the whole paragraph when nothing is selected.
  if (!cm.somethingSelected()) {
    let a = from;
    let b = to;
    const plain = (l) => cm.getLine(l)?.trim() && !/^\s*([-+*]|\d+[.)]|#{1,6})\s/.test(cm.getLine(l));
    if (plain(from)) {
      while (a > 0 && plain(a - 1)) a--;
      while (b < cm.lastLine() && plain(b + 1)) b++;
    }
    return [a, b];
  }
  return [from, to];
}

const LIST_RE = /^(\s*)(?:[-+*]\s+\[[ xX]\]\s+|[-+*]\s+|\d+[.)]\s+)/;

function togglePrefix(cm, kind, force = null, removeOnly = false) {
  const [from, to] = selectedLines(cm);
  const patterns = {
    bullets: /^(\s*)[-+*]\s+(?!\[[ xX]\])/,
    numbers: /^(\s*)\d+[.)]\s+/,
    tasks: /^(\s*)[-+*]\s+\[[ xX]\]\s+/,
    quote: /^(\s*)>\s?/,
  };
  const re = patterns[kind];
  const lines = [];
  for (let l = from; l <= to; l++) lines.push(cm.getLine(l));
  const allHave = lines.every((line) => !line.trim() || re.test(line));
  const remove = removeOnly || (force === null ? allHave : !force && allHave);
  if (force === true && allHave) return;
  if (removeOnly && !allHave) return;
  cm.operation(() => {
    let n = 0;
    lines.forEach((line, idx) => {
      const l = from + idx;
      let updated;
      if (remove) updated = line.replace(re, "$1");
      else if (!line.trim()) return;
      else {
        const stripped = kind === "quote" ? line : line.replace(LIST_RE, "$1").replace(/^(\s*)#{1,6}\s+/, "$1");
        const indent = stripped.match(/^\s*/)[0];
        const prefix = kind === "bullets" ? "- " : kind === "numbers" ? `${++n}. ` : kind === "tasks" ? "- [ ] " : "> ";
        updated = indent + prefix + stripped.slice(indent.length);
      }
      cm.replaceRange(updated, { line: l, ch: 0 }, { line: l, ch: line.length });
    });
  });
}

function stripListPrefix(cm) {
  const [from, to] = selectedLines(cm);
  cm.operation(() => {
    for (let l = from; l <= to; l++) {
      const line = cm.getLine(l);
      cm.replaceRange(line.replace(LIST_RE, "$1").replace(/^\s+/, ""), { line: l, ch: 0 }, { line: l, ch: line.length });
    }
  });
}

function setHeading(cm, level) {
  const [from, to] = selectedLines(cm);
  cm.operation(() => {
    const cursor = cm.getCursor();
    let delta = 0;
    for (let l = from; l <= to; l++) {
      const line = cm.getLine(l);
      const text = line.replace(/^\s*#{1,6}\s+/, "").replace(LIST_RE, "");
      const updated = level > 0 ? `${"#".repeat(level)} ${text}` : text;
      if (l === cursor.line) delta = updated.length - line.length;
      cm.replaceRange(updated, { line: l, ch: 0 }, { line: l, ch: line.length });
    }
    cm.setCursor({ line: cursor.line, ch: Math.max(level ? level + 1 : 0, cursor.ch + delta) });
  });
  if (from !== to) {
    // Headings are one line each; join a multi-line paragraph.
    const joined = [];
    for (let l = from; l <= to; l++) joined.push(cm.getLine(l).replace(/^#{1,6}\s+/, ""));
    if (level > 0) cm.replaceRange(`${"#".repeat(level)} ${joined.join(" ")}`, { line: from, ch: 0 }, { line: to, ch: cm.getLine(to).length });
  }
}

function wrapCodeBlock(cm) {
  const [from, to] = selectedLines(cm);
  const lines = [];
  for (let l = from; l <= to; l++) lines.push(cm.getLine(l));
  if (/^```/.test(lines[0] || "")) return;
  cm.replaceRange("```\n" + lines.join("\n") + "\n```", { line: from, ch: 0 }, { line: to, ch: cm.getLine(to).length });
  cm.setCursor({ line: from + 1, ch: 0 });
}

/** Insert Markdown into the source editor at its cursor. */
function insertIntoSource(text, block, selectOffset = null) {
  const cm = mdEditor;
  if (!block) {
    cm.replaceSelection(text);
    return;
  }
  const cur = cm.getCursor("to");
  const line = cm.getLine(cur.line);
  let prefix = "";
  let pos = cur;
  if (line.trim()) {
    pos = { line: cur.line, ch: line.length };
    prefix = "\n\n";
  } else if (cur.line > 0 && cm.getLine(cur.line - 1).trim()) prefix = "\n";
  const next = cm.getLine(pos.line + 1);
  const suffix = next !== undefined && next.trim() ? "\n\n" : "\n";
  cm.replaceRange(prefix + text + suffix, pos);
  const start = cm.indexFromPos(pos) + prefix.length;
  if (selectOffset) cm.setSelection(cm.posFromIndex(start + selectOffset[0]), cm.posFromIndex(start + selectOffset[1]));
  else cm.setCursor(cm.posFromIndex(start + text.length));
}

/** Insert a snippet at the caret on whichever side is active. */
function insertSnippet(text, { block = false, select = null } = {}) {
  if (state.proof) setProof(false);
  if (state.focus === "page" && page.insertMarkdown(text, { block, caretOffset: select ? select[1] : null })) return;
  insertIntoSource(text, block, select);
  mdEditor.focus();
}

function insertAction(id) {
  switch (id) {
    case "pagebreak":
      return insertSnippet("\\pagebreak", { block: true });
    case "toc":
      return insertSnippet("[TOC]", { block: true });
    case "hr":
      return insertSnippet("---", { block: true });
    case "codeblock": {
      const lang = prompt("Language for syntax highlighting (e.g. python, rust, bash), or leave empty:", "") ?? "";
      const text = "```" + lang + "\ncode\n```";
      return insertSnippet(text, { block: true, select: [lang.length + 4, lang.length + 8] });
    }
    case "quote":
      return insertSnippet("> Quote", { block: true, select: [2, 7] });
    case "tasks":
      return insertSnippet("- [ ] Task", { block: true, select: [6, 10] });
    case "link": {
      const url = prompt("Link address:", "https://");
      if (!url) return;
      const text = prompt("Link text:", url) || url;
      return insertSnippet(`[${text}](${url})`);
    }
    case "footnote": {
      const existing = [...mdEditor.getValue().matchAll(/\[\^(\d+)\]/g)].map((m) => Number(m[1]));
      const n = existing.length ? Math.max(...existing) + 1 : 1;
      const def = `[^${n}]: Footnote text.`;
      const last = mdEditor.lastLine();
      const sep = mdEditor.getLine(last).trim() ? "\n\n" : "";
      fromPage = state.focus === "page";
      mdEditor.replaceRange(sep + def, { line: last, ch: mdEditor.getLine(last).length });
      fromPage = false;
      return insertSnippet(`[^${n}]`);
    }
  }
}

function insertTable(cols, rows) {
  const header = "| " + Array.from({ length: cols }, (_, i) => `Heading ${i + 1}`).join(" | ") + " |";
  const sep = "|" + " --- |".repeat(cols);
  const row = "| " + Array.from({ length: cols }, () => " ").join(" | ") + " |";
  insertSnippet([header, sep, ...Array.from({ length: rows - 1 }, () => row)].join("\n"), { block: true });
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

function pickImages(callback) {
  const input = $("#upload-image");
  input.onchange = () => {
    const files = [...input.files];
    input.value = "";
    if (files.length) callback(files);
  };
  input.click();
}

async function uploadImages(files) {
  const snippets = [];
  for (const file of files) {
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const result = await api("/api/upload", {
        method: "POST",
        body: { directory: state.baseDir, filename: file.name, data },
      });
      const alt = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
      snippets.push(`![${alt}](${result.relative}){width=60%}`);
      toast(`Added ${result.path}`);
    } catch (err) {
      toast(`Could not add ${file.name}: ${err.message}`, true);
    }
  }
  return snippets;
}

async function insertImages(files) {
  const snippets = await uploadImages(files);
  if (snippets.length) insertSnippet(snippets.join("\n\n"), { block: true });
}

async function replaceSelectedImage(file) {
  const [snippet] = await uploadImages([file]);
  if (!snippet) return;
  const src = snippet.match(/\]\(([^)]+)\)/)[1];
  page.updateSelectedImage((img) => (img.src = src));
}

// ---------------------------------------------------------------------------
// Jumping between source and page
// ---------------------------------------------------------------------------

function goToPage() {
  const index = mdEditor.indexFromPos(mdEditor.getCursor());
  if (state.proof) {
    const line = mdEditor.getLine(mdEditor.getCursor().line);
    const snippet = plainLine(line) || plainLine(mdEditor.getLine(mdEditor.getCursor().line + 1) || "");
    proof.revealText(snippet).then((ok) => !ok && toast("Couldn't find that text in the PDF"));
    return;
  }
  state.focus = "page";
  page.revealSource(index);
}

function goToSource() {
  let index = null;
  if (state.proof) {
    const text = proof.lastClickedText;
    if (!text) return toast("Click on the PDF first");
    index = findInSource(text);
    if (index == null) return toast("Couldn't find that text in the source");
  } else {
    index = page.caretSourceIndex();
    if (index == null) return toast("Click in the document first");
  }
  if (state.sourceHidden) toggleSource(true);
  showEditor("markdown");
  const pos = mdEditor.posFromIndex(index);
  mdEditor.setCursor(pos);
  mdEditor.scrollIntoView(pos, mdEditor.getScrollInfo().clientHeight / 3);
  mdEditor.focus();
  const handle = mdEditor.addLineClass(pos.line, "background", "cm-flash");
  setTimeout(() => mdEditor.removeLineClass(handle, "background", "cm-flash"), 1200);
}

function findInSource(text) {
  const needle = text.replace(/\s+/g, " ").trim().slice(0, 40);
  if (!needle) return null;
  for (let l = 0; l <= mdEditor.lastLine(); l++) {
    const plain = plainLine(mdEditor.getLine(l));
    const pos = plain.indexOf(needle.slice(0, Math.min(needle.length, 24)));
    if (pos >= 0) return mdEditor.indexFromPos({ line: l, ch: 0 });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Toolbar, popovers, layout
// ---------------------------------------------------------------------------

function setupToolbar() {
  $("#proof-toggle").addEventListener("click", () => setProof(!state.proof));
  $("#proof-exit").addEventListener("click", () => setProof(false));
  $("#show-format").addEventListener("click", () =>
    inspector.mode === "format" && !state.inspectorHidden ? toggleInspector(false) : setInspectorMode("format"),
  );
  $("#show-document").addEventListener("click", () =>
    inspector.mode === "document" && !state.inspectorHidden ? toggleInspector(false) : setInspectorMode("document"),
  );
  $("#go-page").addEventListener("click", goToPage);
  $("#go-source").addEventListener("click", goToSource);
  $("#go-page").addEventListener("mousedown", (e) => e.preventDefault());
  $("#go-source").addEventListener("mousedown", (e) => e.preventDefault());

  $("#doc-name").addEventListener("change", (e) => {
    state.docName = e.target.value.trim() || "document";
    updateFileInfo();
  });

  $("#upload-md").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) loadMarkdownFile(file);
  });
  $("#upload-css").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setCss(await file.text());
    toast(`Loaded theme ${file.name}`);
  });
}

function applyLayout() {
  if (store.get("sourceHidden") === "1") toggleSource(false);
  if (store.get("inspectorHidden") === "1") toggleInspector(false);
  const split = Number(store.get("split", 38));
  $("#source-pane").style.flexBasis = `${split}%`;
}

function toggleSource(show = !!state.sourceHidden) {
  state.sourceHidden = !show;
  $("#source-pane").hidden = !show;
  $("#sync-rail").hidden = !show;
  store.set("sourceHidden", show ? null : "1");
  if (show) mdEditor.refresh();
  syncViewChecks();
}

function toggleInspector(show = !!state.inspectorHidden) {
  state.inspectorHidden = !show;
  $("#inspector").hidden = !show;
  if (show) inspector?.refresh();
  store.set("inspectorHidden", show ? null : "1");
  $("#show-format").classList.toggle("on", show && inspector.mode === "format");
  $("#show-document").classList.toggle("on", show && inspector.mode === "document");
  syncViewChecks();
}

function syncViewChecks() {
  const checks = { source: !state.sourceHidden, inspector: !state.inspectorHidden, proof: state.proof };
  for (const el of $$("[data-check]")) el.classList.toggle("on", !!checks[el.dataset.check]);
}

function updateZoomLabel() {
  $("#zoom-value").textContent = page.zoom === "fit" ? "Fit" : `${page.zoom}%`;
}

let openPopover = null;

function closePopover() {
  if (!openPopover) return;
  openPopover.pop.hidden = true;
  openPopover.button.classList.remove("open");
  openPopover = null;
}

function setupPopovers() {
  for (const button of $$("[data-popover]")) {
    button.addEventListener("mousedown", (e) => e.preventDefault());
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      const pop = $(`#${button.dataset.popover}`);
      if (openPopover?.pop === pop) return closePopover();
      closePopover();
      pop.hidden = false;
      const rect = button.getBoundingClientRect();
      const width = pop.offsetWidth;
      const left = Math.min(window.innerWidth - width - 8, Math.max(8, rect.left + rect.width / 2 - width / 2));
      pop.style.left = `${left}px`;
      pop.style.top = `${rect.bottom + 6}px`;
      button.classList.add("open");
      openPopover = { pop, button };
      if (pop.id === "title-menu") $("#doc-name").select();
    });
  }
  document.addEventListener("mousedown", (e) => {
    if (openPopover && !openPopover.pop.contains(e.target) && !openPopover.button.contains(e.target)) closePopover();
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && closePopover());

  for (const pop of $$(".popover")) {
    pop.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) e.preventDefault(); // keep the caret where it is
    });
    pop.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.cmd) command(b.dataset.cmd);
      else if (b.dataset.insert) insertAction(b.dataset.insert);
      else if (b.dataset.zoom) {
        page.setZoom(b.dataset.zoom);
        proof.setZoom(b.dataset.zoom);
        store.set("zoom", b.dataset.zoom);
        updateZoomLabel();
      } else return;
      closePopover();
    });
  }

  // Table size picker
  const picker = $("#table-picker");
  const label = $("#table-picker-label");
  const cells = [];
  for (let r = 1; r <= 8; r++) {
    for (let c = 1; c <= 8; c++) {
      const cell = document.createElement("span");
      cell.dataset.r = r;
      cell.dataset.c = c;
      picker.append(cell);
      cells.push(cell);
    }
  }
  picker.addEventListener("mouseover", (e) => {
    const t = e.target.closest("span");
    if (!t) return;
    for (const cell of cells) cell.classList.toggle("on", cell.dataset.r <= +t.dataset.r && cell.dataset.c <= +t.dataset.c);
    label.textContent = `${t.dataset.c} × ${t.dataset.r} table`;
  });
  picker.addEventListener("mousedown", (e) => e.preventDefault());
  picker.addEventListener("click", (e) => {
    const t = e.target.closest("span");
    if (!t) return;
    closePopover();
    insertTable(Number(t.dataset.c), Number(t.dataset.r));
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function loadMarkdownFile(file) {
  if (state.dirty && state.filePath && !confirm("Discard unsaved changes?")) return;
  setMarkdown(await file.text());
  state.filePath = null;
  state.docName = stripExt(file.name);
  updateFileInfo();
  toast(`Opened ${file.name}. Relative images resolve from ${state.baseDir}`);
}

async function command(cmd) {
  try {
    switch (cmd) {
      case "new":
        if (state.dirty && state.filePath && !confirm("Discard unsaved changes?")) return;
        state.filePath = null;
        state.docName = "Untitled";
        updateFileInfo();
        setMarkdown("# Untitled\n\n");
        break;
      case "upload":
        $("#upload-md").click();
        break;
      case "open-disk": {
        const picked = await pickFile("Open Markdown file", "md,markdown,mdown,txt");
        if (!picked) return;
        const file = await api("/api/open", { method: "POST", body: { path: picked } });
        if (state.dirty && state.filePath && !confirm("Discard unsaved changes?")) return;
        state.filePath = file.path;
        state.baseDir = file.directory;
        state.docName = stripExt(file.name);
        rememberDir(file.directory);
        updateFileInfo();
        if (file.theme != null && file.theme !== state.css && confirm(`This folder has a theme (${basename(file.theme_path)}). Use it?`)) {
          setCss(file.theme);
        }
        setMarkdown(file.content);
        break;
      }
      case "save-md":
        if (state.filePath) {
          await saveFile("markdown", dirname(state.filePath), basename(state.filePath), { overwrite: true });
          setDirty(false);
          toast(`Saved ${state.filePath}`);
        } else await command("save-md-as");
        break;
      case "save-md-as": {
        const path = await saveWithPicker("markdown", "Save Markdown", `${state.docName}.md`);
        if (path) {
          state.filePath = path;
          state.baseDir = dirname(path);
          state.docName = stripExt(basename(path));
          updateFileInfo();
          setDirty(false);
          page.render();
        }
        break;
      }
      case "download-md":
        download(new Blob([state.markdown], { type: "text/markdown" }), `${state.docName}.md`);
        break;
      case "upload-css":
        $("#upload-css").click();
        break;
      case "open-css-disk": {
        const picked = await pickFile("Open theme CSS", "css");
        if (!picked) return;
        const file = await api("/api/open", { method: "POST", body: { path: picked } });
        setCss(file.content);
        toast(`Loaded theme ${file.name}`);
        break;
      }
      case "save-css":
        await saveWithPicker("css", "Save Theme", "easymarkdoc.css", {
          hint: "A theme named easymarkdoc.css next to a document is used automatically by the command line and VS Code.",
          defaultDir: state.baseDir,
        });
        break;
      case "download-css":
        download(new Blob([state.css], { type: "text/css" }), "easymarkdoc.css");
        break;
      case "reset-css":
        if (confirm("Remove all theme customisations and return to the default theme?")) setCss("");
        break;
      case "show-css":
        showEditor("css");
        break;
      case "toggle-source":
        toggleSource();
        break;
      case "toggle-inspector":
        toggleInspector();
        break;
      case "toggle-proof":
        setProof(!state.proof);
        break;
      case "image-file":
        pickImages(insertImages);
        break;
      case "image-url": {
        const url = prompt("Image web address:", "https://");
        if (url) insertSnippet(`![image](${url}){width=60%}`, { block: true });
        break;
      }
      case "save-pdf":
        await saveWithPicker("pdf", "Export PDF", `${state.docName}.pdf`);
        break;
      case "download-pdf":
        download(await renderPdfBlob(), `${state.docName}.pdf`);
        break;
      case "print-pdf": {
        const url = URL.createObjectURL(await renderPdfBlob());
        window.open(url, "_blank");
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        break;
      }
      case "save-html":
        await saveWithPicker("html", "Export HTML", `${state.docName}.html`);
        break;
    }
  } catch (err) {
    toast(err.message, true);
  }
}

async function renderPdfBlob() {
  toast("Rendering PDF…");
  const response = await api("/api/render", {
    method: "POST",
    raw: true,
    body: { markdown: state.markdown, css: state.css || null, base_dir: state.baseDir, format: "pdf" },
  });
  return new Blob([await response.arrayBuffer()], { type: "application/pdf" });
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function saveFile(kind, directory, filename, { overwrite = false } = {}) {
  return api("/api/save", {
    method: "POST",
    body: { kind, directory, filename, overwrite, markdown: state.markdown, css: state.css || null, base_dir: state.baseDir },
  });
}

async function saveWithPicker(kind, title, filename, options = {}) {
  const picked = await openPicker({ title, mode: "save", filename, hint: options.hint, startDir: options.defaultDir });
  if (!picked) return null;
  if (kind === "pdf") toast("Rendering PDF…");
  let result;
  try {
    result = await saveFile(kind, picked.dir, picked.name);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      if (!confirm(`${err.message}. Replace it?`)) return null;
      result = await saveFile(kind, picked.dir, picked.name, { overwrite: true });
    } else throw err;
  }
  rememberDir(picked.dir);
  toast(`Saved ${result.path}`);
  return result.path;
}

function rememberDir(dir) {
  state.lastDir = dir;
  store.set("lastDir", dir);
}

// ---------------------------------------------------------------------------
// Folder / file picker (server-side, so we get real paths)
// ---------------------------------------------------------------------------

let pickerState = null;

function setupPicker() {
  const dialog = $("#picker");
  $("#picker-up").addEventListener("click", () => pickerState?.parent && browse(pickerState.parent));
  $("#picker-home").addEventListener("click", () => pickerState?.home && browse(pickerState.home));
  $("#picker-go").addEventListener("click", () => browse($("#picker-path").value));
  $("#picker-path").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      browse($("#picker-path").value);
    }
  });
  $("#picker-cancel").addEventListener("click", () => dialog.close("cancel"));
  dialog.addEventListener("close", () => {
    const resolve = pickerState?.resolve;
    const result = dialog.returnValue === "ok" ? pickerState.result() : null;
    pickerState = null;
    resolve?.(result);
  });
  $("#picker-ok").addEventListener("click", (e) => {
    e.preventDefault();
    if (pickerState?.mode === "save" && !$("#picker-name").value.trim()) return $("#picker-name").focus();
    if (pickerState?.mode === "open" && !pickerState.selected) return;
    dialog.close("ok");
  });
}

async function browse(path) {
  const err = $("#picker-error");
  try {
    const params = new URLSearchParams({ path: path || "" });
    if (pickerState.extensions) params.set("files", pickerState.extensions);
    const data = await api(`/api/browse?${params}`);
    if (!pickerState.hint) err.hidden = true;
    Object.assign(pickerState, { path: data.path, parent: data.parent, home: data.home, selected: null });
    $("#picker-path").value = data.path;
    const list = $("#picker-list");
    list.replaceChildren();
    for (const dir of data.dirs) {
      const li = document.createElement("li");
      li.className = "dir";
      li.textContent = dir;
      li.addEventListener("dblclick", () => browse(joinPath(data.path, dir)));
      li.addEventListener("click", () => browse(joinPath(data.path, dir)));
      list.append(li);
    }
    for (const file of data.files) {
      const li = document.createElement("li");
      li.className = "file";
      li.textContent = file;
      li.addEventListener("click", () => {
        list.querySelectorAll(".selected").forEach((x) => x.classList.remove("selected"));
        li.classList.add("selected");
        pickerState.selected = joinPath(data.path, file);
      });
      li.addEventListener("dblclick", () => {
        pickerState.selected = joinPath(data.path, file);
        $("#picker").close("ok");
      });
      list.append(li);
    }
    if (!data.dirs.length && !data.files.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "(empty folder)";
      list.append(li);
    }
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove("hint");
    err.hidden = false;
  }
}

function openPicker({ title, mode, filename = "", extensions = null, startDir, hint }) {
  return new Promise((resolve) => {
    pickerState = {
      mode,
      extensions,
      hint,
      resolve,
      result: () => (mode === "save" ? { dir: pickerState.path, name: $("#picker-name").value.trim() } : pickerState.selected),
    };
    $("#picker-title").textContent = title;
    $("#picker-name-row").hidden = mode !== "save";
    $("#picker-name").value = filename;
    $("#picker-ok").textContent = mode === "save" ? "Save" : "Open";
    const err = $("#picker-error");
    err.hidden = !hint;
    err.classList.toggle("hint", !!hint);
    err.textContent = hint || "";
    $("#picker").returnValue = "";
    $("#picker").showModal();
    browse(startDir || state.lastDir || state.outputDir);
    if (mode === "save") {
      const input = $("#picker-name");
      input.focus();
      const dot = filename.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : filename.length);
    }
  });
}

function pickFile(title, extensions) {
  return openPicker({ title, mode: "open", extensions, startDir: state.filePath ? state.baseDir : undefined });
}

// ---------------------------------------------------------------------------
// Layout, shortcuts, drag and drop, notifications
// ---------------------------------------------------------------------------

function setupSplitter() {
  const splitter = $("#splitter");
  const pane = $("#source-pane");
  const workspace = $("#workspace");
  const apply = (pct) => {
    pct = Math.min(70, Math.max(15, pct));
    pane.style.flexBasis = `${pct}%`;
    return pct;
  };
  splitter.addEventListener("pointerdown", (e) => {
    splitter.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const move = (ev) => {
      const rect = workspace.getBoundingClientRect();
      store.set("split", apply(((ev.clientX - rect.left) / rect.width) * 100));
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener(
      "pointerup",
      () => {
        splitter.removeEventListener("pointermove", move);
        document.body.classList.remove("resizing");
        mdEditor.refresh();
        cssEditor.refresh();
      },
      { once: true },
    );
  });
  splitter.addEventListener("keydown", (e) => {
    const current = parseFloat(pane.style.flexBasis) || 38;
    if (e.key === "ArrowLeft") store.set("split", apply(current - 2));
    if (e.key === "ArrowRight") store.set("split", apply(current + 2));
  });
}

/** Keyboard shortcuts shared by the app and the page iframe. */
function handleShortcut(e, origin = "app") {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return false;
  const key = e.key.toLowerCase();
  if (e.altKey && e.key === "ArrowRight") return goToPage(), true;
  if (e.altKey && e.key === "ArrowLeft") return goToSource(), true;
  if (key === "s" && e.shiftKey) return command("save-pdf"), true;
  if (key === "s") return command("save-md"), true;
  if (key === "o") return command("open-disk"), true;
  if (key === "p") return command("print-pdf"), true;
  if (origin === "page") {
    if ((key === "z" && e.shiftKey) || key === "y") return undoRedo("redo"), true;
    if (key === "z") return undoRedo("undo"), true;
    if (key === "k") return formatText("link"), true;
    if (e.altKey && ["0", "1", "2", "3"].includes(e.key)) {
      paragraphAction("style", e.key === "0" ? "body" : `h${e.key}`);
      return true;
    }
  }
  return false;
}

function undoRedo(which) {
  fromPage = true;
  mdEditor[which]();
  fromPage = false;
  page.render({ caret: mdEditor.indexFromPos(mdEditor.getCursor()), focus: true });
}

function setupShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (handleShortcut(e)) e.preventDefault();
  });
}

function openDroppedFiles(files) {
  const file = files[0];
  if (!file) return;
  if (/\.css$/i.test(file.name)) {
    file.text().then((css) => {
      setCss(css);
      toast(`Loaded theme ${file.name}`);
    });
  } else if (/\.(md|markdown|mdown|txt)$/i.test(file.name)) {
    loadMarkdownFile(file);
  }
}

function setupDragAndDrop() {
  const target = document.body;
  target.addEventListener("dragover", (e) => {
    if ([...e.dataTransfer.items].some((i) => i.kind === "file")) {
      e.preventDefault();
      target.classList.add("dragging");
    } else if (!e.target.closest?.("input, textarea, .CodeMirror")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "none";
    }
  });
  window.addEventListener("dragend", () => target.classList.remove("dragging"));
  target.addEventListener("dragleave", (e) => {
    if (e.target === target || !target.contains(e.relatedTarget)) target.classList.remove("dragging");
  });
  target.addEventListener("drop", async (e) => {
    target.classList.remove("dragging");
    const files = [...e.dataTransfer.files];
    if (!files.length) {
      // Text or a link dropped outside a text field would make the browser
      // navigate away from the editor.
      if (!e.target.closest?.("input, textarea, .CodeMirror")) e.preventDefault();
      return;
    }
    e.preventDefault();
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length) {
      state.focus = "source";
      insertImages(images);
    } else openDroppedFiles(files);
  });
}

let toastTimer;
function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 7000 : 3500);
}

init();
