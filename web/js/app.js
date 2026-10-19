// EasyMarkDoc web editor.

import { api, ApiError } from "./api.js";
import { parseVars, setVar, removeVar } from "./cssvars.js";
import { Preview } from "./preview.js";
import { Ribbon } from "./ribbon.js";

const $ = (sel) => document.querySelector(sel);
const store = {
  get: (k, d = null) => localStorage.getItem(`emd.${k}`) ?? d,
  set: (k, v) => (v == null ? localStorage.removeItem(`emd.${k}`) : localStorage.setItem(`emd.${k}`, v)),
};

const WELCOME = `# Welcome to EasyMarkDoc

Write **Markdown** on the left and see the finished PDF on the right. Use the
ribbon above to change how the document looks: every setting is stored in the
theme's CSS, which you can save and reuse.

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
> Use the **Design** tab to try a different style set.

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

\\pagebreak

## A new page

Insert \`\\pagebreak\` (Insert → Page break) to start a new page.

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
};

let mdEditor;
let cssEditor;
let preview;
let ribbon;
let suppressCssChange = false;

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function init() {
  let server;
  try {
    server = await api("/api/state");
  } catch (err) {
    document.body.innerHTML = `<p style="padding:2em;font-family:sans-serif">Could not connect to the EasyMarkDoc server: ${err.message}</p>`;
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

  setupEditors();
  setupPreview();
  ribbon = new Ribbon({
    tabsEl: $("#ribbon-tabs"),
    panelEl: $("#ribbon-panels"),
    getVar: effectiveVar,
    setVars: applyVarChanges,
    runAction,
    codeThemes: server.code_themes,
  });
  ribbon.sync();
  setupMenus();
  setupSplitter();
  setupShortcuts();
  setupPicker();
  setupDragAndDrop();

  $("#doc-name").value = state.docName;
  $("#doc-name").addEventListener("change", (e) => {
    state.docName = e.target.value.trim() || "document";
    e.target.value = state.docName;
    store.set("docName", state.docName);
  });

  updateFileInfo();
  updateWordCount();
  renderPreview(true);

  window.addEventListener("beforeunload", (e) => {
    if (state.dirty && state.filePath) e.preventDefault();
  });
}

function effectiveVar(name) {
  const user = parseVars(state.css);
  return user.get(name) ?? state.defaultVars.get(name) ?? "";
}

function stripExt(name) {
  return name.replace(/\.(md|markdown|mdown|txt)$/i, "");
}

function dirname(path) {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : path;
}

function basename(path) {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(i + 1);
}

function joinPath(dir, name) {
  return dir.endsWith("/") || dir.endsWith("\\") ? dir + name : dir + state.separator + name;
}

// ---------------------------------------------------------------------------
// Editors
// ---------------------------------------------------------------------------

function setupEditors() {
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "Cmd" : "Ctrl";
  mdEditor = CodeMirror($("#markdown-editor"), {
    value: state.markdown,
    mode: { name: "gfm", highlightFormatting: true },
    lineWrapping: true,
    lineNumbers: false,
    indentUnit: 4,
    tabSize: 4,
    placeholder: "Start writing Markdown…",
    allowDropFileTypes: ["application/x-none"], // dropped files are opened, not inserted
    extraKeys: {
      Enter: "newlineAndIndentContinueMarkdownList",
      Tab: (cm) => (cm.somethingSelected() ? cm.indentSelection("add") : cm.replaceSelection("    ")),
      "Shift-Tab": (cm) => cm.indentSelection("subtract"),
      [`${mod}-B`]: () => runAction("bold"),
      [`${mod}-I`]: () => runAction("italic"),
      [`${mod}-K`]: () => runAction("link"),
      [`${mod}-Alt-1`]: () => runAction("style", "1"),
      [`${mod}-Alt-2`]: () => runAction("style", "2"),
      [`${mod}-Alt-3`]: () => runAction("style", "3"),
      [`${mod}-Alt-0`]: () => runAction("style", "0"),
    },
  });
  mdEditor.on("change", () => {
    state.markdown = mdEditor.getValue();
    store.set("markdown", state.markdown);
    setDirty(true);
    updateWordCount();
    renderPreview();
  });

  cssEditor = CodeMirror($("#css-editor"), {
    value: state.css,
    mode: "css",
    lineNumbers: true,
    allowDropFileTypes: ["application/x-none"],
    indentUnit: 4,
    tabSize: 4,
    placeholder: "/* Custom theme: layered on top of the default theme.\n   Use the ribbon to add settings, or write any CSS here. */",
  });
  let cssTimer;
  cssEditor.on("change", () => {
    if (suppressCssChange) return;
    clearTimeout(cssTimer);
    cssTimer = setTimeout(() => {
      state.css = cssEditor.getValue();
      store.set("css", state.css);
      ribbon.sync();
      renderPreview();
    }, 300);
  });

  for (const tab of document.querySelectorAll(".pane-tab")) {
    tab.addEventListener("click", () => showEditor(tab.dataset.editor));
  }
}

function showEditor(which) {
  for (const tab of document.querySelectorAll(".pane-tab")) {
    tab.classList.toggle("active", tab.dataset.editor === which);
  }
  $("#markdown-editor").hidden = which !== "markdown";
  $("#css-editor").hidden = which !== "css";
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
}

function setCss(css) {
  state.css = css;
  store.set("css", css);
  suppressCssChange = true;
  const scroll = cssEditor.getScrollInfo();
  const cursor = cssEditor.getCursor();
  cssEditor.setValue(css);
  cssEditor.setCursor(cursor);
  cssEditor.scrollTo(scroll.left, scroll.top);
  suppressCssChange = false;
  ribbon?.sync();
  renderPreview();
}

function applyVarChanges(changes) {
  let css = state.css;
  for (const [name, value] of Object.entries(changes)) {
    css = value == null ? removeVar(css, name) : setVar(css, name, value);
  }
  setCss(css);
}

function setDirty(dirty) {
  state.dirty = dirty;
  $("#dirty").hidden = !dirty || !state.filePath;
}

function updateFileInfo() {
  // LRM marks keep the path's slashes in place despite the rtl truncation.
  $("#file-path").textContent = state.filePath ? `\u200E${state.filePath}\u200E` : "Not saved to disk";
  $("#file-path").title = `${state.filePath || "Unsaved document"}\nImages resolve relative to ${state.baseDir}`;
  store.set("filePath", state.filePath);
  store.set("baseDir", state.filePath ? state.baseDir : null);
  $("#doc-name").value = state.docName;
  store.set("docName", state.docName);
  setDirty(state.dirty);
}

function updateWordCount() {
  const text = state.markdown.replace(/```[\s\S]*?```/g, " ").replace(/[#>*_`~\-|[\]()!]/g, " ");
  const words = text.split(/\s+/).filter(Boolean).length;
  $("#status-words").textContent = `${words.toLocaleString()} words`;
}

// ---------------------------------------------------------------------------
// Markdown formatting actions
// ---------------------------------------------------------------------------

function wrap(before, after = before, placeholder = "text") {
  const cm = mdEditor;
  if (!cm.somethingSelected()) {
    const cur = cm.getCursor();
    cm.replaceRange(before + placeholder + after, cur);
    cm.setSelection(
      { line: cur.line, ch: cur.ch + before.length },
      { line: cur.line, ch: cur.ch + before.length + placeholder.length },
    );
    return;
  }
  const from = cm.getCursor("from");
  const to = cm.getCursor("to");
  const selected = cm.getSelection();
  // Toggle off if the selection is already wrapped.
  const outerFrom = { line: from.line, ch: Math.max(0, from.ch - before.length) };
  const outerTo = { line: to.line, ch: to.ch + after.length };
  if (cm.getRange(outerFrom, from) === before && cm.getRange(to, outerTo) === after) {
    cm.replaceRange(selected, outerFrom, outerTo);
    cm.setSelection(outerFrom, { line: to.line, ch: to.ch - (from.line === to.line ? before.length : 0) });
    return;
  }
  if (selected.startsWith(before) && selected.endsWith(after) && selected.length >= before.length + after.length) {
    cm.replaceSelection(selected.slice(before.length, selected.length - after.length), "around");
    return;
  }
  cm.replaceSelection(before + selected + after, "around");
}

function selectedLines() {
  const cm = mdEditor;
  const from = cm.getCursor("from").line;
  let to = cm.getCursor("to").line;
  if (to > from && cm.getCursor("to").ch === 0) to--;
  return [from, to];
}

const LIST_PREFIX = /^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/;

function togglePrefix(kind) {
  const cm = mdEditor;
  const [from, to] = selectedLines();
  const prefixFor = (i) =>
    kind === "bullets" ? "- " : kind === "numbers" ? `${i + 1}. ` : kind === "tasks" ? "- [ ] " : "> ";
  const matches = {
    bullets: /^(\s*)[-*+]\s+(?!\[[ xX]\])/,
    numbers: /^(\s*)\d+[.)]\s+/,
    tasks: /^(\s*)[-*+]\s+\[[ xX]\]\s+/,
    quote: /^(\s*)>\s?/,
  }[kind];
  const lines = [];
  for (let l = from; l <= to; l++) lines.push(cm.getLine(l));
  const allHave = lines.every((line) => !line.trim() || matches.test(line));
  cm.operation(() => {
    let n = 0;
    lines.forEach((line, idx) => {
      const lineNo = from + idx;
      let updated;
      if (allHave) {
        updated = line.replace(matches, "$1");
      } else if (!line.trim()) {
        return;
      } else {
        const stripped = kind === "quote" ? line : line.replace(LIST_PREFIX, "$1");
        const indent = stripped.match(/^\s*/)[0];
        updated = indent + prefixFor(n++) + stripped.slice(indent.length);
      }
      cm.replaceRange(updated, { line: lineNo, ch: 0 }, { line: lineNo, ch: line.length });
    });
  });
  cm.focus();
}

function setHeading(level) {
  const cm = mdEditor;
  const [from, to] = selectedLines();
  cm.operation(() => {
    for (let l = from; l <= to; l++) {
      const line = cm.getLine(l);
      const text = line.replace(/^\s*#{1,6}\s+/, "");
      const updated = level > 0 ? `${"#".repeat(level)} ${text}` : text;
      cm.replaceRange(updated, { line: l, ch: 0 }, { line: l, ch: line.length });
    }
  });
  cm.focus();
}

/** Insert a block on its own, surrounded by blank lines. */
function insertBlock(text, selectOffset) {
  const cm = mdEditor;
  const cur = cm.getCursor("to");
  const line = cm.getLine(cur.line);
  let prefix = "";
  let pos = cur;
  if (line.trim()) {
    pos = { line: cur.line, ch: line.length };
    prefix = "\n\n";
  } else if (cur.line > 0 && cm.getLine(cur.line - 1).trim()) {
    prefix = "\n";
  }
  const next = cm.getLine(pos.line + 1);
  const suffix = next !== undefined && next.trim() ? "\n\n" : "\n";
  cm.replaceRange(prefix + text + suffix, pos);
  const start = cm.indexFromPos(pos) + prefix.length;
  if (selectOffset) {
    cm.setSelection(cm.posFromIndex(start + selectOffset[0]), cm.posFromIndex(start + selectOffset[1]));
  } else {
    cm.setCursor(cm.posFromIndex(start + text.length));
  }
  cm.focus();
}

function runAction(id, arg) {
  const cm = mdEditor;
  switch (id) {
    case "undo":
      cm.undo();
      break;
    case "redo":
      cm.redo();
      break;
    case "bold":
      wrap("**", "**", "bold text");
      break;
    case "italic":
      wrap("*", "*", "italic text");
      break;
    case "strike":
      wrap("~~", "~~", "struck text");
      break;
    case "highlight":
      wrap("==", "==", "highlighted");
      break;
    case "code":
      wrap("`", "`", "code");
      break;
    case "link": {
      const text = cm.getSelection() || "link text";
      const url = prompt("Link address (URL):", "https://");
      if (!url) return;
      cm.replaceSelection(`[${text}](${url})`);
      break;
    }
    case "image": {
      const url = prompt("Image path or URL (relative paths resolve from the document's folder):", "");
      if (!url) return;
      const caption = prompt("Caption (optional, shown under the image):", "") || "";
      const alt = cm.getSelection() || caption || "image";
      const title = caption ? ` "${caption.replace(/"/g, "'")}"` : "";
      insertBlock(`![${alt}](${url}${title})`);
      break;
    }
    case "style":
      setHeading(Number(arg));
      break;
    case "bullets":
    case "numbers":
    case "tasks":
    case "quote":
      togglePrefix(id);
      break;
    case "codeblock": {
      const selected = cm.getSelection();
      const lang = prompt("Language for syntax highlighting (e.g. python, rust, bash), or leave empty:", "") ?? "";
      if (selected) {
        cm.replaceSelection("```" + lang + "\n" + selected.replace(/\n$/, "") + "\n```");
      } else {
        const text = "```" + lang + "\ncode\n```";
        insertBlock(text, [lang.length + 4, lang.length + 8]);
      }
      break;
    }
    case "table": {
      const spec = prompt("Table size (columns x rows):", "3x3");
      if (!spec) return;
      const [cols, rows] = spec.split(/[x×*, ]+/).map((n) => Math.max(1, Math.min(20, parseInt(n, 10) || 3)));
      const header = "| " + Array.from({ length: cols }, (_, i) => `Heading ${i + 1}`).join(" | ") + " |";
      const sep = "|" + " --- |".repeat(cols);
      const row = "| " + Array.from({ length: cols }, () => "   ").join(" | ") + " |";
      insertBlock([header, sep, ...Array.from({ length: rows }, () => row)].join("\n"));
      break;
    }
    case "hr":
      insertBlock("---");
      break;
    case "pagebreak":
      insertBlock("\\pagebreak");
      break;
    case "toc":
      insertBlock("[TOC]");
      break;
    case "footnote": {
      const existing = [...cm.getValue().matchAll(/\[\^(\d+)\]/g)].map((m) => Number(m[1]));
      const n = existing.length ? Math.max(...existing) + 1 : 1;
      cm.replaceSelection(`[^${n}]`);
      const last = cm.lastLine();
      const def = `[^${n}]: Footnote text.`;
      const sep = cm.getLine(last).trim() ? "\n\n" : cm.getLine(last - 1)?.trim() ? "\n" : "";
      cm.replaceRange(sep + def, { line: last, ch: cm.getLine(last).length });
      const end = cm.lastLine();
      cm.setSelection({ line: end, ch: def.length - "Footnote text.".length }, { line: end, ch: def.length });
      cm.scrollIntoView(null, 100);
      break;
    }
  }
  cm.focus();
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function setupPreview() {
  const mode = store.get("mode", "pdf");
  const zoom = store.get("zoom", "fit");
  preview = new Preview($("#preview"), { mode, zoom, onStatus: showRenderStatus });

  const toggle = $("#mode-toggle");
  const syncToggle = () =>
    toggle.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.mode === preview.mode));
  toggle.addEventListener("click", (e) => {
    const mode = e.target.closest("button")?.dataset.mode;
    if (!mode) return;
    preview.setMode(mode);
    store.set("mode", mode);
    syncToggle();
  });
  syncToggle();

  $("#zoom").value = zoom;
  $("#zoom").addEventListener("change", (e) => {
    preview.setZoom(e.target.value);
    store.set("zoom", e.target.value);
  });
  $("#refresh").addEventListener("click", () => preview.refresh());
}

function renderPreview(immediate = false) {
  preview.update({ markdown: state.markdown, css: state.css, baseDir: state.baseDir }, { immediate });
}

let engineShown = false;
function showRenderStatus(status) {
  const el = $("#status-render");
  el.classList.toggle("error", status.state === "error");
  if (status.state === "rendering") {
    el.textContent = "Rendering…";
  } else if (status.state === "ok") {
    el.textContent = `Rendered in ${status.ms} ms`;
    $("#status-pages").textContent = `${status.pages} page${status.pages === 1 ? "" : "s"}`;
    if (!engineShown && preview.mode === "pdf") {
      engineShown = true;
      api("/api/state")
        .then((s) => {
          if (!s.browser) return;
          const name = basename(s.browser).replace(/\.exe$/, "");
          $("#status-engine").textContent = `Engine: ${name}`;
          $("#status-engine").title = s.browser;
        })
        .catch(() => {});
    }
  } else if (status.state === "error") {
    el.textContent = `Error: ${status.message}`;
  }
}

// ---------------------------------------------------------------------------
// Menus and commands
// ---------------------------------------------------------------------------

function setupMenus() {
  const closeAll = () => document.querySelectorAll(".menu-list").forEach((m) => (m.hidden = true));
  for (const menu of document.querySelectorAll(".menu")) {
    const button = menu.querySelector(".menu-button");
    const list = menu.querySelector(".menu-list");
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = list.hidden;
      closeAll();
      list.hidden = !open;
    });
    button.addEventListener("mouseenter", () => {
      if ([...document.querySelectorAll(".menu-list")].some((m) => !m.hidden)) {
        closeAll();
        list.hidden = false;
      }
    });
  }
  document.addEventListener("click", closeAll);
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeAll());

  document.addEventListener("click", (e) => {
    const cmd = e.target.closest("[data-cmd]")?.dataset.cmd;
    if (cmd) {
      closeAll();
      command(cmd);
    }
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
        setMarkdown("# Untitled\n\n");
        state.filePath = null;
        state.docName = "untitled";
        updateFileInfo();
        break;
      case "upload":
        $("#upload-md").click();
        break;
      case "open-disk": {
        const picked = await pickFile("Open Markdown file", "md,markdown,mdown,txt");
        if (!picked) return;
        const file = await api("/api/open", { method: "POST", body: { path: picked } });
        if (state.dirty && state.filePath && !confirm("Discard unsaved changes?")) return;
        setMarkdown(file.content);
        state.filePath = file.path;
        state.baseDir = file.directory;
        state.docName = stripExt(file.name);
        rememberDir(file.directory);
        updateFileInfo();
        if (file.theme != null && file.theme !== state.css) {
          if (confirm(`This folder has a theme (${basename(file.theme_path)}). Use it?`)) setCss(file.theme);
        }
        renderPreview(true);
        break;
      }
      case "save-md":
        if (state.filePath) {
          await saveFile("markdown", dirname(state.filePath), basename(state.filePath), { overwrite: true });
          setDirty(false);
          toast(`Saved ${state.filePath}`);
        } else {
          await command("save-md-as");
        }
        break;
      case "save-md-as": {
        const path = await saveWithPicker("markdown", "Save Markdown", `${state.docName}.md`);
        if (path) {
          state.filePath = path;
          state.baseDir = dirname(path);
          state.docName = stripExt(basename(path));
          updateFileInfo();
          setDirty(false);
          renderPreview();
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
        await saveWithPicker("css", "Save theme", "easymarkdoc.css", {
          hint: "Tip: a theme named easymarkdoc.css next to a document is used automatically by the command line and VS Code extension.",
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
      case "save-pdf":
        await saveWithPicker("pdf", "Save PDF", `${state.docName}.pdf`);
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
        await saveWithPicker("html", "Save HTML", `${state.docName}.html`);
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

async function saveFile(kind, directory, filename, { overwrite = false } = {}) {
  return api("/api/save", {
    method: "POST",
    body: {
      kind,
      directory,
      filename,
      overwrite,
      markdown: state.markdown,
      css: state.css || null,
      base_dir: state.baseDir,
    },
  });
}

async function saveWithPicker(kind, title, filename, options = {}) {
  const picked = await pickFolder(title, filename, options);
  if (!picked) return null;
  if (kind === "pdf") toast("Rendering PDF…");
  let result;
  try {
    result = await saveFile(kind, picked.dir, picked.name);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      if (!confirm(`${err.message}. Replace it?`)) return null;
      result = await saveFile(kind, picked.dir, picked.name, { overwrite: true });
    } else {
      throw err;
    }
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
    const ok = dialog.returnValue === "ok";
    const result = ok ? pickerState.result() : null;
    pickerState = null;
    resolve?.(result);
  });
  $("#picker-ok").addEventListener("click", (e) => {
    e.preventDefault();
    if (pickerState?.mode === "save" && !$("#picker-name").value.trim()) {
      $("#picker-name").focus();
      return;
    }
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
    err.hidden = true;
    pickerState.path = data.path;
    pickerState.parent = data.parent;
    pickerState.home = data.home;
    pickerState.selected = null;
    $("#picker-path").value = data.path;
    const list = $("#picker-list");
    list.replaceChildren();
    for (const dir of data.dirs) {
      const li = document.createElement("li");
      li.className = "dir";
      li.textContent = dir;
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
    err.hidden = false;
  }
}

function openPicker({ title, mode, filename = "", extensions = null, startDir, hint }) {
  return new Promise((resolve) => {
    pickerState = {
      mode,
      extensions,
      resolve,
      result: () =>
        mode === "save" ? { dir: pickerState.path, name: $("#picker-name").value.trim() } : pickerState.selected,
    };
    $("#picker-title").textContent = title;
    $("#picker-name-row").hidden = mode !== "save";
    $("#picker-name").value = filename;
    $("#picker-ok").textContent = mode === "save" ? "Save here" : "Open";
    const err = $("#picker-error");
    err.hidden = !hint;
    err.classList.toggle("hint", !!hint);
    err.textContent = hint || "";
    $("#picker").returnValue = "";
    $("#picker").showModal();
    browse(startDir || state.lastDir || state.outputDir).then(() => {
      if (hint) {
        err.textContent = hint;
        err.hidden = false;
      }
    });
    if (mode === "save") {
      const input = $("#picker-name");
      input.focus();
      const dot = filename.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : filename.length);
    }
  });
}

function pickFolder(title, filename, { hint, defaultDir } = {}) {
  return openPicker({ title, mode: "save", filename, hint, startDir: defaultDir });
}

function pickFile(title, extensions) {
  return openPicker({ title, mode: "open", extensions, startDir: state.filePath ? state.baseDir : undefined });
}

// ---------------------------------------------------------------------------
// Layout, shortcuts, drag and drop, notifications
// ---------------------------------------------------------------------------

function setupSplitter() {
  const splitter = $("#splitter");
  const pane = $("#editor-pane");
  const workspace = $("#workspace");
  const apply = (pct) => {
    pct = Math.min(80, Math.max(20, pct));
    pane.style.flexBasis = `${pct}%`;
    return pct;
  };
  apply(Number(store.get("split", 45)));
  splitter.addEventListener("pointerdown", (e) => {
    splitter.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const move = (ev) => {
      const rect = workspace.getBoundingClientRect();
      store.set("split", apply(((ev.clientX - rect.left) / rect.width) * 100));
    };
    const up = () => {
      splitter.removeEventListener("pointermove", move);
      document.body.classList.remove("resizing");
      mdEditor.refresh();
      cssEditor.refresh();
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up, { once: true });
  });
  splitter.addEventListener("keydown", (e) => {
    const current = parseFloat(pane.style.flexBasis) || 45;
    if (e.key === "ArrowLeft") store.set("split", apply(current - 2));
    if (e.key === "ArrowRight") store.set("split", apply(current + 2));
  });
}

function setupShortcuts() {
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === "s" && e.shiftKey) {
      e.preventDefault();
      command("save-pdf");
    } else if (key === "s") {
      e.preventDefault();
      command("save-md");
    } else if (key === "o") {
      e.preventDefault();
      command("open-disk");
    } else if (key === "p") {
      e.preventDefault();
      command("print-pdf");
    }
  });
}

function setupDragAndDrop() {
  const target = document.body;
  target.addEventListener("dragover", (e) => {
    if ([...e.dataTransfer.items].some((i) => i.kind === "file")) {
      e.preventDefault();
      target.classList.add("dragging");
    }
  });
  target.addEventListener("dragleave", (e) => {
    if (e.target === target || !target.contains(e.relatedTarget)) target.classList.remove("dragging");
  });
  target.addEventListener("drop", async (e) => {
    target.classList.remove("dragging");
    const file = e.dataTransfer.files[0];
    if (!file) return;
    e.preventDefault();
    if (/\.css$/i.test(file.name)) {
      setCss(await file.text());
      toast(`Loaded theme ${file.name}`);
    } else {
      loadMarkdownFile(file);
    }
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
