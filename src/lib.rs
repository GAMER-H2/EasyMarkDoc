//! EasyMarkDoc: convert Markdown into styled PDF documents.
//!
//! Markdown is rendered to HTML by a built-in parser, styled with a CSS theme,
//! and printed to PDF by a headless Chromium-based browser.

pub mod document;
pub mod highlight;
pub mod markdown;
pub mod pdf;
pub mod server;
pub mod theme;

pub use document::{HtmlOptions, build as build_html};
pub use pdf::{EngineOptions, PdfEngine};

use std::path::Path;

/// Convert Markdown to a complete HTML document using the default theme.
pub fn document_builder(md_text: String) -> String {
    document::build(&md_text, &HtmlOptions::default())
}

/// Render Markdown to PDF bytes. `base_dir` is used to resolve relative
/// image paths and links.
pub async fn render_pdf(
    engine: &PdfEngine,
    markdown_text: &str,
    css: Option<&str>,
    base_dir: Option<&Path>,
) -> anyhow::Result<Vec<u8>> {
    let options = HtmlOptions {
        css: css.map(str::to_string),
        base_href: base_dir.map(document::file_base_href),
        ..Default::default()
    };
    let html = document::build(markdown_text, &options);
    engine.render(&html).await
}

/// Convenience blocking API: convert Markdown text to a PDF file using the
/// default theme and an automatically located browser.
pub fn markdown_to_pdf(md_text: &str, pdf_path: &str) -> anyhow::Result<()> {
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(async {
        let engine = PdfEngine::launch(&EngineOptions::default()).await?;
        let base = Path::new(pdf_path).parent().map(Path::to_path_buf);
        let result = render_pdf(&engine, md_text, None, base.as_deref()).await;
        engine.close().await;
        std::fs::write(pdf_path, result?)?;
        Ok(())
    })
}
