//! HTML → PDF rendering using a headless Chromium-based browser over the
//! Chrome DevTools Protocol.
//!
//! A browser is located in this order:
//! 1. an explicit path (`--chrome` / `EngineOptions::chrome_path`)
//! 2. the `EASYMARKDOC_CHROME` environment variable
//! 3. a copy of chrome-headless-shell previously downloaded by EasyMarkDoc
//! 4. an installed Chrome, Chromium, Edge, Brave or Vivaldi
//! 5. downloading chrome-headless-shell (if allowed)

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use chromiumoxide::cdp::browser_protocol::page::PrintToPdfParams;
use chromiumoxide::cdp::js_protocol::runtime::EvaluateParams;
use chromiumoxide::fetcher::{BrowserFetcher, BrowserFetcherOptions, BrowserKind};
use chromiumoxide::{Browser, BrowserConfig};
use futures::StreamExt;
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;

const RENDER_TIMEOUT: Duration = Duration::from_secs(60);

/// How to find (or obtain) a browser.
#[derive(Debug, Clone)]
pub struct EngineOptions {
    pub chrome_path: Option<PathBuf>,
    /// Download chrome-headless-shell if no browser is found.
    pub allow_download: bool,
}

impl Default for EngineOptions {
    fn default() -> Self {
        Self {
            chrome_path: None,
            allow_download: true,
        }
    }
}

/// A running headless browser that renders HTML documents to PDF.
pub struct PdfEngine {
    browser: Browser,
    handler: JoinHandle<()>,
    executable: PathBuf,
    work_dir: PathBuf,
    counter: AtomicU64,
    permits: Semaphore,
}

impl PdfEngine {
    /// Locate a browser and launch it headless.
    pub async fn launch(options: &EngineOptions) -> Result<Self> {
        let executable = resolve_browser(options).await?;
        let work_dir = std::env::temp_dir().join(format!(
            "easymarkdoc-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        std::fs::create_dir_all(&work_dir)
            .with_context(|| format!("creating {}", work_dir.display()))?;

        let config = BrowserConfig::builder()
            .chrome_executable(&executable)
            .user_data_dir(work_dir.join("profile"))
            .arg("--allow-file-access-from-files")
            .arg("--disable-background-networking")
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .launch_timeout(Duration::from_secs(30))
            .request_timeout(RENDER_TIMEOUT)
            .build()
            .map_err(|e| anyhow!(e))?;

        let (browser, mut handler) = Browser::launch(config)
            .await
            .with_context(|| format!("launching browser at {}", executable.display()))?;
        let handler = tokio::spawn(async move {
            while let Some(event) = handler.next().await {
                if event.is_err() {
                    // Individual protocol errors are not fatal; keep pumping
                    // until the connection closes.
                    continue;
                }
            }
        });

        Ok(Self {
            browser,
            handler,
            executable,
            work_dir,
            counter: AtomicU64::new(0),
            permits: Semaphore::new(4),
        })
    }

    /// Path of the browser executable in use.
    pub fn executable(&self) -> &Path {
        &self.executable
    }

    /// Whether the browser connection is still alive.
    pub fn is_alive(&self) -> bool {
        !self.handler.is_finished()
    }

    /// Render a complete HTML document to PDF bytes. Relative URLs are
    /// resolved against the document's `<base href>`, if any.
    pub async fn render(&self, html: &str) -> Result<Vec<u8>> {
        let _permit = self.permits.acquire().await?;
        tokio::time::timeout(RENDER_TIMEOUT, self.render_inner(html))
            .await
            .map_err(|_| anyhow!("timed out rendering PDF"))?
    }

    async fn render_inner(&self, html: &str) -> Result<Vec<u8>> {
        let id = self.counter.fetch_add(1, Ordering::Relaxed);
        let path = self.work_dir.join(format!("document-{id}.html"));
        tokio::fs::write(&path, html).await?;
        let url = format!(
            "file://{}",
            crate::document::percent_encode_path(&path.to_string_lossy().replace('\\', "/"))
        );
        let url = if url.starts_with("file:///") {
            url
        } else {
            url.replacen("file://", "file:///", 1)
        };

        let result = async {
            let page = self.browser.new_page("about:blank").await?;
            let outcome = async {
                page.goto(url.as_str()).await?;
                // Wait for web fonts to finish loading before printing.
                let wait_fonts = EvaluateParams::builder()
                    .expression("document.fonts.ready.then(() => true)")
                    .await_promise(true)
                    .build()
                    .map_err(|e| anyhow!(e))?;
                page.evaluate_expression(wait_fonts).await?;

                let params = PrintToPdfParams {
                    print_background: Some(true),
                    prefer_css_page_size: Some(true),
                    generate_document_outline: Some(true),
                    generate_tagged_pdf: Some(true),
                    margin_top: Some(0.0),
                    margin_bottom: Some(0.0),
                    margin_left: Some(0.0),
                    margin_right: Some(0.0),
                    ..Default::default()
                };
                Ok::<_, anyhow::Error>(page.pdf(params).await?)
            }
            .await;
            let _ = page.close().await;
            outcome
        }
        .await;

        let _ = tokio::fs::remove_file(&path).await;
        result
    }

    /// Shut the browser down and clean up temporary files.
    pub async fn close(mut self) {
        let _ = self.browser.close().await;
        let _ = self.browser.wait().await;
        self.handler.abort();
        let _ = std::fs::remove_dir_all(&self.work_dir);
    }
}

impl Drop for PdfEngine {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.work_dir);
    }
}

/// Directory where EasyMarkDoc caches a downloaded browser.
pub fn browser_cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("easymarkdoc")
        .join("browser")
}

async fn resolve_browser(options: &EngineOptions) -> Result<PathBuf> {
    if let Some(path) = &options.chrome_path {
        if path.exists() {
            return Ok(path.clone());
        }
        bail!("browser not found at {}", path.display());
    }
    if let Some(found) = find_browser() {
        return Ok(found);
    }
    if options.allow_download {
        eprintln!(
            "No Chromium-based browser found. Downloading chrome-headless-shell to {} (one-time)...",
            browser_cache_dir().display()
        );
        return download_browser().await;
    }
    bail!(
        "No Chromium-based browser found. Install Google Chrome, Chromium or Microsoft Edge, \
         set EASYMARKDOC_CHROME, pass --chrome <path>, or run `EasyMarkDoc setup` to download one."
    )
}

/// Find a usable browser without downloading anything.
pub fn find_browser() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("EASYMARKDOC_CHROME") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Some(path);
        }
    }
    if let Some(cached) = cached_browser() {
        return Some(cached);
    }
    installed_browsers().into_iter().find(|p| p.exists())
}

/// Download chrome-headless-shell into the cache directory.
pub async fn download_browser() -> Result<PathBuf> {
    let dir = browser_cache_dir();
    tokio::fs::create_dir_all(&dir).await?;
    let fetcher = BrowserFetcher::new(
        BrowserFetcherOptions::builder()
            .with_kind(BrowserKind::ChromeHeadlessShell)
            .with_path(&dir)
            .build()?,
    );
    let installation = fetcher
        .fetch()
        .await
        .context("downloading chrome-headless-shell")?;
    Ok(installation.executable_path)
}

fn headless_shell_name() -> &'static str {
    if cfg!(windows) {
        "chrome-headless-shell.exe"
    } else {
        "chrome-headless-shell"
    }
}

/// Look for a previously downloaded chrome-headless-shell (newest first).
fn cached_browser() -> Option<PathBuf> {
    let mut found = Vec::new();
    find_files(&browser_cache_dir(), headless_shell_name(), 4, &mut found);
    found.sort();
    found.pop()
}

fn find_files(dir: &Path, name: &str, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth > 0 {
                find_files(&path, name, depth - 1, out);
            }
        } else if path.file_name().is_some_and(|n| n == name) {
            out.push(path);
        }
    }
}

fn installed_browsers() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if cfg!(target_os = "macos") {
        let apps = [
            "Google Chrome.app/Contents/MacOS/Google Chrome",
            "Chromium.app/Contents/MacOS/Chromium",
            "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "Brave Browser.app/Contents/MacOS/Brave Browser",
            "Vivaldi.app/Contents/MacOS/Vivaldi",
            "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
            "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ];
        let mut roots = vec![PathBuf::from("/Applications")];
        if let Some(home) = dirs::home_dir() {
            roots.push(home.join("Applications"));
        }
        for root in &roots {
            for app in apps {
                candidates.push(root.join(app));
            }
        }
    } else if cfg!(windows) {
        let suffixes = [
            r"Google\Chrome\Application\chrome.exe",
            r"Microsoft\Edge\Application\msedge.exe",
            r"BraveSoftware\Brave-Browser\Application\brave.exe",
            r"Chromium\Application\chrome.exe",
        ];
        for var in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
            if let Ok(root) = std::env::var(var) {
                for suffix in suffixes {
                    candidates.push(Path::new(&root).join(suffix));
                }
            }
        }
    } else {
        let names = [
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
            "microsoft-edge",
            "microsoft-edge-stable",
            "brave-browser",
            "chrome-headless-shell",
            "chrome",
        ];
        if let Some(path_var) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path_var) {
                for name in names {
                    candidates.push(dir.join(name));
                }
            }
        }
        candidates.push(PathBuf::from("/snap/bin/chromium"));
    }
    candidates
}
