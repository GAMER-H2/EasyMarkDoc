// Stand-alone preview page.
//
// Embedded by the VS Code extension, the host (the extension's webview) sends:
//   { type: "update", markdown, css, baseDir, fileName }
//   { type: "settings", mode, zoom, theme: "light" | "dark" }
// and this page replies with:
//   { type: "ready" } | { type: "export" } | { type: "open-editor" }
//   { type: "settings-changed", mode, zoom }
//
// Opened in a browser by the Zed language server as /preview?doc=<id>, it
// follows the document through server-sent events instead, and exports and
// opens the style editor itself.

import { api, token } from "./api.js";
import { Preview } from "./preview.js";

const $ = (sel) => document.querySelector(sel);
const host = window.parent !== window ? window.parent : null;
const post = (msg) => host?.postMessage({ source: "easymarkdoc-preview", ...msg }, "*");

const status = $("#status");
const preview = new Preview($("#preview"), {
  onStatus(s) {
    status.classList.toggle("error", s.state === "error");
    if (s.state === "rendering") status.textContent = "Rendering…";
    else if (s.state === "ok") status.textContent = `${s.pages} page${s.pages === 1 ? "" : "s"} · ${s.ms} ms`;
    else if (s.state === "error") status.textContent = `Error: ${s.message}`;
  },
});

const params = new URLSearchParams(location.search);
const liveDoc = params.get("doc");
if (liveDoc) {
  const saved = JSON.parse(localStorage.getItem("emd-preview-settings") || "{}");
  preview.setMode(saved.mode || params.get("mode") || "pdf");
  preview.setZoom(saved.zoom || "fit");
}

const syncControls = () => {
  document
    .querySelectorAll("#mode-toggle button")
    .forEach((b) => b.classList.toggle("active", b.dataset.mode === preview.mode));
  $("#zoom").value = preview.zoom;
};
syncControls();

$("#mode-toggle").addEventListener("click", (e) => {
  const mode = e.target.closest("button")?.dataset.mode;
  if (!mode) return;
  preview.setMode(mode);
  syncControls();
  settingsChanged();
});
$("#zoom").addEventListener("change", (e) => {
  preview.setZoom(e.target.value);
  settingsChanged();
});
$("#refresh").addEventListener("click", () => preview.refresh());
$("#export").addEventListener("click", () => (liveDoc ? liveExport() : post({ type: "export" })));
$("#open-editor").addEventListener("click", () => (liveDoc ? liveOpenEditor() : post({ type: "open-editor" })));

function settingsChanged() {
  const settings = { mode: preview.mode, zoom: preview.zoom };
  if (liveDoc) localStorage.setItem("emd-preview-settings", JSON.stringify(settings));
  else post({ type: "settings-changed", ...settings });
}

// ------------------------------------------------------------ live (Zed)

let current = null;

function showMessage(text, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}

function connectLive() {
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const applyTheme = () => document.body.classList.toggle("vscode-dark", dark.matches);
  dark.addEventListener("change", applyTheme);
  applyTheme();

  const query = new URLSearchParams({ doc: liveDoc, token });
  const events = new EventSource(`/api/live/events?${query}`);
  events.addEventListener("update", (event) => {
    const first = !current;
    current = JSON.parse(event.data);
    document.title = `${current.file_name} · EasyMarkDoc Preview`;
    preview.update(
      { markdown: current.markdown, css: current.css ?? "", baseDir: current.base_dir ?? null },
      { immediate: first },
    );
  });
  // The browser keeps retrying a dropped connection; a preview that never
  // connected belongs to a server that has gone (Zed was restarted).
  events.addEventListener("error", () => {
    if (current) {
      showMessage("Disconnected from Zed. Reopen the preview from Zed if this persists.", true);
    } else {
      events.close();
      showMessage("This preview has expired. Reopen it from Zed's code actions.", true);
    }
  });
}

async function liveExport() {
  const button = $("#export");
  button.disabled = true;
  showMessage("Exporting PDF…");
  try {
    const { path } = await api("/api/live/export", { method: "POST", body: { doc: liveDoc } });
    showMessage(`PDF saved: ${path}`);
  } catch (err) {
    showMessage(`Export failed: ${err.message}`, true);
  } finally {
    button.disabled = false;
  }
}

function liveOpenEditor() {
  if (!current?.file_path) {
    showMessage("Save the document in Zed first.", true);
    return;
  }
  if (
    current.dirty &&
    !confirm("This document has unsaved changes in Zed. The style editor opens the saved version. Continue?")
  ) {
    return;
  }
  window.open(`/?open=${encodeURIComponent(current.file_path)}`, "_blank");
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object" || (host && event.source !== host)) return;
  if (msg.type === "update") {
    preview.update(
      { markdown: msg.markdown ?? "", css: msg.css ?? "", baseDir: msg.baseDir ?? null },
      { immediate: !!msg.immediate },
    );
  } else if (msg.type === "settings") {
    if (msg.mode) preview.setMode(msg.mode);
    if (msg.zoom) preview.setZoom(String(msg.zoom));
    document.body.classList.toggle("vscode-dark", msg.theme === "dark");
    syncControls();
  }
});

if (liveDoc) connectLive();
else post({ type: "ready" });
