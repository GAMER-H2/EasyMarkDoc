//! Assemble a complete, styled HTML document from Markdown.

use crate::markdown::{self, escape_attr, escape_html};
use crate::theme;

/// Options for building an HTML document.
#[derive(Debug, Clone, Default)]
pub struct HtmlOptions {
    /// Custom theme CSS layered on top of the default theme.
    pub css: Option<String>,
    /// Base URL used to resolve relative links and images.
    pub base_href: Option<String>,
    /// Document title; defaults to the first level-1 heading.
    pub title: Option<String>,
    /// Add on-screen page styling for viewing the HTML file in a browser.
    pub standalone: bool,
    /// Extra markup injected at the end of `<head>`.
    pub extra_head: Option<String>,
}

/// Render Markdown into a complete HTML document.
pub fn build(markdown_text: &str, options: &HtmlOptions) -> String {
    let rendered = markdown::render(markdown_text);
    let title = options
        .title
        .clone()
        .or(rendered.title)
        .unwrap_or_else(|| "Document".to_string());
    let css = theme::stylesheet(options.css.as_deref(), &title);

    let mut html = String::with_capacity(rendered.html.len() + css.len() + 512);
    html.push_str("<!DOCTYPE html>\n");
    if options.standalone {
        html.push_str("<html lang=\"en\" class=\"emd-standalone\">\n");
    } else {
        html.push_str("<html lang=\"en\">\n");
    }
    html.push_str("<head>\n<meta charset=\"utf-8\" />\n");
    html.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n");
    html.push_str(&format!("<title>{}</title>\n", escape_html(&title)));
    if let Some(base) = &options.base_href {
        html.push_str(&format!("<base href=\"{}\" />\n", escape_attr(base)));
    }
    html.push_str("<style>\n");
    html.push_str(&css);
    html.push_str("</style>\n");
    if let Some(extra) = &options.extra_head {
        html.push_str(extra);
        html.push('\n');
    }
    html.push_str("</head>\n<body>\n<article class=\"markdown-body\">\n");
    html.push_str(&rendered.html);
    html.push_str("</article>\n</body>\n</html>\n");
    html
}

/// Convert a filesystem directory into a `file://` URL suitable for `<base>`.
pub fn file_base_href(dir: &std::path::Path) -> String {
    let mut path = dir.to_string_lossy().replace('\\', "/");
    if !path.starts_with('/') {
        path.insert(0, '/');
    }
    if !path.ends_with('/') {
        path.push('/');
    }
    format!("file://{}", percent_encode_path(&path))
}

/// Percent-encode a path for use in a URL, leaving `/` intact.
pub fn percent_encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for b in path.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' | b':' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_full_document() {
        let html = build(
            "# Hello\n\nWorld",
            &HtmlOptions {
                base_href: Some("file:///tmp/".into()),
                ..Default::default()
            },
        );
        assert!(html.contains("<title>Hello</title>"));
        assert!(html.contains("<base href=\"file:///tmp/\" />"));
        assert!(html.contains("@page"));
        assert!(html.contains("<p>World</p>"));
    }

    #[test]
    fn file_urls_are_encoded() {
        let href = file_base_href(std::path::Path::new("/Users/me/My Docs"));
        assert_eq!(href, "file:///Users/me/My%20Docs/");
    }
}
