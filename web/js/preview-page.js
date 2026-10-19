// Stand-alone preview page embedded by the VS Code extension.
//
// The host (the extension's webview) sends:
//   { type: "update", markdown, css, baseDir, fileName }
//   { type: "settings", mode, zoom, theme: "light" | "dark" }
// and this page replies with:
//   { type: "ready" } | { type: "export" } | { type: "open-editor" }
//   { type: "settings-changed", mode, zoom }

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
  post({ type: "settings-changed", mode: preview.mode, zoom: preview.zoom });
});
$("#zoom").addEventListener("change", (e) => {
  preview.setZoom(e.target.value);
  post({ type: "settings-changed", mode: preview.mode, zoom: preview.zoom });
});
$("#refresh").addEventListener("click", () => preview.refresh());
$("#export").addEventListener("click", () => post({ type: "export" }));
$("#open-editor").addEventListener("click", () => post({ type: "open-editor" }));

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

post({ type: "ready" });
