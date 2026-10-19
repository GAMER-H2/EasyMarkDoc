// EasyMarkDoc VS Code extension: live PDF preview and export.
//
// The extension starts `EasyMarkDoc serve` in the background and shows its
// preview page in a webview. Document text and the theme CSS are pushed to
// the preview as you type; exports call the same server.

const vscode = require("vscode");
const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const THEME_FILE = "easymarkdoc.css";

let output;
let server = null; // { process, url, token, ready: Promise }
let preview = null; // PreviewPanel

function activate(context) {
  output = vscode.window.createOutputChannel("EasyMarkDoc");

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("easymarkdoc.openPreview", (uri) => openPreview(context, uri)),
    vscode.commands.registerCommand("easymarkdoc.exportPdf", (uri) => exportPdf(uri, false)),
    vscode.commands.registerCommand("easymarkdoc.exportPdfAs", (uri) => exportPdf(uri, true)),
    vscode.commands.registerCommand("easymarkdoc.openStyleEditor", openStyleEditor),
    vscode.commands.registerCommand("easymarkdoc.selectTheme", selectTheme),
    vscode.commands.registerCommand("easymarkdoc.createTheme", createTheme),
    vscode.commands.registerCommand("easymarkdoc.restartServer", async () => {
      stopServer();
      await ensureServer();
      preview?.reload();
      vscode.window.showInformationMessage("EasyMarkDoc server restarted.");
    }),
    vscode.workspace.onDidChangeTextDocument((e) => preview?.documentChanged(e.document)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document.languageId === "markdown") preview?.setDocument(editor.document);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === "css") preview?.themeMaybeChanged(doc.uri.fsPath);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("easymarkdoc.themePath")) preview?.push(true);
      if (
        e.affectsConfiguration("easymarkdoc.executablePath") ||
        e.affectsConfiguration("easymarkdoc.chromePath") ||
        e.affectsConfiguration("easymarkdoc.allowBrowserDownload")
      ) {
        stopServer();
        preview?.reload();
      }
    }),
    vscode.window.onDidChangeActiveColorTheme(() => preview?.sendSettings()),
  );

  // Pick up edits to theme files made outside VS Code (e.g. from the web
  // style editor) as well as unsaved typing in an open theme file.
  const watcher = vscode.workspace.createFileSystemWatcher(`**/*.css`);
  const onTheme = (uri) => preview?.themeMaybeChanged(uri.fsPath);
  watcher.onDidChange(onTheme);
  watcher.onDidCreate(onTheme);
  watcher.onDidDelete(onTheme);
  context.subscriptions.push(watcher);
}

function deactivate() {
  stopServer();
}

// ---------------------------------------------------------------------------
// Server process
// ---------------------------------------------------------------------------

function config() {
  return vscode.workspace.getConfiguration("easymarkdoc");
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function findExecutable() {
  const exe = process.platform === "win32" ? ".exe" : "";
  const configured = config().get("executablePath");
  if (configured) return configured;

  const candidates = [];
  for (const folder of vscode.workspace.workspaceFolders || []) {
    for (const profile of ["release", "debug"]) {
      candidates.push(path.join(folder.uri.fsPath, "target", profile, `EasyMarkDoc${exe}`));
    }
  }
  candidates.push(path.join(__dirname, "bin", `EasyMarkDoc${exe}`));
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, `EasyMarkDoc${exe}`), path.join(dir, `easymarkdoc${exe}`));
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) candidates.push(path.join(home, ".cargo", "bin", `EasyMarkDoc${exe}`));
  return candidates.find(isExecutable) || null;
}

function stopServer() {
  if (server) {
    try {
      server.process.stdin.end();
      server.process.kill();
    } catch {
      /* already gone */
    }
    server = null;
  }
}

/** Start the server if needed; resolves to { url, token }. */
function ensureServer() {
  if (server) return server.ready;

  const executable = findExecutable();
  if (!executable) {
    const message =
      "EasyMarkDoc executable not found. Build it with `cargo build --release`, add it to your PATH, or set `easymarkdoc.executablePath`.";
    vscode.window.showErrorMessage(message, "Open Settings").then((choice) => {
      if (choice) vscode.commands.executeCommand("workbench.action.openSettings", "easymarkdoc.executablePath");
    });
    return Promise.reject(new Error(message));
  }

  const token = crypto.randomBytes(16).toString("hex");
  const args = ["serve", "--no-open", "--port", "0", "--exit-on-stdin-close", "--token", token];
  const chrome = config().get("chromePath");
  if (chrome) args.push("--chrome", chrome);
  if (!config().get("allowBrowserDownload")) args.push("--no-download");

  output.appendLine(`Starting ${executable} ${args.filter((a) => a !== token).join(" ")}`);
  const child = cp.spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
  const current = { process: child, token, url: null };
  server = current;

  current.ready = new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => reject(new Error("Timed out starting the EasyMarkDoc server")), 20000);
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output.append(text);
      buffer += text;
      const match = /listening on (http:\/\/\S+)/.exec(buffer);
      if (match && !current.url) {
        clearTimeout(timeout);
        current.url = match[1].endsWith("/") ? match[1] : `${match[1]}/`;
        resolve({ url: current.url, token });
      }
    });
    child.stderr.on("data", (chunk) => output.append(chunk.toString()));
    child.on("error", (err) => {
      clearTimeout(timeout);
      output.appendLine(`Failed to start: ${err.message}`);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      output.appendLine(`EasyMarkDoc server exited (${code})`);
      if (server === current) server = null;
      reject(new Error(`EasyMarkDoc server exited with code ${code}`));
    });
  });
  current.ready.catch((err) => {
    if (server === current) server = null;
    output.appendLine(err.message);
  });
  return current.ready;
}

async function apiRender(markdown, css, baseDir) {
  const { url, token } = await ensureServer();
  const response = await fetch(`${url}api/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-EasyMarkDoc-Token": token },
    body: JSON.stringify({ markdown, css: css || null, base_dir: baseDir, format: "pdf" }),
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      message = (await response.json()).error || message;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  return new Uint8Array(await response.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

/** Resolve the theme file for a document (may not exist). */
function themePathFor(document) {
  const configured = config().get("themePath");
  if (configured) {
    if (path.isAbsolute(configured)) return configured;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const base = folder ? folder.uri.fsPath : path.dirname(document.uri.fsPath);
    return path.join(base, configured);
  }
  if (document.uri.scheme !== "file") return null;
  return path.join(path.dirname(document.uri.fsPath), THEME_FILE);
}

/** Current theme CSS, preferring unsaved editor contents. */
function readTheme(document) {
  const themePath = themePathFor(document);
  if (!themePath) return { css: "", themePath: null };
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === themePath);
  if (open) return { css: open.getText(), themePath };
  try {
    return { css: fs.readFileSync(themePath, "utf8"), themePath };
  } catch {
    return { css: "", themePath: null };
  }
}

async function selectTheme() {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { "CSS theme": ["css"] },
    openLabel: "Use as theme",
  });
  if (!picked || !picked.length) return;
  const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await config().update("themePath", picked[0].fsPath, target);
  vscode.window.showInformationMessage(`EasyMarkDoc theme set to ${path.basename(picked[0].fsPath)}`);
}

async function createTheme() {
  const document = activeMarkdown();
  if (!document || document.uri.scheme !== "file") {
    vscode.window.showWarningMessage("Open a saved Markdown file first.");
    return;
  }
  const target = path.join(path.dirname(document.uri.fsPath), THEME_FILE);
  if (!fs.existsSync(target)) {
    const { url, token } = await ensureServer();
    const state = await (await fetch(`${url}api/state`, { headers: { "X-EasyMarkDoc-Token": token } })).json();
    const settings = /:root\s*\{[\s\S]*?\n\}/.exec(state.default_css);
    const content =
      "/* EasyMarkDoc theme for documents in this folder.\n" +
      " * Layered on top of the default theme: change any variable below, or add\n" +
      " * your own CSS rules. Run `EasyMarkDoc theme` to see the full default theme. */\n\n" +
      (settings ? settings[0] : ":root {\n}") +
      "\n";
    fs.writeFileSync(target, content);
  }
  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function activeMarkdown(uri) {
  if (uri instanceof vscode.Uri) {
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) || uri;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === "markdown") return editor.document;
  return preview?.document || null;
}

function defaultOutputPath(document) {
  const source = document.uri.scheme === "file" ? document.uri.fsPath : null;
  const name = source ? path.basename(source).replace(/\.(md|markdown|mdown|txt)$/i, "") : "document";
  let dir = source ? path.dirname(source) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || require("os").homedir();
  const configured = config().get("outputDirectory");
  if (configured) dir = path.isAbsolute(configured) ? configured : path.join(dir, configured);
  return path.join(dir, `${name}.pdf`);
}

async function exportPdf(uri, ask) {
  let document = activeMarkdown(uri);
  if (document instanceof vscode.Uri) document = await vscode.workspace.openTextDocument(document);
  if (!document) {
    vscode.window.showWarningMessage("Open a Markdown file to export.");
    return;
  }

  let target = defaultOutputPath(document);
  if (ask) {
    const picked = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(target),
      filters: { PDF: ["pdf"] },
      saveLabel: "Export PDF",
    });
    if (!picked) return;
    target = picked.fsPath;
  }

  try {
    const pdf = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "EasyMarkDoc: exporting PDF…" },
      async () => {
        const { css } = readTheme(document);
        const baseDir = document.uri.scheme === "file" ? path.dirname(document.uri.fsPath) : null;
        return apiRender(document.getText(), css, baseDir);
      },
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await vscode.workspace.fs.writeFile(vscode.Uri.file(target), pdf);
    if (config().get("openAfterExport")) {
      vscode.env.openExternal(vscode.Uri.file(target));
    } else {
      vscode.window.showInformationMessage(`PDF saved: ${target}`, "Open PDF", "Reveal in Folder").then((choice) => {
        if (choice === "Open PDF") vscode.env.openExternal(vscode.Uri.file(target));
        if (choice === "Reveal in Folder") vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(target));
      });
    }
  } catch (err) {
    vscode.window.showErrorMessage(`EasyMarkDoc export failed: ${err.message}`);
  }
}

async function openStyleEditor() {
  const document = activeMarkdown();
  try {
    const { url } = await ensureServer();
    let target = url;
    if (document && document.uri && document.uri.scheme === "file") {
      if (document.isDirty) await document.save();
      target = `${url}?open=${encodeURIComponent(document.uri.fsPath)}`;
    }
    vscode.env.openExternal(vscode.Uri.parse(target));
    vscode.window.showInformationMessage(
      `Style the document in your browser, then use Theme → Save theme to folder… and save it as ${THEME_FILE} next to the document. The preview updates automatically.`,
    );
  } catch (err) {
    vscode.window.showErrorMessage(err.message);
  }
}

// ---------------------------------------------------------------------------
// Preview panel
// ---------------------------------------------------------------------------

async function openPreview(context, uri) {
  let document = activeMarkdown(uri);
  if (document instanceof vscode.Uri) document = await vscode.workspace.openTextDocument(document);
  if (!document) {
    vscode.window.showWarningMessage("Open a Markdown file to preview.");
    return;
  }
  if (preview) {
    preview.setDocument(document);
    preview.panel.reveal(vscode.ViewColumn.Beside, true);
    return;
  }
  preview = new PreviewPanel(context, document);
  preview.panel.onDidDispose(() => (preview = null));
}

class PreviewPanel {
  constructor(context, document) {
    this.context = context;
    this.document = document;
    this.ready = false;
    this.lastTheme = null;
    this.panel = vscode.window.createWebviewPanel(
      "easymarkdoc.preview",
      this.title(),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.iconPath = new vscode.ThemeIcon("file-pdf");
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.reload();
  }

  title() {
    return `PDF Preview: ${path.basename(this.document.fileName)}`;
  }

  async reload() {
    this.ready = false;
    this.panel.webview.html = this.loadingHtml("Starting EasyMarkDoc…");
    try {
      const { url, token } = await ensureServer();
      const external = await vscode.env.asExternalUri(vscode.Uri.parse(url));
      const base = external.toString(true).replace(/\/?$/, "/");
      this.panel.webview.html = this.frameHtml(`${base}preview?token=${token}`, new URL(base).origin);
    } catch (err) {
      this.panel.webview.html = this.loadingHtml(`Could not start EasyMarkDoc: ${err.message}`);
    }
  }

  setDocument(document) {
    if (document.uri.toString() === this.document.uri.toString()) return;
    this.document = document;
    this.panel.title = this.title();
    this.push(true);
  }

  documentChanged(document) {
    if (document.uri.toString() === this.document.uri.toString()) this.push(false);
    else if (document.languageId === "css") this.themeMaybeChanged(document.uri.fsPath);
  }

  themeMaybeChanged(fsPath) {
    const themePath = themePathFor(this.document);
    if (themePath && path.resolve(fsPath) === path.resolve(themePath)) this.push(false);
  }

  push(immediate) {
    if (!this.ready) return;
    const { css } = readTheme(this.document);
    const baseDir = this.document.uri.scheme === "file" ? path.dirname(this.document.uri.fsPath) : null;
    this.panel.webview.postMessage({
      type: "update",
      markdown: this.document.getText(),
      css,
      baseDir,
      fileName: path.basename(this.document.fileName),
      immediate,
    });
  }

  sendSettings() {
    if (!this.ready) return;
    const state = this.context.workspaceState;
    const kind = vscode.window.activeColorTheme.kind;
    const dark = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
    this.panel.webview.postMessage({
      type: "settings",
      mode: state.get("easymarkdoc.mode") || config().get("previewMode"),
      zoom: state.get("easymarkdoc.zoom") || "fit",
      theme: dark ? "dark" : "light",
    });
  }

  onMessage(msg) {
    if (!msg || msg.source !== "easymarkdoc-preview") return;
    switch (msg.type) {
      case "ready":
        this.ready = true;
        this.sendSettings();
        this.push(true);
        break;
      case "export":
        exportPdf(this.document.uri, true);
        break;
      case "open-editor":
        openStyleEditor();
        break;
      case "settings-changed":
        this.context.workspaceState.update("easymarkdoc.mode", msg.mode);
        this.context.workspaceState.update("easymarkdoc.zoom", msg.zoom);
        break;
    }
  }

  loadingHtml(message) {
    const escaped = message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
    return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:2em">${escaped}</body></html>`;
  }

  frameHtml(src, origin) {
    const nonce = crypto.randomBytes(16).toString("base64");
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
  iframe { border: 0; width: 100%; height: 100%; display: block; }
</style>
</head>
<body>
<iframe id="frame" src="${src}" allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const frame = document.getElementById("frame");
  const origin = ${JSON.stringify(origin)};
  window.addEventListener("message", (event) => {
    if (event.source === frame.contentWindow) {
      vscode.postMessage(event.data);
    } else if (event.data && event.data.source !== "easymarkdoc-preview") {
      frame.contentWindow.postMessage(event.data, origin);
    }
  });
</script>
</body>
</html>`;
  }
}

module.exports = { activate, deactivate };
