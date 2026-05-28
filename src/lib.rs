use std::io::Cursor;
use std::sync::OnceLock;

use syntect::highlighting::Theme;
use syntect::html::{ClassStyle, ClassedHTMLGenerator, css_for_theme_with_class_style};
use syntect::parsing::{SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;
use wasm_bindgen::prelude::*;

#[cfg(not(target_arch = "wasm32"))]
use genpdf::elements::{Break, OrderedList, Paragraph, UnorderedList};
#[cfg(not(target_arch = "wasm32"))]
use genpdf::fonts::{FontData, FontFamily};
#[cfg(not(target_arch = "wasm32"))]
use genpdf::style::{Color, Style};
#[cfg(not(target_arch = "wasm32"))]
use genpdf::{Document, Element, SimplePageDecorator};
#[cfg(not(target_arch = "wasm32"))]
use std::fs::File;
#[cfg(not(target_arch = "wasm32"))]
use std::io::BufWriter;

const DRACULA_THEME: &str = include_str!("dracula.tmTheme");
const SYNTAX_CLASS_PREFIX: &str = "syntax-";

#[cfg(not(target_arch = "wasm32"))]
const FONT_REGULAR: &[u8] = include_bytes!("Roboto-Regular.ttf");
#[cfg(not(target_arch = "wasm32"))]
const FONT_BOLD: &[u8] = include_bytes!("Roboto-Bold.ttf");

static SYNTAX_SET: OnceLock<SyntaxSet> = OnceLock::new();
static SYNTAX_THEME: OnceLock<Theme> = OnceLock::new();
static SYNTAX_CSS: OnceLock<String> = OnceLock::new();

pub fn document_builder(md_text: String) -> String {
    let mut html_text = String::new();
    html_text.push_str("<!DOCTYPE html>\n<html>\n<head>\n<title>Document</title>\n");
    html_text.push_str("<style>\n");
    html_text.push_str(get_css().as_str());
    html_text.push_str("\n</style>\n");
    html_text.push_str("</head>\n<body>\n");
    let mut in_paragraph = false;
    let mut in_list = false;

    let mut in_code_block = false;
    let mut code_fence_char: char = '`';
    let mut code_fence_len: usize = 0;
    let mut code_lang: Option<String> = None;
    let mut code_block_buffer = String::new();

    for line in md_text.lines() {
        let trimmed = line.trim();

        if !in_code_block {
            if !trimmed.is_empty() && (trimmed.starts_with("```") || trimmed.starts_with("~~~")) {
                let fence_char = trimmed.chars().next().unwrap();
                let fence_len = trimmed.chars().take_while(|&c| c == fence_char).count();
                if fence_len >= 3 {
                    if in_paragraph {
                        html_text.push_str("</p>\n");
                        in_paragraph = false;
                    }
                    if in_list {
                        html_text.push_str("</ul>\n");
                        in_list = false;
                    }

                    in_code_block = true;
                    code_fence_char = fence_char;
                    code_fence_len = fence_len;
                    code_lang = extract_code_language(&trimmed[fence_len..]);
                    code_block_buffer.clear();
                    continue;
                }
            }
        } else {
            if !trimmed.is_empty() {
                let closing_count = trimmed
                    .chars()
                    .take_while(|&c| c == code_fence_char)
                    .count();
                let rest_ok = trimmed
                    .chars()
                    .skip(closing_count)
                    .all(|c| c.is_whitespace());
                if closing_count >= code_fence_len && rest_ok {
                    html_text.push_str(
                        render_code_block(&code_block_buffer, code_lang.as_deref()).as_str(),
                    );
                    in_code_block = false;
                    code_fence_len = 0;
                    code_lang = None;
                    code_block_buffer.clear();
                    continue;
                }
            }

            code_block_buffer.push_str(line);
            code_block_buffer.push('\n');
            continue;
        }

        if trimmed.is_empty() {
            if in_paragraph {
                html_text.push_str("</p>\n");
                in_paragraph = false;
            }
            if in_list {
                html_text.push_str("</ul>\n");
                in_list = false;
            }
            continue;
        }

        if in_paragraph {
            html_text.push_str("</p>\n");
            in_paragraph = false;
        }

        let (tag, content) = if let Some(rest) = trimmed.strip_prefix("###### ") {
            ("h6", rest)
        } else if let Some(rest) = trimmed.strip_prefix("##### ") {
            ("h5", rest)
        } else if let Some(rest) = trimmed.strip_prefix("#### ") {
            ("h4", rest)
        } else if let Some(rest) = trimmed.strip_prefix("### ") {
            ("h3", rest)
        } else if let Some(rest) = trimmed.strip_prefix("## ") {
            ("h2", rest)
        } else if let Some(rest) = trimmed.strip_prefix("# ") {
            ("h1", rest)
        } else {
            ("", trimmed)
        };

        let escaped = render_inline_markdown(content);

        if !tag.is_empty() {
            if in_list {
                html_text.push_str("</ul>\n");
                in_list = false;
            }
            html_text.push_str(format!("<{tag}>{escaped}</{tag}>\n").as_str());
        } else if let Some(rest) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            if !in_list {
                html_text.push_str("<ul>\n");
                in_list = true;
            }

            html_text.push_str(format!("  <li>{}</li>\n", render_inline_markdown(rest)).as_str());
        } else {
            if in_list {
                html_text.push_str("</ul>\n");
                in_list = false;
            }
            html_text.push_str("<p>");
            html_text.push_str(escaped.as_str());
            html_text.push_str("</p>\n");
        }
    }

    if in_code_block {
        html_text.push_str(render_code_block(&code_block_buffer, code_lang.as_deref()).as_str());
    }
    if in_paragraph {
        html_text.push_str("</p>\n");
    }
    if in_list {
        html_text.push_str("</ul>\n");
    }
    html_text.push_str("\n</body>\n</html>");
    html_text
}

fn render_inline_markdown(content: &str) -> String {
    let mut escaped = String::new();
    let mut chars = content.chars().peekable();
    let mut bold = false;
    let mut italic = false;
    let mut code = false;

    while let Some(ch) = chars.next() {
        if ch == '*' {
            if let Some('*') = chars.peek() {
                chars.next();
                escaped.push_str(if bold { "</strong>" } else { "<strong>" });
                bold = !bold;
            } else {
                escaped.push_str(if italic { "</em>" } else { "<em>" });
                italic = !italic;
            }
        } else if ch == '`' {
            escaped.push_str(if code { "</code>" } else { "<code>" });
            code = !code;
        } else {
            match ch {
                '&' => escaped.push_str("&amp;"),
                '<' => escaped.push_str("&lt;"),
                '>' => escaped.push_str("&gt;"),
                '"' => escaped.push_str("&quot;"),
                _ => escaped.push(ch),
            }
        }
    }

    if bold {
        escaped.push_str("</strong>");
    }
    if italic {
        escaped.push_str("</em>");
    }
    if code {
        escaped.push_str("</code>");
    }

    escaped
}

fn render_code_block(code: &str, code_lang: Option<&str>) -> String {
    if let Some(lang) = code_lang {
        if let Some(syntax) = syntax_set().find_syntax_by_token(lang) {
            if let Some(highlighted) = render_highlighted_code_block(code, lang, syntax) {
                return highlighted;
            }
        }
    }

    render_plain_code_block(code, code_lang)
}

fn render_highlighted_code_block(
    code: &str,
    code_lang: &str,
    syntax: &SyntaxReference,
) -> Option<String> {
    let mut generator = ClassedHTMLGenerator::new_with_class_style(
        syntax,
        syntax_set(),
        ClassStyle::SpacedPrefixed {
            prefix: SYNTAX_CLASS_PREFIX,
        },
    );

    for line in LinesWithEndings::from(code) {
        generator
            .parse_html_for_line_which_includes_newline(line)
            .ok()?;
    }

    let language_class = format!(" language-{}", html_escape(code_lang));
    Some(format!(
        "<pre class=\"syntax-code syntax-highlight{language_class}\">{}</pre>\n",
        generator.finalize()
    ))
}

fn render_plain_code_block(code: &str, code_lang: Option<&str>) -> String {
    let mut block = String::new();

    if let Some(lang) = code_lang {
        block.push_str(format!("<pre><code class=\"language-{}\">\n", html_escape(lang)).as_str());
    } else {
        block.push_str("<pre><code>\n");
    }

    block.push_str(html_escape(code).as_str());
    block.push_str("</code></pre>\n");
    block
}

fn extract_code_language(info_string: &str) -> Option<String> {
    let token = info_string.split_whitespace().next()?.trim();
    let token = token
        .trim_matches(|c| matches!(c, '{' | '}' | '.'))
        .strip_prefix("language-")
        .unwrap_or(token);

    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

fn html_escape(s: &str) -> String {
    let mut out = String::new();
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}

fn get_css() -> String {
    let mut css = String::from(include_str!("styles.css"));
    css.push('\n');
    css.push_str(highlight_css());
    css
}

fn highlight_css() -> &'static str {
    SYNTAX_CSS.get_or_init(|| {
        css_for_theme_with_class_style(
            dracula_theme(),
            ClassStyle::SpacedPrefixed {
                prefix: SYNTAX_CLASS_PREFIX,
            },
        )
        .unwrap_or_default()
    })
}

fn syntax_set() -> &'static SyntaxSet {
    SYNTAX_SET.get_or_init(SyntaxSet::load_defaults_newlines)
}

fn dracula_theme() -> &'static Theme {
    SYNTAX_THEME.get_or_init(|| {
        let mut reader = Cursor::new(DRACULA_THEME.as_bytes());
        syntect::highlighting::ThemeSet::load_from_reader(&mut reader).unwrap_or_default()
    })
}

#[wasm_bindgen]
pub fn document_builder_wasm(md_text: String) -> String {
    document_builder(md_text)
}

/// Convert Markdown directly to PDF with A4 page size (pure Rust, no external dependencies)
#[cfg(not(target_arch = "wasm32"))]
pub fn markdown_to_pdf(md_text: &str, pdf_path: &str) -> Result<(), Box<dyn std::error::Error>> {
    // Load embedded fonts
    let font_family = FontFamily {
        regular: FontData::new(FONT_REGULAR.to_vec(), None)?,
        bold: FontData::new(FONT_BOLD.to_vec(), None)?,
        italic: FontData::new(FONT_REGULAR.to_vec(), None)?,
        bold_italic: FontData::new(FONT_BOLD.to_vec(), None)?,
    };

    // Create document with A4 size (210mm x 297mm)
    let mut doc = Document::new(font_family);
    doc.set_title("EasyMarkDoc Document");
    doc.set_minimal_conformance();
    doc.set_line_spacing(1.25);

    // A4 page decorator with margins
    let decorator = SimplePageDecorator::new();
    doc.set_page_decorator(decorator);

    // Parse and render markdown with proper list handling
    let mut in_code_block = false;
    let mut code_fence_char: char = '`';
    let mut code_fence_len: usize = 0;
    let mut code_block_buffer = String::new();
    let mut list_items: Vec<String> = Vec::new();
    let mut in_list = false;
    let mut is_ordered_list = false;

    for line in md_text.lines() {
        let trimmed = line.trim();

        // Handle code blocks
        if !in_code_block {
            if !trimmed.is_empty() && (trimmed.starts_with("```") || trimmed.starts_with("~~~")) {
                let fence_char = trimmed.chars().next().unwrap();
                let fence_len = trimmed.chars().take_while(|&c| c == fence_char).count();
                if fence_len >= 3 {
                    flush_list(&mut doc, &mut list_items, &mut in_list, is_ordered_list);
                    in_code_block = true;
                    code_fence_char = fence_char;
                    code_fence_len = fence_len;
                    code_block_buffer.clear();
                    continue;
                }
            }
        } else {
            if !trimmed.is_empty() {
                let closing_count = trimmed
                    .chars()
                    .take_while(|&c| c == code_fence_char)
                    .count();
                let rest_ok = trimmed
                    .chars()
                    .skip(closing_count)
                    .all(|c| c.is_whitespace());
                if closing_count >= code_fence_len && rest_ok {
                    // Render code block with background
                    render_code_block_to_pdf(&mut doc, &code_block_buffer);

                    in_code_block = false;
                    code_fence_len = 0;
                    code_block_buffer.clear();
                    continue;
                }
            }
            code_block_buffer.push_str(line);
            code_block_buffer.push('\n');
            continue;
        }

        // Empty line
        if trimmed.is_empty() {
            flush_list(&mut doc, &mut list_items, &mut in_list, is_ordered_list);
            continue;
        }

        // Check for headings
        if let Some(rest) = trimmed.strip_prefix("# ") {
            flush_list(&mut doc, &mut list_items, &mut in_list, is_ordered_list);
            doc.push(Paragraph::new(rest).styled(Style::new().bold().with_font_size(18)));
            doc.push(Break::new(1.0));
        } else if let Some(rest) = trimmed.strip_prefix("## ") {
            flush_list(&mut doc, &mut list_items, &mut in_list, is_ordered_list);
            doc.push(Paragraph::new(rest).styled(Style::new().bold().with_font_size(16)));
            doc.push(Break::new(0.8));
        } else if let Some(rest) = trimmed.strip_prefix("### ") {
            flush_list(&mut doc, &mut list_items, &mut in_list, is_ordered_list);
            doc.push(Paragraph::new(rest).styled(Style::new().bold().with_font_size(14)));
            doc.push(Break::new(0.7));
        } else if let Some(rest) = trimmed.strip_prefix("#### ") {
            flush_list(&mut doc, &mut list_items, &mut in_list, is_ordered_list);
            doc.push(Paragraph::new(rest).styled(Style::new().bold().with_font_size(13)));
            doc.push(Break::new(0.6));
        } else if let Some(rest) = trimmed.strip_prefix("##### ") {
            flush_list(&mut doc, &mut list_items, &mut in_list, is_ordered_list);
            doc.push(Paragraph::new(rest).styled(Style::new().bold().with_font_size(12)));
            doc.push(Break::new(0.5));
        } else if let Some(rest) = trimmed.strip_prefix("###### ") {
            flush_list(&mut doc, &mut list_items, &mut in_list, is_ordered_list);
            doc.push(Paragraph::new(rest).styled(Style::new().bold().with_font_size(11)));
            doc.push(Break::new(0.5));
        } else if let Some(rest) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            // Unordered list
            if !in_list || is_ordered_list {
                flush_list(&mut doc, &mut list_items, &mut in_list, is_ordered_list);
                in_list = true;
                is_ordered_list = false;
            }
            list_items.push(process_inline_formatting(rest));
        } else if trimmed
            .chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
            && trimmed.contains(". ")
        {
            // Ordered list (simple check)
            if let Some(rest) = trimmed.split_once(". ").map(|(_, r)| r) {
                if !in_list || !is_ordered_list {
                    flush_list(&mut doc, &mut list_items, &mut in_list, is_ordered_list);
                    in_list = true;
                    is_ordered_list = true;
                }
                list_items.push(process_inline_formatting(rest));
            }
        } else {
            // Regular paragraph
            flush_list(&mut doc, &mut list_items, &mut in_list, is_ordered_list);
            let formatted = process_inline_formatting(trimmed);
            doc.push(Paragraph::new(formatted));
            doc.push(Break::new(0.5));
        }
    }

    // Flush any remaining content
    flush_list(&mut doc, &mut list_items, &mut in_list, is_ordered_list);
    if in_code_block {
        render_code_block_to_pdf(&mut doc, &code_block_buffer);
    }

    // Write PDF to file
    doc.render(&mut BufWriter::new(File::create(pdf_path)?))?;

    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
fn flush_list(doc: &mut Document, items: &mut Vec<String>, in_list: &mut bool, is_ordered: bool) {
    if *in_list && !items.is_empty() {
        if is_ordered {
            let mut list = OrderedList::new();
            for item in items.iter() {
                list.push(Paragraph::new(item.clone()));
            }
            doc.push(list);
        } else {
            let mut list = UnorderedList::new();
            for item in items.iter() {
                list.push(Paragraph::new(item.clone()));
            }
            doc.push(list);
        }
        doc.push(Break::new(0.5));
        items.clear();
        *in_list = false;
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn render_code_block_to_pdf(doc: &mut Document, code: &str) {
    // Create a styled code block with gray background effect
    let code_style = Style::new()
        .with_font_size(9)
        .with_color(Color::Rgb(80, 80, 80)); // Gray text for code

    // Split code into lines and add each with monospace style
    for line in code.lines() {
        if line.trim().is_empty() {
            doc.push(Paragraph::new(" ")); // Empty line placeholder
        } else {
            doc.push(Paragraph::new(line).styled(code_style));
        }
    }
    doc.push(Break::new(0.5));
}

#[cfg(not(target_arch = "wasm32"))]
fn process_inline_formatting(text: &str) -> String {
    // For now, return as-is. Could enhance to handle **bold**, *italic*, `code`
    // by converting to StyledString with multiple segments
    text.to_string()
}

#[cfg(test)]
mod tests {
    use super::document_builder;

    #[test]
    fn highlights_language_tagged_code_blocks() {
        let html = document_builder(
            "```rust\nfn main() {\n    let greeting = \"hello\";\n}\n```".to_string(),
        );

        assert!(html.contains("<pre class=\"syntax-code syntax-highlight language-rust\">"));
        assert!(html.contains(".syntax-code {"));
    }

    #[test]
    fn leaves_untyped_fenced_code_blocks_plain() {
        let html = document_builder("```\nplain text\n```".to_string());

        assert!(html.contains("<pre><code>\nplain text\n</code></pre>"));
    }
}
