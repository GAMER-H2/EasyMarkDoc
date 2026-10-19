//! Local web server powering the browser editor and the VS Code preview.
//!
//! Every `/api` request must carry the session token in the
//! `X-EasyMarkDoc-Token` header. Combined with binding to localhost this
//! stops other websites from driving the server (the custom header forces a
//! CORS preflight, which is never approved).

use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use anyhow::Context;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::document::{self, HtmlOptions};
use crate::highlight;
use crate::pdf::{EngineOptions, PdfEngine};
use crate::theme;

#[derive(RustEmbed)]
#[folder = "web/"]
struct Assets;

const TOKEN_HEADER: &str = "x-easymarkdoc-token";

/// Configuration for `EasyMarkDoc serve`.
#[derive(Debug, Clone)]
pub struct ServeOptions {
    pub host: String,
    pub port: u16,
    pub file: Option<PathBuf>,
    pub css_path: Option<PathBuf>,
    pub output_dir: Option<PathBuf>,
    pub token: Option<String>,
    pub open_browser: bool,
    pub exit_on_stdin_close: bool,
    pub engine: EngineOptions,
}

struct AppState {
    token: String,
    engine_options: EngineOptions,
    engine: Mutex<Option<Arc<PdfEngine>>>,
    initial_file: Option<PathBuf>,
    initial_css_path: Option<PathBuf>,
    output_dir: PathBuf,
    /// Directories the preview may load local files (images, fonts) from.
    allowed_dirs: RwLock<HashSet<PathBuf>>,
}

type Shared = Arc<AppState>;

pub async fn serve(options: ServeOptions) -> anyhow::Result<()> {
    let token = options
        .token
        .clone()
        .or_else(|| std::env::var("EASYMARKDOC_TOKEN").ok())
        .unwrap_or_else(random_token);

    let cwd = std::env::current_dir()?;
    let file = options.file.as_ref().map(|f| absolute(f, &cwd));
    let base_dir = file
        .as_ref()
        .and_then(|f| f.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| cwd.clone());
    let css_path = options
        .css_path
        .as_ref()
        .map(|c| absolute(c, &cwd))
        .or_else(|| discover_theme(&base_dir));
    let output_dir = options
        .output_dir
        .as_ref()
        .map(|d| absolute(d, &cwd))
        .unwrap_or_else(|| base_dir.clone());

    let mut allowed = HashSet::new();
    allowed.insert(canonical(&base_dir));

    let state = Arc::new(AppState {
        token: token.clone(),
        engine_options: options.engine.clone(),
        engine: Mutex::new(None),
        initial_file: file,
        initial_css_path: css_path,
        output_dir,
        allowed_dirs: RwLock::new(allowed),
    });

    // Start the browser in the background so the first preview is quick.
    {
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = get_engine(&state).await {
                eprintln!("Warning: PDF engine unavailable: {e:#}");
            }
        });
    }

    let app = Router::new()
        .route("/", get(index))
        .route("/preview", get(preview_page))
        .route("/assets/{*path}", get(asset))
        .route("/files/{token}/{*path}", get(local_file))
        .route("/api/state", get(api_state))
        .route("/api/render", post(api_render))
        .route("/api/save", post(api_save))
        .route("/api/browse", get(api_browse))
        .route("/api/open", post(api_open))
        .with_state(state.clone());

    let addr: SocketAddr = format!("{}:{}", options.host, options.port).parse()?;
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(_) if options.port != 0 => {
            let fallback: SocketAddr = format!("{}:0", options.host).parse()?;
            tokio::net::TcpListener::bind(fallback).await?
        }
        Err(e) => return Err(e.into()),
    };
    let local = listener.local_addr()?;
    let url = format!("http://{}:{}/", display_host(&options.host), local.port());
    // The VS Code extension parses this line to find the port.
    println!("EasyMarkDoc server listening on {url}");
    eprintln!("Press Ctrl+C to stop.");

    if options.open_browser {
        let _ = open::that(&url);
    }

    let shutdown_state = state.clone();
    let exit_on_stdin = options.exit_on_stdin_close;
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal(exit_on_stdin).await;
            if let Some(engine) = shutdown_state.engine.lock().await.take()
                && let Ok(engine) = Arc::try_unwrap(engine)
            {
                engine.close().await;
            }
        })
        .await?;
    Ok(())
}

async fn shutdown_signal(exit_on_stdin_close: bool) {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    let stdin_closed = async {
        if exit_on_stdin_close {
            // Block on stdin in a thread; EOF means our parent went away.
            let _ = tokio::task::spawn_blocking(|| {
                let mut buf = [0u8; 256];
                use std::io::Read;
                let mut stdin = std::io::stdin();
                while let Ok(n) = stdin.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                }
            })
            .await;
        } else {
            std::future::pending::<()>().await;
        }
    };

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
        _ = stdin_closed => {},
    }
}

fn random_token() -> String {
    (0..32)
        .map(|_| format!("{:x}", rand::random::<u8>() & 0xf))
        .collect()
}

fn display_host(host: &str) -> &str {
    if host == "0.0.0.0" { "127.0.0.1" } else { host }
}

fn absolute(path: &Path, cwd: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    }
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Look for a theme next to the document: `easymarkdoc.css`.
pub fn discover_theme(dir: &Path) -> Option<PathBuf> {
    let candidate = dir.join("easymarkdoc.css");
    candidate.is_file().then_some(candidate)
}

async fn get_engine(state: &AppState) -> anyhow::Result<Arc<PdfEngine>> {
    let mut guard = state.engine.lock().await;
    if let Some(engine) = guard.as_ref()
        && engine.is_alive()
    {
        return Ok(engine.clone());
    }
    let engine = Arc::new(PdfEngine::launch(&state.engine_options).await?);
    eprintln!("PDF engine: {}", engine.executable().display());
    *guard = Some(engine.clone());
    Ok(engine)
}

// ---------------------------------------------------------------------------
// Errors and auth
// ---------------------------------------------------------------------------

struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({ "error": self.1 }))).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}"))
    }
}

impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    }
}

fn bad_request(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}

fn check_token(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let ok = headers
        .get(TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| constant_time_eq(t.as_bytes(), state.token.as_bytes()));
    if ok {
        Ok(())
    } else {
        Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "invalid or missing token".into(),
        ))
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ---------------------------------------------------------------------------
// Static pages and assets
// ---------------------------------------------------------------------------

fn page_with_token(name: &str, token: &str) -> Response {
    match Assets::get(name) {
        Some(file) => {
            let html = String::from_utf8_lossy(&file.data).replace("__EMD_TOKEN__", token);
            (
                [
                    (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                    (header::CACHE_CONTROL, "no-store"),
                ],
                html,
            )
                .into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn index(State(state): State<Shared>) -> Response {
    page_with_token("index.html", &state.token)
}

async fn preview_page(State(state): State<Shared>) -> Response {
    page_with_token("preview.html", &state.token)
}

async fn asset(AxumPath(path): AxumPath<String>) -> Response {
    match Assets::get(&path) {
        Some(file) => {
            let mime = mime_guess::from_path(&path).first_or_octet_stream();
            let mime = if path.ends_with(".mjs") {
                "text/javascript".to_string()
            } else {
                mime.to_string()
            };
            ([(header::CONTENT_TYPE, mime)], file.data.into_owned()).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Serve local files (images, fonts) referenced by the document in the HTML
/// preview. Only files inside directories registered as document base
/// directories are served.
async fn local_file(
    State(state): State<Shared>,
    AxumPath((token, path)): AxumPath<(String, String)>,
) -> Response {
    if !constant_time_eq(token.as_bytes(), state.token.as_bytes()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let requested = PathBuf::from(format!("/{}", path.trim_start_matches('/')));
    #[cfg(windows)]
    let requested = PathBuf::from(path.trim_start_matches('/'));
    let Ok(real) = requested.canonicalize() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let allowed = state
        .allowed_dirs
        .read()
        .unwrap()
        .iter()
        .any(|dir| real.starts_with(dir));
    if !allowed || !real.is_file() {
        return StatusCode::NOT_FOUND.into_response();
    }
    match tokio::fs::read(&real).await {
        Ok(bytes) => {
            let mime = mime_guess::from_path(&real).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.to_string())], bytes).into_response()
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct StateResponse {
    markdown: Option<String>,
    file_path: Option<String>,
    file_name: Option<String>,
    css: Option<String>,
    css_path: Option<String>,
    base_dir: String,
    output_dir: String,
    default_css: &'static str,
    code_themes: Vec<(&'static str, &'static str)>,
    browser: Option<String>,
    path_separator: char,
}

async fn api_state(
    State(state): State<Shared>,
    headers: HeaderMap,
) -> Result<Json<StateResponse>, ApiError> {
    check_token(&state, &headers)?;
    let markdown = match &state.initial_file {
        Some(f) if f.exists() => Some(tokio::fs::read_to_string(f).await?),
        _ => None,
    };
    let css = match &state.initial_css_path {
        Some(p) => tokio::fs::read_to_string(p).await.ok(),
        None => None,
    };
    let base_dir = state
        .initial_file
        .as_ref()
        .and_then(|f| f.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| state.output_dir.clone());
    let browser = state
        .engine
        .lock()
        .await
        .as_ref()
        .map(|e| e.executable().display().to_string());

    Ok(Json(StateResponse {
        markdown,
        file_path: state.initial_file.as_ref().map(|f| f.display().to_string()),
        file_name: state
            .initial_file
            .as_ref()
            .and_then(|f| f.file_name())
            .map(|n| n.to_string_lossy().to_string()),
        css,
        css_path: state
            .initial_css_path
            .as_ref()
            .map(|p| p.display().to_string()),
        base_dir: base_dir.display().to_string(),
        output_dir: state.output_dir.display().to_string(),
        default_css: theme::DEFAULT_CSS,
        code_themes: highlight::CODE_THEMES.to_vec(),
        browser,
        path_separator: std::path::MAIN_SEPARATOR,
    }))
}

#[derive(Deserialize)]
struct RenderRequest {
    markdown: String,
    #[serde(default)]
    css: Option<String>,
    #[serde(default)]
    base_dir: Option<String>,
    /// "pdf" (default), "html" (plain document) or "paged" (paginated preview)
    #[serde(default)]
    format: Option<String>,
}

fn register_base_dir(state: &AppState, base_dir: &Option<String>) -> Option<PathBuf> {
    let dir = PathBuf::from(base_dir.as_ref()?);
    if !dir.is_dir() {
        return None;
    }
    let canon = canonical(&dir);
    state.allowed_dirs.write().unwrap().insert(canon.clone());
    Some(canon)
}

const PAGED_HEAD: &str = r#"<script>
window.PagedConfig = {
  auto: true,
  after: function () {
    if (window.frameElement) window.frameElement.dispatchEvent(new CustomEvent("paged"));
  }
};
</script>
<script src="/assets/vendor/pagedjs/paged.polyfill.min.js"></script>
<style>
@media screen {
  html, body { background: transparent !important; }
  .pagedjs_pages { display: flex; flex-direction: column; align-items: center; padding: 16px 0; }
  .pagedjs_page { box-shadow: 0 2px 12px rgba(0,0,0,.18); margin-bottom: 16px; }
}
</style>"#;

async fn api_render(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(req): Json<RenderRequest>,
) -> Result<Response, ApiError> {
    check_token(&state, &headers)?;
    let base_dir = register_base_dir(&state, &req.base_dir);
    let css = req.css.filter(|c| !c.trim().is_empty());

    match req.format.as_deref().unwrap_or("pdf") {
        "pdf" => {
            let pdf = render_pdf_bytes(&state, &req.markdown, css, base_dir.as_deref()).await?;
            Ok(([(header::CONTENT_TYPE, "application/pdf")], pdf).into_response())
        }
        format @ ("html" | "paged") => {
            let base_href = base_dir.as_ref().map(|dir| {
                let mut path = dir.to_string_lossy().replace('\\', "/");
                if !path.ends_with('/') {
                    path.push('/');
                }
                format!(
                    "/files/{}/{}",
                    state.token,
                    document::percent_encode_path(path.trim_start_matches('/'))
                )
            });
            let options = HtmlOptions {
                css,
                base_href,
                extra_head: (format == "paged").then(|| PAGED_HEAD.to_string()),
                ..Default::default()
            };
            let html = document::build(&req.markdown, &options);
            Ok(([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response())
        }
        other => Err(bad_request(format!("unknown format '{other}'"))),
    }
}

async fn render_pdf_bytes(
    state: &AppState,
    markdown: &str,
    css: Option<String>,
    base_dir: Option<&Path>,
) -> anyhow::Result<Vec<u8>> {
    let options = HtmlOptions {
        css,
        base_href: base_dir.map(document::file_base_href),
        ..Default::default()
    };
    let html = document::build(markdown, &options);
    let engine = get_engine(state).await?;
    match engine.render(&html).await {
        Ok(pdf) => Ok(pdf),
        Err(e) if !engine.is_alive() => {
            // The browser died (crash, sleep/wake...): restart once and retry.
            eprintln!("PDF engine stopped ({e:#}); restarting");
            let engine = get_engine(state).await?;
            engine.render(&html).await
        }
        Err(e) => Err(e),
    }
}

#[derive(Deserialize)]
struct SaveRequest {
    directory: String,
    filename: String,
    /// "pdf", "markdown", "css" or "html"
    kind: String,
    #[serde(default)]
    markdown: String,
    #[serde(default)]
    css: Option<String>,
    #[serde(default)]
    base_dir: Option<String>,
    #[serde(default)]
    overwrite: bool,
}

#[derive(Serialize)]
struct SaveResponse {
    path: String,
}

async fn api_save(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(req): Json<SaveRequest>,
) -> Result<Json<SaveResponse>, ApiError> {
    check_token(&state, &headers)?;
    let dir = PathBuf::from(&req.directory);
    if !dir.is_dir() {
        return Err(bad_request(format!(
            "'{}' is not a directory",
            req.directory
        )));
    }
    let name = req.filename.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err(bad_request("invalid file name"));
    }
    let extension = match req.kind.as_str() {
        "pdf" => "pdf",
        "markdown" => "md",
        "css" => "css",
        "html" => "html",
        other => return Err(bad_request(format!("unknown kind '{other}'"))),
    };
    let mut path = dir.join(name);
    let has_extension = path.extension().is_some_and(|e| {
        e.eq_ignore_ascii_case(extension)
            || (extension == "md" && e.eq_ignore_ascii_case("markdown"))
    });
    if !has_extension {
        path = dir.join(format!("{name}.{extension}"));
    }
    if path.exists() && !req.overwrite {
        return Err(ApiError(
            StatusCode::CONFLICT,
            format!("{} already exists", path.display()),
        ));
    }

    let base_dir = register_base_dir(&state, &req.base_dir);
    let css = req.css.filter(|c| !c.trim().is_empty());
    let bytes: Vec<u8> = match req.kind.as_str() {
        "pdf" => render_pdf_bytes(&state, &req.markdown, css, base_dir.as_deref()).await?,
        "markdown" => req.markdown.into_bytes(),
        "css" => css.unwrap_or_default().into_bytes(),
        _ => document::build(
            &req.markdown,
            &HtmlOptions {
                css,
                base_href: base_dir.as_deref().map(document::file_base_href),
                standalone: true,
                ..Default::default()
            },
        )
        .into_bytes(),
    };
    tokio::fs::write(&path, bytes)
        .await
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(Json(SaveResponse {
        path: path.display().to_string(),
    }))
}

#[derive(Deserialize)]
struct BrowseQuery {
    path: Option<String>,
    /// Comma-separated list of file extensions to include (e.g. "md,markdown").
    files: Option<String>,
}

#[derive(Serialize)]
struct BrowseResponse {
    path: String,
    parent: Option<String>,
    dirs: Vec<String>,
    files: Vec<String>,
    home: Option<String>,
}

/// List a directory for the folder/file picker.
async fn api_browse(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<BrowseQuery>,
) -> Result<Json<BrowseResponse>, ApiError> {
    check_token(&state, &headers)?;
    let path = q
        .path
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| state.output_dir.clone());
    let path = canonical(&path);
    let extensions: Vec<String> = q
        .files
        .map(|f| {
            f.split(',')
                .map(|e| e.trim().to_ascii_lowercase())
                .collect()
        })
        .unwrap_or_default();

    let mut dirs = Vec::new();
    let mut files = Vec::new();
    let mut entries = tokio::fs::read_dir(&path)
        .await
        .map_err(|e| bad_request(format!("{}: {e}", path.display())))?;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type().await?;
        let is_dir = file_type.is_dir() || (file_type.is_symlink() && entry.path().is_dir());
        if is_dir {
            dirs.push(name);
        } else if !extensions.is_empty() {
            let ext = Path::new(&name)
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if extensions.contains(&ext) {
                files.push(name);
            }
        }
    }
    dirs.sort_by_key(|d| d.to_lowercase());
    files.sort_by_key(|f| f.to_lowercase());

    Ok(Json(BrowseResponse {
        parent: path.parent().map(|p| p.display().to_string()),
        path: path.display().to_string(),
        dirs,
        files,
        home: dirs::home_dir().map(|h| h.display().to_string()),
    }))
}

#[derive(Deserialize)]
struct OpenRequest {
    path: String,
}

#[derive(Serialize)]
struct OpenResponse {
    path: String,
    name: String,
    directory: String,
    content: String,
    /// Contents of `easymarkdoc.css` next to an opened Markdown file.
    theme: Option<String>,
    theme_path: Option<String>,
}

/// Read a Markdown or CSS file from disk (used by "Open from disk").
async fn api_open(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(req): Json<OpenRequest>,
) -> Result<Json<OpenResponse>, ApiError> {
    check_token(&state, &headers)?;
    let path = PathBuf::from(&req.path);
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if !matches!(ext.as_str(), "md" | "markdown" | "mdown" | "txt" | "css") {
        return Err(bad_request(
            "only Markdown, text and CSS files can be opened",
        ));
    }
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| bad_request(format!("{}: {e}", path.display())))?;
    let directory = path
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let mut theme_path = None;
    let mut theme = None;
    if ext != "css" {
        register_base_dir(&state, &Some(directory.clone()));
        if let Some(found) = path.parent().and_then(discover_theme) {
            theme = tokio::fs::read_to_string(&found).await.ok();
            theme_path = Some(found.display().to_string());
        }
    }
    Ok(Json(OpenResponse {
        theme,
        theme_path,
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        path: path.display().to_string(),
        directory,
        content,
    }))
}
