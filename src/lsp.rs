//! Language server used by the Zed extension (`EasyMarkDoc lsp`).
//!
//! Zed extensions can't show webviews, so the integration is a language
//! server. It keeps the text of open Markdown and CSS buffers (including
//! unsaved edits), offers export and preview code actions, and runs the
//! preview server in-process, streaming the buffers to a browser preview.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, bail};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{OnceCell, mpsc, oneshot};

use crate::document::{self, HtmlOptions};
use crate::pdf::EngineOptions;
use crate::server::{self, LiveDocument, RunningServer, ServeOptions};

const THEME_FILE: &str = "easymarkdoc.css";

const EXPORT_PDF: &str = "easymarkdoc.exportPdf";
const EXPORT_PDF_AND_OPEN: &str = "easymarkdoc.exportPdfAndOpen";
const EXPORT_HTML: &str = "easymarkdoc.exportHtml";
const OPEN_PREVIEW: &str = "easymarkdoc.openPreview";

/// Code actions offered on Markdown files: (command, title).
const ACTIONS: &[(&str, &str)] = &[
    (EXPORT_PDF, "EasyMarkDoc: Export PDF"),
    (EXPORT_PDF_AND_OPEN, "EasyMarkDoc: Export PDF and Open"),
    (EXPORT_HTML, "EasyMarkDoc: Export HTML"),
    (OPEN_PREVIEW, "EasyMarkDoc: Open Live Preview in Browser"),
];

/// Settings from `lsp.easymarkdoc.settings` (or `initialization_options`)
/// in Zed's settings.json.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
struct Config {
    /// Theme CSS, absolute or relative to the project root. Default:
    /// `easymarkdoc.css` next to the Markdown file, if present.
    #[serde(alias = "themePath")]
    theme_path: Option<String>,
    /// Folder for exports, absolute or relative to the Markdown file.
    #[serde(alias = "outputDirectory")]
    output_directory: Option<String>,
    /// "pdf" (exact PDF) or "paged" (fast HTML pages).
    #[serde(alias = "previewMode")]
    preview_mode: Option<String>,
    #[serde(alias = "chromePath")]
    chrome_path: Option<PathBuf>,
    #[serde(alias = "allowBrowserDownload")]
    allow_browser_download: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            theme_path: None,
            output_directory: None,
            preview_mode: None,
            chrome_path: None,
            allow_browser_download: true,
        }
    }
}

impl Config {
    /// Accepts the settings object itself or one nested under "easymarkdoc".
    fn from_value(value: &Value) -> Option<Config> {
        let value = value.get("easymarkdoc").unwrap_or(value);
        if !value.is_object() {
            return None;
        }
        match serde_json::from_value(value.clone()) {
            Ok(config) => Some(config),
            Err(e) => {
                eprintln!("Ignoring invalid EasyMarkDoc settings: {e}");
                None
            }
        }
    }
}

struct Buffer {
    text: String,
    language: String,
    dirty: bool,
    /// Closed in Zed but still shown in a preview: read from disk instead.
    closed: bool,
}

struct Lsp {
    out: Mutex<std::io::Stdout>,
    config: Mutex<Config>,
    root: Mutex<Option<PathBuf>>,
    buffers: Mutex<HashMap<String, Buffer>>,
    /// Documents with a preview open, and what was last sent to it.
    published: Mutex<HashMap<String, LiveDocument>>,
    server: OnceCell<Arc<RunningServer>>,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<Value>>>,
}

/// Run the language server on stdin/stdout until the client exits.
pub async fn run() -> anyhow::Result<()> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(std::io::stdin().lock());
        while let Ok(Some(message)) = read_message(&mut reader) {
            if tx.send(message).is_err() {
                break;
            }
        }
    });

    let lsp = Arc::new(Lsp {
        out: Mutex::new(std::io::stdout()),
        config: Mutex::new(Config::default()),
        root: Mutex::new(None),
        buffers: Mutex::new(HashMap::new()),
        published: Mutex::new(HashMap::new()),
        server: OnceCell::new(),
        next_id: AtomicI64::new(1),
        pending: Mutex::new(HashMap::new()),
    });

    // Theme files and closed documents can change on disk (for example when
    // saved from the web style editor): check previewed documents regularly.
    {
        let lsp = lsp.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            loop {
                interval.tick().await;
                let uris: Vec<String> = lsp.published.lock().unwrap().keys().cloned().collect();
                for uri in uris {
                    lsp.refresh(&uri);
                }
            }
        });
    }

    while let Some(message) = rx.recv().await {
        let method = message.get("method").and_then(Value::as_str);
        let id = message.get("id").cloned();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        match (method, id) {
            (Some("exit"), _) => break,
            (Some(method), Some(id)) => lsp.clone().request(method, id, params).await,
            (Some(method), None) => lsp.notification(method, params),
            (None, Some(id)) => lsp.response(id, message),
            (None, None) => {}
        }
    }

    if let Some(server) = lsp.server.get() {
        server.shutdown().await;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// JSON-RPC transport
// ---------------------------------------------------------------------------

fn read_message(reader: &mut impl BufRead) -> anyhow::Result<Option<Value>> {
    let mut length = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            length = Some(value.trim().parse::<usize>()?);
        }
    }
    let length = length.context("message without Content-Length")?;
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(Some(serde_json::from_slice(&body)?))
}

impl Lsp {
    fn send(&self, message: Value) {
        let body = message.to_string();
        let mut out = self.out.lock().unwrap();
        let _ = write!(out, "Content-Length: {}\r\n\r\n{body}", body.len());
        let _ = out.flush();
    }

    fn respond(&self, id: Value, result: Value) {
        self.send(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }

    fn respond_error(&self, id: Value, code: i64, message: &str) {
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        }));
    }

    fn notify(&self, method: &str, params: Value) {
        self.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    /// Send a request to the client; resolves to its `result` (or null).
    async fn client_request(&self, method: &str, params: Value) -> Value {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        rx.await.unwrap_or(Value::Null)
    }

    fn response(&self, id: Value, message: Value) {
        if let Some(tx) = id
            .as_i64()
            .and_then(|id| self.pending.lock().unwrap().remove(&id))
        {
            let _ = tx.send(message.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    fn show_message(&self, kind: MessageKind, message: &str) {
        self.notify(
            "window/showMessage",
            json!({ "type": kind as u8, "message": message }),
        );
    }

    /// Show a message with buttons; resolves to the chosen title.
    async fn ask(&self, kind: MessageKind, message: &str, actions: &[&str]) -> Option<String> {
        let actions: Vec<Value> = actions.iter().map(|a| json!({ "title": a })).collect();
        let result = self
            .client_request(
                "window/showMessageRequest",
                json!({ "type": kind as u8, "message": message, "actions": actions }),
            )
            .await;
        result
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string)
    }
}

#[derive(Clone, Copy)]
enum MessageKind {
    Error = 1,
    Info = 3,
}

// ---------------------------------------------------------------------------
// Requests and notifications
// ---------------------------------------------------------------------------

impl Lsp {
    async fn request(self: Arc<Self>, method: &str, id: Value, params: Value) {
        match method {
            "initialize" => {
                if let Some(config) = params
                    .get("initializationOptions")
                    .and_then(Config::from_value)
                {
                    *self.config.lock().unwrap() = config;
                }
                let root = params
                    .pointer("/workspaceFolders/0/uri")
                    .or_else(|| params.get("rootUri"))
                    .and_then(Value::as_str)
                    .and_then(uri_to_path);
                *self.root.lock().unwrap() = root;
                let commands: Vec<&str> = ACTIONS.iter().map(|(c, _)| *c).collect();
                self.respond(
                    id,
                    json!({
                        "capabilities": {
                            "textDocumentSync": {
                                "openClose": true,
                                "change": 1,
                                "save": { "includeText": false },
                            },
                            "codeActionProvider": true,
                            "executeCommandProvider": { "commands": commands },
                        },
                        "serverInfo": { "name": "EasyMarkDoc", "version": env!("CARGO_PKG_VERSION") },
                    }),
                );
            }
            "shutdown" => {
                if let Some(server) = self.server.get() {
                    server.shutdown().await;
                }
                self.respond(id, Value::Null);
            }
            "textDocument/codeAction" => {
                let uri = params.pointer("/textDocument/uri").and_then(Value::as_str);
                let actions: Vec<Value> = match uri {
                    Some(uri) if self.is_markdown(uri) => ACTIONS
                        .iter()
                        .map(|(command, title)| {
                            json!({
                                "title": title,
                                "command": { "title": title, "command": command, "arguments": [uri] },
                            })
                        })
                        .collect(),
                    _ => Vec::new(),
                };
                self.respond(id, Value::Array(actions));
            }
            "workspace/executeCommand" => {
                let command = params.get("command").and_then(Value::as_str).unwrap_or("");
                let uri = params.pointer("/arguments/0").and_then(Value::as_str);
                match (ACTIONS.iter().find(|(c, _)| *c == command), uri) {
                    (Some((command, _)), Some(uri)) => {
                        // Answer straight away; the work reports its own
                        // progress and result.
                        self.respond(id, Value::Null);
                        let (command, uri) = (command.to_string(), uri.to_string());
                        tokio::spawn(async move { self.execute(&command, &uri).await });
                    }
                    _ => self.respond_error(id, -32602, "unknown command or missing document"),
                }
            }
            _ => self.respond_error(id, -32601, &format!("unsupported request {method}")),
        }
    }

    fn notification(&self, method: &str, params: Value) {
        let uri = params
            .pointer("/textDocument/uri")
            .and_then(Value::as_str)
            .map(str::to_string);
        match (method, uri) {
            ("workspace/didChangeConfiguration", _) => {
                if let Some(config) = params.get("settings").and_then(Config::from_value) {
                    *self.config.lock().unwrap() = config;
                    self.refresh_all();
                }
            }
            ("textDocument/didOpen", Some(uri)) => {
                let doc = &params["textDocument"];
                let buffer = Buffer {
                    text: doc["text"].as_str().unwrap_or("").to_string(),
                    language: doc["languageId"]
                        .as_str()
                        .unwrap_or("")
                        .to_ascii_lowercase(),
                    dirty: false,
                    closed: false,
                };
                self.buffers.lock().unwrap().insert(uri.clone(), buffer);
                self.changed(&uri);
            }
            ("textDocument/didChange", Some(uri)) => {
                // Full sync: the last change holds the whole text.
                let Some(text) = params
                    .get("contentChanges")
                    .and_then(Value::as_array)
                    .and_then(|changes| changes.last())
                    .and_then(|change| change["text"].as_str())
                else {
                    return;
                };
                if let Some(buffer) = self.buffers.lock().unwrap().get_mut(&uri) {
                    buffer.text = text.to_string();
                    buffer.dirty = true;
                }
                self.changed(&uri);
            }
            ("textDocument/didSave", Some(uri)) => {
                if let Some(buffer) = self.buffers.lock().unwrap().get_mut(&uri) {
                    buffer.dirty = false;
                }
                self.changed(&uri);
            }
            ("textDocument/didClose", Some(uri)) => {
                let previewed = self.published.lock().unwrap().contains_key(&uri);
                let mut buffers = self.buffers.lock().unwrap();
                if previewed {
                    if let Some(buffer) = buffers.get_mut(&uri) {
                        buffer.closed = true;
                        buffer.dirty = false;
                    }
                } else {
                    buffers.remove(&uri);
                }
                drop(buffers);
                self.changed(&uri);
            }
            _ => {}
        }
    }

    fn is_markdown(&self, uri: &str) -> bool {
        if let Some(buffer) = self.buffers.lock().unwrap().get(uri) {
            return buffer.language == "markdown";
        }
        uri_to_path(uri).is_some_and(|p| {
            p.extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
        })
    }

    async fn execute(&self, command: &str, uri: &str) {
        let result = match command {
            OPEN_PREVIEW => self.open_preview(uri).await,
            EXPORT_HTML => self.export(uri, ExportKind::Html, false).await,
            EXPORT_PDF_AND_OPEN => self.export(uri, ExportKind::Pdf, true).await,
            _ => self.export(uri, ExportKind::Pdf, false).await,
        };
        if let Err(e) = result {
            self.show_message(MessageKind::Error, &format!("EasyMarkDoc: {e:#}"));
        }
    }
}

// ---------------------------------------------------------------------------
// Documents, themes and the preview server
// ---------------------------------------------------------------------------

impl Lsp {
    /// Snapshot a Markdown document with its theme, as the preview and
    /// exports see it.
    fn document(&self, uri: &str) -> anyhow::Result<LiveDocument> {
        let file_path = uri_to_path(uri);
        let (markdown, dirty) = {
            let buffers = self.buffers.lock().unwrap();
            match buffers.get(uri) {
                Some(b) if !b.closed => (b.text.clone(), b.dirty),
                _ => {
                    let path = file_path.as_ref().context("the document is not a file")?;
                    let text = std::fs::read_to_string(path)
                        .with_context(|| format!("reading {}", path.display()))?;
                    (text, false)
                }
            }
        };
        let base_dir = file_path
            .as_ref()
            .and_then(|p| p.parent().map(Path::to_path_buf));
        let css = self
            .theme_path(base_dir.as_deref())
            .and_then(|theme| self.read_theme(&theme));
        let file_name = file_path
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "document.md".into());
        let export_path = file_path
            .as_ref()
            .map(|p| self.export_path(p, ExportKind::Pdf));
        Ok(LiveDocument {
            markdown,
            css,
            base_dir,
            file_name,
            file_path,
            dirty,
            export_path,
        })
    }

    fn theme_path(&self, base_dir: Option<&Path>) -> Option<PathBuf> {
        let configured = self.config.lock().unwrap().theme_path.clone();
        match configured.filter(|p| !p.trim().is_empty()) {
            Some(path) => {
                let path = PathBuf::from(path);
                if path.is_absolute() {
                    return Some(path);
                }
                let root = self.root.lock().unwrap().clone();
                root.or_else(|| base_dir.map(Path::to_path_buf))
                    .map(|r| r.join(path))
            }
            None => base_dir.map(|dir| dir.join(THEME_FILE)),
        }
    }

    /// Theme CSS, preferring the unsaved contents of an open buffer.
    fn read_theme(&self, path: &Path) -> Option<String> {
        let buffers = self.buffers.lock().unwrap();
        let open = buffers
            .iter()
            .find(|(uri, b)| !b.closed && uri_to_path(uri).is_some_and(|p| same_file(&p, path)));
        match open {
            Some((_, buffer)) => Some(buffer.text.clone()),
            None => std::fs::read_to_string(path).ok(),
        }
        .filter(|css| !css.trim().is_empty())
    }

    fn export_path(&self, source: &Path, kind: ExportKind) -> PathBuf {
        let dir = source.parent().map(Path::to_path_buf).unwrap_or_default();
        let dir = match self.config.lock().unwrap().output_directory.as_deref() {
            Some(out) if !out.trim().is_empty() => dir.join(out),
            _ => dir,
        };
        let stem = source
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "document".into());
        dir.join(format!("{stem}.{}", kind.extension()))
    }

    async fn server(&self) -> anyhow::Result<&Arc<RunningServer>> {
        self.server
            .get_or_try_init(|| async {
                let config = self.config.lock().unwrap().clone();
                let output_dir = self.root.lock().unwrap().clone();
                let server = server::start(ServeOptions {
                    host: "127.0.0.1".into(),
                    port: 0,
                    file: None,
                    css_path: None,
                    output_dir,
                    token: None,
                    open_browser: false,
                    exit_on_stdin_close: false,
                    engine: EngineOptions {
                        chrome_path: config.chrome_path,
                        allow_download: config.allow_browser_download,
                    },
                })
                .await?;
                eprintln!("EasyMarkDoc preview server on {}", server.url);
                Ok(Arc::new(server))
            })
            .await
    }

    /// A buffer changed: update previews showing it, or using it as theme.
    fn changed(&self, uri: &str) {
        let is_css = self
            .buffers
            .lock()
            .unwrap()
            .get(uri)
            .is_some_and(|b| b.language == "css");
        if is_css {
            self.refresh_all();
        } else {
            self.refresh(uri);
        }
    }

    fn refresh_all(&self) {
        let uris: Vec<String> = self.published.lock().unwrap().keys().cloned().collect();
        for uri in uris {
            self.refresh(&uri);
        }
    }

    /// Re-send a previewed document if it changed since the last update.
    fn refresh(&self, uri: &str) {
        let Some(server) = self.server.get() else {
            return;
        };
        if !self.published.lock().unwrap().contains_key(uri) {
            return;
        }
        let Ok(doc) = self.document(uri) else { return };
        let mut published = self.published.lock().unwrap();
        let unchanged = published.get(uri).is_some_and(|last| {
            last.markdown == doc.markdown
                && last.css == doc.css
                && last.dirty == doc.dirty
                && last.export_path == doc.export_path
        });
        if !unchanged {
            server.publish(uri, doc.clone());
            published.insert(uri.to_string(), doc);
        }
    }

    async fn open_preview(&self, uri: &str) -> anyhow::Result<()> {
        let doc = self.document(uri)?;
        let server = self.server().await?;
        server.publish(uri, doc.clone());
        self.published.lock().unwrap().insert(uri.to_string(), doc);
        let mode = self.config.lock().unwrap().preview_mode.clone();
        let url = server.preview_url(uri, mode.as_deref());
        open::that_detached(&url).context("opening the browser")?;
        Ok(())
    }

    async fn export(&self, uri: &str, kind: ExportKind, open_after: bool) -> anyhow::Result<()> {
        let doc = self.document(uri)?;
        let Some(source) = doc.file_path.as_deref() else {
            bail!("save the document before exporting it");
        };
        let target = self.export_path(source, kind);
        let progress = Progress::begin(self, &format!("Exporting {}", kind.label())).await;

        let result = async {
            let bytes = match kind {
                ExportKind::Pdf => {
                    let server = self.server().await?;
                    server
                        .render_pdf(&doc.markdown, doc.css.clone(), doc.base_dir.as_deref())
                        .await?
                }
                ExportKind::Html => document::build(
                    &doc.markdown,
                    &HtmlOptions {
                        css: doc.css.clone(),
                        base_href: doc.base_dir.as_deref().map(document::file_base_href),
                        standalone: true,
                        ..Default::default()
                    },
                )
                .into_bytes(),
            };
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("creating {}", parent.display()))?;
            }
            std::fs::write(&target, bytes).with_context(|| format!("writing {}", target.display()))
        }
        .await;
        progress.end(self).await;
        result?;

        if open_after {
            open::that_detached(&target).context("opening the exported file")?;
            return Ok(());
        }
        let message = format!(
            "EasyMarkDoc: {} saved to {}",
            kind.label(),
            target.display()
        );
        let open_label = format!("Open {}", kind.label());
        let choice = self
            .ask(
                MessageKind::Info,
                &message,
                &[&open_label, "Reveal in Folder"],
            )
            .await;
        match choice.as_deref() {
            Some("Reveal in Folder") => reveal(&target),
            Some(_) => open::that_detached(&target).context("opening the exported file")?,
            None => {}
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum ExportKind {
    Pdf,
    Html,
}

impl ExportKind {
    fn extension(self) -> &'static str {
        match self {
            ExportKind::Pdf => "pdf",
            ExportKind::Html => "html",
        }
    }

    fn label(self) -> &'static str {
        match self {
            ExportKind::Pdf => "PDF",
            ExportKind::Html => "HTML",
        }
    }
}

/// Work-done progress, shown in Zed's status bar.
struct Progress(Option<String>);

impl Progress {
    async fn begin(lsp: &Lsp, title: &str) -> Progress {
        let token = format!(
            "easymarkdoc/{}",
            lsp.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let created =
            lsp.client_request("window/workDoneProgress/create", json!({ "token": token }));
        // Don't hold up the export for a client that never answers.
        if tokio::time::timeout(Duration::from_secs(2), created)
            .await
            .is_err()
        {
            return Progress(None);
        }
        lsp.notify(
            "$/progress",
            json!({ "token": token, "value": { "kind": "begin", "title": title } }),
        );
        Progress(Some(token))
    }

    async fn end(self, lsp: &Lsp) {
        if let Some(token) = self.0 {
            lsp.notify(
                "$/progress",
                json!({ "token": token, "value": { "kind": "end" } }),
            );
        }
    }
}

/// Show a file in the system file manager.
fn reveal(path: &Path) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn();
    #[cfg(windows)]
    let _ = std::process::Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .spawn();
    #[cfg(not(any(target_os = "macos", windows)))]
    if let Some(parent) = path.parent() {
        let _ = open::that_detached(parent);
    }
}

fn same_file(a: &Path, b: &Path) -> bool {
    a == b || matches!((a.canonicalize(), b.canonicalize()), (Ok(a), Ok(b)) if a == b)
}

/// `file:///Users/me/My%20Doc.md` → `/Users/me/My Doc.md`.
fn uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    // Drop an authority ("localhost") if present.
    let rest = &rest[rest.find('/')?..];
    let mut bytes = Vec::with_capacity(rest.len());
    let mut iter = rest.bytes();
    while let Some(b) = iter.next() {
        if b == b'%' {
            let hex: Vec<u8> = iter.by_ref().take(2).collect();
            let value = std::str::from_utf8(&hex)
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())?;
            bytes.push(value);
        } else {
            bytes.push(b);
        }
    }
    let path = String::from_utf8(bytes).ok()?;
    // Windows: "/C:/Users/..." → "C:/Users/...".
    #[cfg(windows)]
    let path = match path.as_bytes() {
        [b'/', drive, b':', ..] if drive.is_ascii_alphabetic() => path[1..].to_string(),
        _ => path,
    };
    Some(PathBuf::from(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_file_uris() {
        assert_eq!(
            uri_to_path("file:///Users/me/My%20Doc.md"),
            Some(PathBuf::from("/Users/me/My Doc.md"))
        );
        assert_eq!(
            uri_to_path("file://localhost/tmp/a.md"),
            Some(PathBuf::from("/tmp/a.md"))
        );
        assert_eq!(uri_to_path("untitled:Untitled-1"), None);
    }

    #[test]
    fn reads_framed_messages() {
        let input = b"Content-Length: 17\r\n\r\n{\"jsonrpc\":\"2.0\"}";
        let message = read_message(&mut &input[..]).unwrap().unwrap();
        assert_eq!(message["jsonrpc"], "2.0");
        assert!(read_message(&mut &b""[..]).unwrap().is_none());
    }

    #[test]
    fn config_accepts_both_spellings() {
        let config =
            Config::from_value(&json!({ "easymarkdoc": { "outputDirectory": "out" } })).unwrap();
        assert_eq!(config.output_directory.as_deref(), Some("out"));
        assert!(config.allow_browser_download);
        let config = Config::from_value(&json!({ "theme_path": "t.css" })).unwrap();
        assert_eq!(config.theme_path.as_deref(), Some("t.css"));
    }
}
