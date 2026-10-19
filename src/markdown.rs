//! A small, dependency-free Markdown parser that renders to HTML.
//!
//! Supports CommonMark-style blocks (headings, paragraphs, nested lists,
//! blockquotes, fenced/indented code, thematic breaks, raw HTML) plus the
//! common GitHub-flavoured extensions (tables, task lists, strikethrough,
//! autolinks, footnotes) and a few document-oriented extras:
//!
//! - `[TOC]` on its own line inserts a table of contents
//! - `\pagebreak`, `\newpage` or `<!-- pagebreak -->` force a page break
//! - `==text==` highlights text
//! - `{#custom-id}` at the end of a heading sets its anchor id

use std::collections::HashMap;

use crate::highlight;

/// A heading collected while rendering, used for the table of contents.
#[derive(Debug, Clone)]
pub struct Heading {
    pub level: usize,
    pub id: String,
    pub text: String,
}

/// The result of rendering a Markdown document.
#[derive(Debug, Clone)]
pub struct Rendered {
    /// HTML body fragment.
    pub html: String,
    /// The text of the first level-1 heading, if any.
    pub title: Option<String>,
    pub headings: Vec<Heading>,
}

const TOC_PLACEHOLDER: &str = "\u{0}EASYMARKDOC_TOC\u{0}";

/// Render Markdown text to an HTML fragment.
pub fn render(markdown: &str) -> Rendered {
    let normalized = normalize(markdown);
    let mut parser = Parser::default();
    let lines = parser.collect_definitions(&normalized);
    let mut html = parser.blocks(&lines, false);

    if !parser.footnote_order.is_empty() {
        html.push_str(&parser.render_footnotes());
    }
    if html.contains(TOC_PLACEHOLDER) {
        html = html.replace(TOC_PLACEHOLDER, &render_toc(&parser.headings));
    }

    let title = parser
        .headings
        .iter()
        .find(|h| h.level == 1)
        .map(|h| h.text.clone());

    Rendered {
        html,
        title,
        headings: parser.headings,
    }
}

/// Convert line endings and expand tabs to spaces (tab stops of 4).
fn normalize(text: &str) -> Vec<String> {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .map(|line| {
            if !line.contains('\t') {
                return line.to_string();
            }
            let mut out = String::with_capacity(line.len() + 8);
            let mut col = 0;
            for ch in line.chars() {
                if ch == '\t' {
                    let spaces = 4 - (col % 4);
                    out.extend(std::iter::repeat_n(' ', spaces));
                    col += spaces;
                } else {
                    out.push(ch);
                    col += 1;
                }
            }
            out
        })
        .collect()
}

#[derive(Default)]
struct Parser {
    link_refs: HashMap<String, (String, Option<String>)>,
    footnote_defs: HashMap<String, Vec<String>>,
    footnote_order: Vec<String>,
    headings: Vec<Heading>,
    used_ids: HashMap<String, usize>,
    /// Set while rendering link text, to avoid nested autolinks.
    in_link: bool,
}

// ---------------------------------------------------------------------------
// Line classification helpers
// ---------------------------------------------------------------------------

fn indent_of(line: &str) -> usize {
    line.chars().take_while(|&c| c == ' ').count()
}

fn is_blank(line: &str) -> bool {
    line.trim().is_empty()
}

/// Remove up to `n` leading spaces.
fn strip_indent(line: &str, n: usize) -> &str {
    let strip = indent_of(line).min(n);
    &line[strip..]
}

struct Fence {
    ch: char,
    len: usize,
    indent: usize,
    info: String,
}

fn fence_open(line: &str) -> Option<Fence> {
    let indent = indent_of(line);
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let ch = rest.chars().next()?;
    if ch != '`' && ch != '~' {
        return None;
    }
    let len = rest.chars().take_while(|&c| c == ch).count();
    if len < 3 {
        return None;
    }
    let info = rest[len..].trim().to_string();
    if ch == '`' && info.contains('`') {
        return None;
    }
    Some(Fence {
        ch,
        len,
        indent,
        info,
    })
}

fn fence_closes(line: &str, fence: &Fence) -> bool {
    let indent = indent_of(line);
    if indent > 3 {
        return false;
    }
    let rest = &line[indent..];
    let count = rest.chars().take_while(|&c| c == fence.ch).count();
    count >= fence.len && rest[count..].trim().is_empty()
}

fn atx_heading(line: &str) -> Option<(usize, &str)> {
    let indent = indent_of(line);
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let level = rest.chars().take_while(|&c| c == '#').count();
    if level == 0 || level > 6 {
        return None;
    }
    let after = &rest[level..];
    if !after.is_empty() && !after.starts_with(' ') {
        return None;
    }
    let mut content = after.trim();
    // Strip an optional closing sequence of '#'s.
    let without_hashes = content.trim_end_matches('#');
    if without_hashes.is_empty() {
        content = "";
    } else if without_hashes.ends_with(' ') {
        content = without_hashes.trim_end();
    }
    Some((level, content))
}

fn is_thematic_break(line: &str) -> bool {
    if indent_of(line) > 3 {
        return false;
    }
    let trimmed = line.trim();
    let Some(ch) = trimmed.chars().next() else {
        return false;
    };
    if !matches!(ch, '-' | '*' | '_') {
        return false;
    }
    let mut count = 0;
    for c in trimmed.chars() {
        if c == ch {
            count += 1;
        } else if c != ' ' {
            return false;
        }
    }
    count >= 3
}

fn setext_level(line: &str) -> Option<usize> {
    if indent_of(line) > 3 {
        return None;
    }
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().all(|c| c == '=') {
        Some(1)
    } else if trimmed.chars().all(|c| c == '-') {
        Some(2)
    } else {
        None
    }
}

fn is_blockquote(line: &str) -> bool {
    indent_of(line) <= 3 && line.trim_start().starts_with('>')
}

fn is_page_break(line: &str) -> bool {
    let t = line.trim();
    t == "\\pagebreak"
        || t == "\\newpage"
        || t.eq_ignore_ascii_case("<!-- pagebreak -->")
        || t.eq_ignore_ascii_case("<!-- page-break -->")
}

fn is_toc(line: &str) -> bool {
    let t = line.trim();
    t.eq_ignore_ascii_case("[toc]") || t.eq_ignore_ascii_case("[[toc]]")
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ListKind {
    Bullet(char),
    Ordered(char),
}

struct ListMarker {
    kind: ListKind,
    start: u32,
    /// Column at which the item's content begins.
    content_offset: usize,
    /// Whether the line contains nothing after the marker.
    empty: bool,
}

fn list_marker(line: &str) -> Option<ListMarker> {
    let indent = indent_of(line);
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let first = rest.chars().next()?;

    let (kind, start, marker_len) = if matches!(first, '-' | '+' | '*') {
        (ListKind::Bullet(first), 1, 1)
    } else {
        let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 || digits > 9 {
            return None;
        }
        let delim = rest[digits..].chars().next()?;
        if delim != '.' && delim != ')' {
            return None;
        }
        let start = rest[..digits].parse().ok()?;
        (ListKind::Ordered(delim), start, digits + 1)
    };

    let after = &rest[marker_len..];
    if after.is_empty() || after.trim().is_empty() {
        return Some(ListMarker {
            kind,
            start,
            content_offset: indent + marker_len + 1,
            empty: true,
        });
    }
    if !after.starts_with(' ') {
        return None;
    }
    let spaces = indent_of(after);
    // Five or more spaces means indented code inside the item; use one space.
    let padding = if spaces > 4 { 1 } else { spaces };
    Some(ListMarker {
        kind,
        start,
        content_offset: indent + marker_len + padding,
        empty: false,
    })
}

fn is_html_block_start(line: &str) -> bool {
    if indent_of(line) > 3 {
        return false;
    }
    let t = line.trim_start();
    if t.starts_with("<!--") {
        return true;
    }
    let Some(rest) = t.strip_prefix('<') else {
        return false;
    };
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    let name: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    if name.is_empty() {
        return false;
    }
    let after = rest[name.len()..].chars().next();
    if !matches!(after, None | Some(' ') | Some('>') | Some('/')) {
        return false;
    }
    BLOCK_TAGS.contains(&name.as_str())
}

const BLOCK_TAGS: &[&str] = &[
    "address",
    "article",
    "aside",
    "blockquote",
    "body",
    "caption",
    "center",
    "col",
    "colgroup",
    "dd",
    "details",
    "dialog",
    "dir",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hr",
    "html",
    "iframe",
    "legend",
    "li",
    "link",
    "main",
    "menu",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "script",
    "style",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "title",
    "tr",
    "ul",
    "svg",
    "img",
    "br",
    "picture",
    "video",
    "audio",
    "math",
];

fn is_table_delimiter(line: &str) -> bool {
    let t = line.trim();
    if !t.contains('-') {
        return false;
    }
    let cells = split_table_row(t);
    !cells.is_empty()
        && cells.iter().all(|cell| {
            let c = cell.trim();
            let inner = c.trim_start_matches(':').trim_end_matches(':');
            !inner.is_empty() && inner.chars().all(|ch| ch == '-')
        })
}

/// Split a table row on unescaped pipes that are not inside code spans.
fn split_table_row(line: &str) -> Vec<String> {
    let mut t = line.trim();
    if let Some(rest) = t.strip_prefix('|') {
        t = rest;
    }
    if t.ends_with('|') && !t.ends_with("\\|") {
        t = &t[..t.len() - 1];
    }

    let mut cells = Vec::new();
    let mut current = String::new();
    let mut chars = t.chars().peekable();
    let mut code_run = 0usize;
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars.peek() == Some(&'|') => {
                chars.next();
                current.push('|');
            }
            '`' => {
                let mut run = 1;
                while chars.peek() == Some(&'`') {
                    chars.next();
                    run += 1;
                }
                if code_run == 0 {
                    code_run = run;
                } else if code_run == run {
                    code_run = 0;
                }
                current.extend(std::iter::repeat_n('`', run));
            }
            '|' if code_run == 0 => {
                cells.push(std::mem::take(&mut current));
            }
            _ => current.push(c),
        }
    }
    cells.push(current);
    cells
}

/// Whether `line` would start a new block when it follows paragraph text.
fn interrupts_paragraph(line: &str) -> bool {
    if is_blank(line) {
        return true;
    }
    if atx_heading(line).is_some()
        || fence_open(line).is_some()
        || is_blockquote(line)
        || is_thematic_break(line)
        || is_html_block_start(line)
        || is_page_break(line)
    {
        return true;
    }
    if let Some(m) = list_marker(line) {
        // Only bullet items or ordered items starting at 1 can interrupt.
        return !m.empty && (matches!(m.kind, ListKind::Bullet(_)) || m.start == 1);
    }
    false
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

impl Parser {
    /// First pass: pull out link reference and footnote definitions so they
    /// can be referenced from anywhere in the document.
    fn collect_definitions(&mut self, lines: &[String]) -> Vec<String> {
        let mut out = Vec::with_capacity(lines.len());
        let mut fence: Option<Fence> = None;
        let mut i = 0;
        let mut prev_blank = true;

        while i < lines.len() {
            let line = &lines[i];
            if let Some(f) = &fence {
                if fence_closes(line, f) {
                    fence = None;
                }
                out.push(line.clone());
                i += 1;
                continue;
            }
            if let Some(f) = fence_open(line) {
                fence = Some(f);
                out.push(line.clone());
                i += 1;
                prev_blank = false;
                continue;
            }

            if prev_blank && indent_of(line) <= 3 {
                let t = line.trim();
                if let Some((label, text)) = parse_footnote_def(t) {
                    let mut body = vec![text.to_string()];
                    i += 1;
                    while i < lines.len() {
                        let next = &lines[i];
                        if is_blank(next) {
                            // Continue only if the following line is indented.
                            if lines.get(i + 1).is_some_and(|l| indent_of(l) >= 4) {
                                body.push(String::new());
                                i += 1;
                                continue;
                            }
                            break;
                        }
                        if indent_of(next) >= 4 {
                            body.push(strip_indent(next, 4).to_string());
                        } else if !interrupts_paragraph(next)
                            && parse_footnote_def(next.trim()).is_none()
                        {
                            body.push(next.trim().to_string());
                        } else {
                            break;
                        }
                        i += 1;
                    }
                    self.footnote_defs.insert(normalize_label(label), body);
                    continue;
                }
                if let Some((label, url, title)) = parse_link_ref_def(t) {
                    self.link_refs
                        .entry(normalize_label(&label))
                        .or_insert((url, title));
                    i += 1;
                    continue;
                }
            }

            prev_blank = is_blank(line) || atx_heading(line).is_some();
            out.push(line.clone());
            i += 1;
        }
        out
    }

    /// Render a sequence of lines as block-level HTML. When `tight` is set,
    /// paragraphs are emitted without `<p>` wrappers (tight list items).
    fn blocks(&mut self, lines: &[String], tight: bool) -> String {
        let mut html = String::new();
        let mut i = 0;
        let n = lines.len();

        while i < n {
            let line = &lines[i];

            if is_blank(line) {
                i += 1;
                continue;
            }

            // Indented code block.
            if indent_of(line) >= 4 {
                let mut code = Vec::new();
                while i < n && (is_blank(&lines[i]) || indent_of(&lines[i]) >= 4) {
                    code.push(strip_indent(&lines[i], 4).to_string());
                    i += 1;
                }
                while code.last().is_some_and(|l| l.trim().is_empty()) {
                    code.pop();
                }
                let mut text = code.join("\n");
                text.push('\n');
                html.push_str(&highlight::code_block(&text, None));
                continue;
            }

            if let Some(fence) = fence_open(line) {
                i += 1;
                let mut code = String::new();
                while i < n && !fence_closes(&lines[i], &fence) {
                    code.push_str(strip_indent(&lines[i], fence.indent));
                    code.push('\n');
                    i += 1;
                }
                i += 1; // closing fence (or end of input)
                let lang = code_language(&fence.info);
                html.push_str(&highlight::code_block(&code, lang.as_deref()));
                continue;
            }

            if is_page_break(line) {
                html.push_str("<div class=\"page-break\"></div>\n");
                i += 1;
                continue;
            }

            if is_toc(line) {
                html.push_str(TOC_PLACEHOLDER);
                html.push('\n');
                i += 1;
                continue;
            }

            if let Some((level, content)) = atx_heading(line) {
                html.push_str(&self.heading(level, content));
                i += 1;
                continue;
            }

            if is_thematic_break(line) {
                html.push_str("<hr />\n");
                i += 1;
                continue;
            }

            if is_blockquote(line) {
                let mut inner = Vec::new();
                let mut last_was_paragraph = false;
                while i < n {
                    let l = &lines[i];
                    if is_blockquote(l) {
                        let t = l.trim_start();
                        let t = &t[1..];
                        let t = t.strip_prefix(' ').unwrap_or(t);
                        last_was_paragraph = !is_blank(t) && fence_open(t).is_none();
                        inner.push(t.to_string());
                    } else if last_was_paragraph && !interrupts_paragraph(l) {
                        // Lazy continuation line.
                        inner.push(l.trim_start().to_string());
                    } else {
                        break;
                    }
                    i += 1;
                }
                html.push_str(&self.blockquote(&inner));
                continue;
            }

            if list_marker(line).is_some() {
                let (list_html, next) = self.list(lines, i);
                html.push_str(&list_html);
                i = next;
                continue;
            }

            if i + 1 < n && line.contains('|') && is_table_delimiter(&lines[i + 1]) {
                let header = split_table_row(line);
                let aligns = split_table_row(&lines[i + 1]);
                if header.len() == aligns.len() {
                    i += 2;
                    let mut rows = Vec::new();
                    while i < n && !is_blank(&lines[i]) && !interrupts_paragraph(&lines[i]) {
                        rows.push(split_table_row(&lines[i]));
                        i += 1;
                    }
                    html.push_str(&self.table(&header, &aligns, &rows));
                    continue;
                }
            }

            if is_html_block_start(line) {
                let comment = line.trim_start().starts_with("<!--");
                while i < n {
                    let l = &lines[i];
                    if !comment && is_blank(l) {
                        break;
                    }
                    html.push_str(l);
                    html.push('\n');
                    i += 1;
                    if comment && l.contains("-->") {
                        break;
                    }
                }
                continue;
            }

            // Paragraph, possibly turned into a setext heading.
            let mut para = vec![line.trim_start().to_string()];
            i += 1;
            let mut setext = None;
            while i < n {
                let l = &lines[i];
                if let Some(level) = setext_level(l) {
                    setext = Some(level);
                    i += 1;
                    break;
                }
                if interrupts_paragraph(l) {
                    break;
                }
                if l.contains('|') && i + 1 < n && is_table_delimiter(&lines[i + 1]) {
                    break;
                }
                para.push(l.trim_start().to_string());
                i += 1;
            }
            let text = para.join("\n");
            let text = text.trim_end();

            if let Some(level) = setext {
                html.push_str(&self.heading(level, text));
            } else {
                html.push_str(&self.paragraph(text, tight));
            }
        }

        html
    }

    fn paragraph(&mut self, text: &str, tight: bool) -> String {
        if let Some(figure) = self.figure(text) {
            return figure;
        }
        let inner = self.inline(text);
        if tight {
            format!("{inner}\n")
        } else {
            format!("<p>{inner}</p>\n")
        }
    }

    /// A paragraph consisting of a single titled image becomes a figure with
    /// the title as its caption.
    fn figure(&mut self, text: &str) -> Option<String> {
        let chars: Vec<char> = text.chars().collect();
        if chars.first() != Some(&'!') || chars.get(1) != Some(&'[') {
            return None;
        }
        let (link, end) = self.parse_link(&chars, 1)?;
        if end != chars.len() {
            return None;
        }
        let caption = link.title.clone()?;
        Some(format!(
            "<figure>\n<img src=\"{}\" alt=\"{}\" />\n<figcaption>{}</figcaption>\n</figure>\n",
            escape_attr(&link.url),
            escape_attr(&plain_text(&self.inline(&link.text))),
            self.inline(&caption)
        ))
    }

    fn heading(&mut self, level: usize, content: &str) -> String {
        let (content, custom_id) = split_heading_id(content);
        let inner = self.inline(content);
        let text = plain_text(&inner);
        let base = custom_id
            .map(str::to_string)
            .unwrap_or_else(|| slugify(&text));
        let id = self.unique_id(if base.is_empty() {
            "section".into()
        } else {
            base
        });
        self.headings.push(Heading {
            level,
            id: id.clone(),
            text,
        });
        format!("<h{level} id=\"{}\">{inner}</h{level}>\n", escape_attr(&id))
    }

    fn unique_id(&mut self, base: String) -> String {
        let count = self.used_ids.entry(base.clone()).or_insert(0);
        *count += 1;
        if *count == 1 {
            base
        } else {
            format!("{base}-{}", *count - 1)
        }
    }

    fn blockquote(&mut self, lines: &[String]) -> String {
        // GitHub-style alerts: > [!NOTE], > [!TIP], > [!WARNING], ...
        if let Some(first) = lines.first() {
            let t = first.trim();
            for kind in ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"] {
                if t.eq_ignore_ascii_case(&format!("[!{kind}]")) {
                    let body = self.blocks(&lines[1..], false);
                    let lower = kind.to_ascii_lowercase();
                    let label = format!("{}{}", &kind[..1], kind[1..].to_ascii_lowercase());
                    return format!(
                        "<blockquote class=\"alert alert-{lower}\">\n<p class=\"alert-title\">{label}</p>\n{body}</blockquote>\n"
                    );
                }
            }
        }
        format!("<blockquote>\n{}</blockquote>\n", self.blocks(lines, false))
    }

    /// Parse a list starting at line `start`. Returns the HTML and the index
    /// of the first line after the list.
    fn list(&mut self, lines: &[String], start: usize) -> (String, usize) {
        let n = lines.len();
        let first = list_marker(&lines[start]).expect("list start");
        let kind = first.kind;
        let mut items: Vec<Vec<String>> = Vec::new();
        let mut loose = false;
        let mut i = start;

        while i < n {
            let Some(marker) = list_marker(&lines[i]) else {
                break;
            };
            if marker.kind != kind {
                break;
            }
            let offset = marker.content_offset;
            let mut item = Vec::new();
            if !marker.empty {
                item.push(lines[i][offset.min(lines[i].len())..].to_string());
            }
            i += 1;

            let mut fence: Option<Fence> = None;
            let mut lazy_ok = !marker.empty;
            while i < n {
                let l = &lines[i];
                if is_blank(l) {
                    item.push(String::new());
                    lazy_ok = false;
                    i += 1;
                    continue;
                }
                if indent_of(l) >= offset {
                    let content = &l[offset..];
                    if let Some(f) = &fence {
                        if fence_closes(content, f) {
                            fence = None;
                        }
                    } else if let Some(f) = fence_open(content) {
                        fence = Some(f);
                    }
                    lazy_ok = fence.is_none() && !is_blank(content);
                    item.push(content.to_string());
                    i += 1;
                    continue;
                }
                if fence.is_none()
                    && lazy_ok
                    && !interrupts_paragraph(l)
                    && list_marker(l).is_none()
                {
                    item.push(l.trim_start().to_string());
                    i += 1;
                    continue;
                }
                break;
            }

            // Trailing blank lines separate this item from the next one.
            let mut trailing_blank = false;
            while item.last().is_some_and(|l| l.is_empty()) {
                item.pop();
                trailing_blank = true;
            }
            if !loose && item_has_internal_blank(&item) {
                loose = true;
            }
            items.push(item);

            let continues = i < n && list_marker(&lines[i]).is_some_and(|m| m.kind == kind);
            if continues && trailing_blank {
                loose = true;
            }
            if !continues {
                break;
            }
        }

        let tight = !loose;
        let mut html = String::new();
        let task_list = items.iter().any(|item| task_marker(item).is_some());
        match kind {
            ListKind::Bullet(_) => {
                html.push_str(if task_list {
                    "<ul class=\"task-list\">\n"
                } else {
                    "<ul>\n"
                });
            }
            ListKind::Ordered(_) => {
                if first.start == 1 {
                    html.push_str("<ol>\n");
                } else {
                    html.push_str(&format!("<ol start=\"{}\">\n", first.start));
                }
            }
        }

        for mut item in items {
            let checkbox = task_marker(&item);
            if let Some(checked) = checkbox {
                let first_line = item[0].trim_start();
                item[0] = first_line[3..].trim_start().to_string();
                html.push_str(&format!(
                    "<li class=\"task-list-item\"><input type=\"checkbox\" disabled{} /> ",
                    if checked { " checked" } else { "" }
                ));
            } else {
                html.push_str("<li>");
            }
            let body = self.blocks(&item, tight);
            html.push_str(body.trim_end_matches('\n'));
            html.push_str("</li>\n");
        }

        html.push_str(match kind {
            ListKind::Bullet(_) => "</ul>\n",
            ListKind::Ordered(_) => "</ol>\n",
        });
        (html, i)
    }

    fn table(&mut self, header: &[String], delimiter: &[String], rows: &[Vec<String>]) -> String {
        let aligns: Vec<Option<&str>> = delimiter
            .iter()
            .map(|cell| {
                let c = cell.trim();
                match (c.starts_with(':'), c.ends_with(':')) {
                    (true, true) => Some("center"),
                    (false, true) => Some("right"),
                    (true, false) => Some("left"),
                    _ => None,
                }
            })
            .collect();

        let cell = |this: &mut Self, tag: &str, idx: usize, text: &str| -> String {
            let style = match aligns.get(idx).copied().flatten() {
                Some(a) => format!(" style=\"text-align: {a}\""),
                None => String::new(),
            };
            format!("<{tag}{style}>{}</{tag}>", this.inline(text.trim()))
        };

        let mut html = String::from("<table>\n<thead>\n<tr>");
        for (idx, h) in header.iter().enumerate() {
            html.push_str(&cell(self, "th", idx, h));
        }
        html.push_str("</tr>\n</thead>\n");
        if !rows.is_empty() {
            html.push_str("<tbody>\n");
            for row in rows {
                html.push_str("<tr>");
                for idx in 0..header.len() {
                    let text = row.get(idx).map(String::as_str).unwrap_or("");
                    html.push_str(&cell(self, "td", idx, text));
                }
                html.push_str("</tr>\n");
            }
            html.push_str("</tbody>\n");
        }
        html.push_str("</table>\n");
        html
    }

    fn render_footnotes(&mut self) -> String {
        let mut html = String::from("<section class=\"footnotes\">\n<hr />\n<ol>\n");
        let order = self.footnote_order.clone();
        for (idx, label) in order.iter().enumerate() {
            let number = idx + 1;
            let body = self.footnote_defs.get(label).cloned().unwrap_or_default();
            let mut inner = self.blocks(&body, false);
            let backref =
                format!(" <a href=\"#fnref-{number}\" class=\"footnote-backref\">&#8617;</a>");
            if let Some(pos) = inner.rfind("</p>") {
                inner.insert_str(pos, &backref);
            } else {
                inner.push_str(&backref);
            }
            html.push_str(&format!("<li id=\"fn-{number}\">\n{inner}</li>\n"));
        }
        html.push_str("</ol>\n</section>\n");
        html
    }
}

fn item_has_internal_blank(item: &[String]) -> bool {
    // A blank line between two direct children (lines at column 0 of the item)
    // makes the list loose. Blank lines inside fenced code don't count.
    let mut fence: Option<Fence> = None;
    let mut saw_blank = false;
    for line in item {
        if let Some(f) = &fence {
            if fence_closes(line, f) {
                fence = None;
            }
            continue;
        }
        if line.is_empty() || is_blank(line) {
            saw_blank = true;
            continue;
        }
        if saw_blank && indent_of(line) == 0 {
            return true;
        }
        saw_blank = false;
        if let Some(f) = fence_open(line) {
            fence = Some(f);
        }
    }
    false
}

fn task_marker(item: &[String]) -> Option<bool> {
    let first = item.first()?.trim_start();
    let bytes = first.as_bytes();
    if bytes.len() >= 3 && bytes[0] == b'[' && bytes[2] == b']' {
        if bytes.len() > 3 && bytes[3] != b' ' {
            return None;
        }
        return match bytes[1] {
            b' ' => Some(false),
            b'x' | b'X' => Some(true),
            _ => None,
        };
    }
    None
}

fn parse_footnote_def(line: &str) -> Option<(&str, &str)> {
    let rest = line.strip_prefix("[^")?;
    let close = rest.find("]:")?;
    let label = &rest[..close];
    if label.is_empty() || label.contains(char::is_whitespace) {
        return None;
    }
    Some((label, rest[close + 2..].trim()))
}

fn parse_link_ref_def(line: &str) -> Option<(String, String, Option<String>)> {
    let rest = line.strip_prefix('[')?;
    if rest.starts_with('^') {
        return None;
    }
    let close = rest.find("]:")?;
    let label = &rest[..close];
    if label.trim().is_empty() {
        return None;
    }
    let after = rest[close + 2..].trim();
    if after.is_empty() {
        return None;
    }
    let (url, remainder) = if let Some(stripped) = after.strip_prefix('<') {
        let end = stripped.find('>')?;
        (&stripped[..end], stripped[end + 1..].trim())
    } else {
        match after.find(' ') {
            Some(pos) => (&after[..pos], after[pos..].trim()),
            None => (after, ""),
        }
    };
    let title = if remainder.is_empty() {
        None
    } else {
        let quoted = (remainder.starts_with('"') && remainder.ends_with('"'))
            || (remainder.starts_with('\'') && remainder.ends_with('\''))
            || (remainder.starts_with('(') && remainder.ends_with(')'));
        if !quoted || remainder.len() < 2 {
            return None;
        }
        Some(remainder[1..remainder.len() - 1].to_string())
    };
    Some((label.to_string(), url.to_string(), title))
}

fn normalize_label(label: &str) -> String {
    label
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn code_language(info: &str) -> Option<String> {
    let token = info.split_whitespace().next()?;
    let token = token.trim_matches(|c| matches!(c, '{' | '}' | '.'));
    let token = token.strip_prefix("language-").unwrap_or(token);
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

fn split_heading_id(content: &str) -> (&str, Option<&str>) {
    let trimmed = content.trim_end();
    if trimmed.ends_with('}')
        && let Some(start) = trimmed.rfind("{#")
    {
        let id = &trimmed[start + 2..trimmed.len() - 1];
        if !id.is_empty()
            && id
                .chars()
                .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
        {
            return (trimmed[..start].trim_end(), Some(id));
        }
    }
    (content, None)
}

/// Create a URL-friendly anchor id from heading text (GitHub style).
pub fn slugify(text: &str) -> String {
    let mut slug = String::new();
    for ch in text.trim().chars() {
        if ch.is_alphanumeric() {
            slug.extend(ch.to_lowercase());
        } else if ch == ' ' || ch == '-' || ch == '_' {
            slug.push('-');
        }
    }
    slug
}

fn render_toc(headings: &[Heading]) -> String {
    let entries: Vec<&Heading> = headings.iter().filter(|h| h.level <= 3).collect();
    if entries.is_empty() {
        return String::new();
    }
    let mut html = String::from("<nav class=\"toc\">\n<p class=\"toc-title\">Contents</p>\n<ul>\n");
    for h in entries {
        html.push_str(&format!(
            "<li class=\"toc-level-{}\"><a href=\"#{}\">{}</a></li>\n",
            h.level,
            escape_attr(&h.id),
            escape_html(&h.text)
        ));
    }
    html.push_str("</ul>\n</nav>\n");
    html
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

struct Link {
    text: String,
    url: String,
    title: Option<String>,
}

fn is_ascii_punct(c: char) -> bool {
    c.is_ascii_punctuation()
}

fn is_ws(c: Option<char>) -> bool {
    c.is_none_or(char::is_whitespace)
}

fn is_punct(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_punctuation() || (!c.is_alphanumeric() && !c.is_whitespace()))
}

fn run_length(chars: &[char], start: usize) -> usize {
    let c = chars[start];
    chars[start..].iter().take_while(|&&x| x == c).count()
}

/// If a code span starts at `i`, return the index just past its end.
fn code_span_end(chars: &[char], i: usize) -> Option<usize> {
    let run = run_length(chars, i);
    let mut j = i + run;
    while j < chars.len() {
        if chars[j] == '`' {
            let close = run_length(chars, j);
            if close == run {
                return Some(j + close);
            }
            j += close;
        } else {
            j += 1;
        }
    }
    None
}

impl Parser {
    fn inline(&mut self, text: &str) -> String {
        let chars: Vec<char> = text.chars().collect();
        self.inline_chars(&chars)
    }

    fn inline_chars(&mut self, chars: &[char]) -> String {
        let mut out = String::with_capacity(chars.len() + 16);
        let n = chars.len();
        let mut i = 0;

        while i < n {
            let c = chars[i];
            match c {
                '\\' => match chars.get(i + 1) {
                    Some('\n') => {
                        out.push_str("<br />\n");
                        i += 2;
                    }
                    Some(&next) if is_ascii_punct(next) => {
                        push_escaped(&mut out, next);
                        i += 2;
                    }
                    _ => {
                        out.push('\\');
                        i += 1;
                    }
                },
                '`' => {
                    let run = run_length(chars, i);
                    if let Some(end) = code_span_end(chars, i) {
                        let inner: String = chars[i + run..end - run]
                            .iter()
                            .map(|&c| if c == '\n' { ' ' } else { c })
                            .collect();
                        let inner = if inner.len() >= 2
                            && inner.starts_with(' ')
                            && inner.ends_with(' ')
                            && !inner.trim().is_empty()
                        {
                            &inner[1..inner.len() - 1]
                        } else {
                            inner.as_str()
                        };
                        out.push_str("<code>");
                        out.push_str(&escape_html(inner));
                        out.push_str("</code>");
                        i = end;
                    } else {
                        out.extend(std::iter::repeat_n('`', run));
                        i += run;
                    }
                }
                '!' if chars.get(i + 1) == Some(&'[') => {
                    if let Some((link, end)) = self.parse_link(chars, i + 1) {
                        let alt = plain_text(&self.inline(&link.text));
                        out.push_str(&format!(
                            "<img src=\"{}\" alt=\"{}\"",
                            escape_attr(&link.url),
                            escape_attr(&alt)
                        ));
                        if let Some(title) = &link.title {
                            out.push_str(&format!(" title=\"{}\"", escape_attr(title)));
                        }
                        out.push_str(" />");
                        i = end;
                    } else {
                        out.push('!');
                        i += 1;
                    }
                }
                '[' => {
                    if let Some((html, end)) = self.footnote_ref(chars, i) {
                        out.push_str(&html);
                        i = end;
                    } else if let Some((link, end)) = self.parse_link(chars, i) {
                        out.push_str(&format!("<a href=\"{}\"", escape_attr(&link.url)));
                        if let Some(title) = &link.title {
                            out.push_str(&format!(" title=\"{}\"", escape_attr(title)));
                        }
                        out.push('>');
                        let was_in_link = std::mem::replace(&mut self.in_link, true);
                        out.push_str(&self.inline(&link.text));
                        self.in_link = was_in_link;
                        out.push_str("</a>");
                        i = end;
                    } else {
                        out.push('[');
                        i += 1;
                    }
                }
                '<' => {
                    if let Some((html, end)) = autolink(chars, i).or_else(|| inline_html(chars, i))
                    {
                        out.push_str(&html);
                        i = end;
                    } else {
                        out.push_str("&lt;");
                        i += 1;
                    }
                }
                '&' => {
                    if let Some(end) = entity_end(chars, i) {
                        out.extend(&chars[i..end]);
                        i = end;
                    } else {
                        out.push_str("&amp;");
                        i += 1;
                    }
                }
                '*' | '_' | '~' | '=' => {
                    if let Some((html, end)) = self.emphasis(chars, i) {
                        out.push_str(&html);
                        i = end;
                    } else {
                        let run = run_length(chars, i);
                        out.extend(std::iter::repeat_n(c, run));
                        i += run;
                    }
                }
                '\n' => {
                    if out.ends_with("  ") {
                        let trimmed = out.trim_end_matches(' ').len();
                        out.truncate(trimmed);
                        out.push_str("<br />\n");
                    } else {
                        let trimmed = out.trim_end_matches(' ').len();
                        out.truncate(trimmed);
                        out.push('\n');
                    }
                    i += 1;
                }
                'h' | 'w' if !self.in_link => {
                    if let Some((html, end)) = bare_url(chars, i) {
                        out.push_str(&html);
                        i = end;
                    } else {
                        out.push(c);
                        i += 1;
                    }
                }
                _ => {
                    push_escaped(&mut out, c);
                    i += 1;
                }
            }
        }
        out
    }

    /// Emphasis-like spans: `*em*`, `**strong**`, `***both***`, `_em_`,
    /// `~~strike~~` and `==highlight==`.
    fn emphasis(&mut self, chars: &[char], i: usize) -> Option<(String, usize)> {
        let c = chars[i];
        let run = run_length(chars, i);
        let before = if i == 0 { None } else { Some(chars[i - 1]) };
        let after = chars.get(i + run).copied();

        match c {
            '~' | '=' if run != 2 => return None,
            '*' | '_' if run > 3 => return None,
            _ => {}
        }
        // Opening delimiters must be followed by non-whitespace.
        if is_ws(after) {
            return None;
        }
        // Intraword underscores don't open emphasis.
        if c == '_' && before.is_some_and(char::is_alphanumeric) {
            return None;
        }
        // Left-flanking rule: punctuation after the run requires whitespace or
        // punctuation before it.
        if is_punct(after) && !(is_ws(before) || is_punct(before)) && c != '~' && c != '=' {
            return None;
        }

        let close = find_closer(chars, i + run, c, run)?;
        let inner = self.inline_chars(&chars[i + run..close]);
        let html = match (c, run) {
            ('~', _) => format!("<del>{inner}</del>"),
            ('=', _) => format!("<mark>{inner}</mark>"),
            (_, 1) => format!("<em>{inner}</em>"),
            (_, 2) => format!("<strong>{inner}</strong>"),
            _ => format!("<em><strong>{inner}</strong></em>"),
        };
        Some((html, close + run))
    }

    fn footnote_ref(&mut self, chars: &[char], i: usize) -> Option<(String, usize)> {
        if chars.get(i + 1) != Some(&'^') {
            return None;
        }
        let close = chars[i + 2..].iter().position(|&c| c == ']')? + i + 2;
        let label: String = chars[i + 2..close].iter().collect();
        let key = normalize_label(&label);
        if !self.footnote_defs.contains_key(&key) {
            return None;
        }
        let number = match self.footnote_order.iter().position(|l| *l == key) {
            Some(pos) => pos + 1,
            None => {
                self.footnote_order.push(key);
                self.footnote_order.len()
            }
        };
        Some((
            format!(
                "<sup class=\"footnote-ref\"><a href=\"#fn-{number}\" id=\"fnref-{number}\">{number}</a></sup>"
            ),
            close + 1,
        ))
    }

    /// Parse `[text](url "title")`, `[text][ref]`, `[text][]` or `[text]`
    /// starting at the opening bracket `i`.
    fn parse_link(&self, chars: &[char], i: usize) -> Option<(Link, usize)> {
        let close = matching_bracket(chars, i)?;
        let text: String = chars[i + 1..close].iter().collect();
        let mut j = close + 1;

        if chars.get(j) == Some(&'(') {
            j += 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            let mut url = String::new();
            if chars.get(j) == Some(&'<') {
                j += 1;
                while j < chars.len() && chars[j] != '>' {
                    if chars[j] == '\n' {
                        return None;
                    }
                    url.push(chars[j]);
                    j += 1;
                }
                j += 1;
            } else {
                let mut depth = 0;
                while j < chars.len() {
                    let ch = chars[j];
                    if ch.is_whitespace() {
                        break;
                    }
                    if ch == '\\' && chars.get(j + 1).is_some_and(|&c| is_ascii_punct(c)) {
                        url.push(chars[j + 1]);
                        j += 2;
                        continue;
                    }
                    if ch == '(' {
                        depth += 1;
                    } else if ch == ')' {
                        if depth == 0 {
                            break;
                        }
                        depth -= 1;
                    }
                    url.push(ch);
                    j += 1;
                }
            }
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            let mut title = None;
            if let Some(&q) = chars.get(j)
                && (q == '"' || q == '\'' || q == '(')
            {
                let end_q = if q == '(' { ')' } else { q };
                let start = j + 1;
                let end = chars[start..].iter().position(|&c| c == end_q)? + start;
                title = Some(chars[start..end].iter().collect());
                j = end + 1;
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
            }
            if chars.get(j) != Some(&')') {
                return None;
            }
            return Some((Link { text, url, title }, j + 1));
        }

        // Reference-style links.
        if chars.get(j) == Some(&'[')
            && let Some(ref_close) = chars[j + 1..].iter().position(|&c| c == ']')
        {
            let ref_close = ref_close + j + 1;
            let label: String = chars[j + 1..ref_close].iter().collect();
            let key = if label.trim().is_empty() {
                normalize_label(&text)
            } else {
                normalize_label(&label)
            };
            if let Some((url, title)) = self.link_refs.get(&key) {
                return Some((
                    Link {
                        text,
                        url: url.clone(),
                        title: title.clone(),
                    },
                    ref_close + 1,
                ));
            }
            return None;
        }
        let (url, title) = self.link_refs.get(&normalize_label(&text))?;
        Some((
            Link {
                text,
                url: url.clone(),
                title: title.clone(),
            },
            close + 1,
        ))
    }
}

fn find_closer(chars: &[char], from: usize, c: char, run: usize) -> Option<usize> {
    let mut j = from;
    while j < chars.len() {
        let ch = chars[j];
        if ch == '\\' {
            j += 2;
            continue;
        }
        if ch == '`' {
            j = code_span_end(chars, j).unwrap_or(j + run_length(chars, j));
            continue;
        }
        if ch == '[' {
            // Skip over link text/destinations so `*` inside URLs is ignored.
            if let Some(close) = matching_bracket(chars, j)
                && chars.get(close + 1) == Some(&'(')
                && let Some(end) = chars[close + 1..].iter().position(|&c| c == ')')
            {
                j = close + 1 + end + 1;
                continue;
            }
        }
        if ch == c {
            let len = run_length(chars, j);
            let before = chars.get(j.wrapping_sub(1)).copied().filter(|_| j > 0);
            let after = chars.get(j + len).copied();
            let right_flanking = !is_ws(before);
            let underscore_ok = c != '_' || !after.is_some_and(char::is_alphanumeric);
            if len == run && right_flanking && underscore_ok && j > from {
                return Some(j);
            }
            // A longer run may contain the closer at its end (e.g. `*a **b***`).
            if len > run && right_flanking && underscore_ok && j > from && (c == '*' || c == '_') {
                let candidate = j + len - run;
                // Only valid if the remaining prefix closes something nested;
                // accept it when the inner text has an opener of that size.
                let inner_has_opener = chars[from..j]
                    .windows(len - run)
                    .any(|w| w.iter().all(|&x| x == c));
                if inner_has_opener {
                    return Some(candidate);
                }
            }
            j += len;
            continue;
        }
        j += 1;
    }
    None
}

fn matching_bracket(chars: &[char], open: usize) -> Option<usize> {
    let mut depth = 0;
    let mut j = open;
    while j < chars.len() {
        match chars[j] {
            '\\' => {
                j += 2;
                continue;
            }
            '`' => {
                if let Some(end) = code_span_end(chars, j) {
                    j = end;
                    continue;
                }
            }
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(j);
                }
            }
            _ => {}
        }
        j += 1;
    }
    None
}

fn autolink(chars: &[char], i: usize) -> Option<(String, usize)> {
    let end = chars[i + 1..]
        .iter()
        .position(|&c| c == '>' || c == '<' || c == ' ' || c == '\n')?
        + i
        + 1;
    if chars[end] != '>' {
        return None;
    }
    let inner: String = chars[i + 1..end].iter().collect();
    let is_url = inner.split_once(':').is_some_and(|(scheme, _)| {
        scheme.len() >= 2
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    if is_url {
        return Some((
            format!(
                "<a href=\"{}\">{}</a>",
                escape_attr(&inner),
                escape_html(&inner)
            ),
            end + 1,
        ));
    }
    let is_email = inner.contains('@')
        && !inner.starts_with('@')
        && !inner.ends_with('@')
        && inner
            .chars()
            .all(|c| c.is_alphanumeric() || ".!#$%&'*+/=?^_`{|}~-@".contains(c));
    if is_email {
        return Some((
            format!(
                "<a href=\"mailto:{}\">{}</a>",
                escape_attr(&inner),
                escape_html(&inner)
            ),
            end + 1,
        ));
    }
    None
}

fn inline_html(chars: &[char], i: usize) -> Option<(String, usize)> {
    let next = *chars.get(i + 1)?;
    if !(next.is_ascii_alphabetic() || next == '/' || next == '!') {
        return None;
    }
    if next == '!' {
        // HTML comment.
        let text: String = chars[i..].iter().collect();
        if text.starts_with("<!--") {
            let end = text.find("-->")? + 3;
            let consumed = text[..end].chars().count();
            return Some((text[..end].to_string(), i + consumed));
        }
        return None;
    }
    let name_start = if next == '/' { i + 2 } else { i + 1 };
    if !chars.get(name_start)?.is_ascii_alphabetic() {
        return None;
    }
    let mut j = name_start;
    let mut quote: Option<char> = None;
    while j < chars.len() {
        let c = chars[j];
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == '>' => {
                let tag: String = chars[i..=j].iter().collect();
                return Some((tag, j + 1));
            }
            None if c == '<' => return None,
            None => {}
        }
        j += 1;
    }
    None
}

fn entity_end(chars: &[char], i: usize) -> Option<usize> {
    let mut j = i + 1;
    if chars.get(j) == Some(&'#') {
        j += 1;
        let hex = matches!(chars.get(j), Some('x') | Some('X'));
        if hex {
            j += 1;
        }
        let start = j;
        while j < chars.len()
            && (if hex {
                chars[j].is_ascii_hexdigit()
            } else {
                chars[j].is_ascii_digit()
            })
        {
            j += 1;
        }
        if j == start || j - start > 7 {
            return None;
        }
    } else {
        let start = j;
        while j < chars.len() && chars[j].is_ascii_alphanumeric() {
            j += 1;
        }
        if j == start || j - start > 32 {
            return None;
        }
    }
    (chars.get(j) == Some(&';')).then_some(j + 1)
}

fn bare_url(chars: &[char], i: usize) -> Option<(String, usize)> {
    if i > 0 && (chars[i - 1].is_alphanumeric() || chars[i - 1] == '/' || chars[i - 1] == '"') {
        return None;
    }
    let rest: String = chars[i..chars.len().min(i + 8)].iter().collect();
    let prefix_ok =
        rest.starts_with("http://") || rest.starts_with("https://") || rest.starts_with("www.");
    if !prefix_ok {
        return None;
    }
    let mut end = i;
    while end < chars.len() && !chars[end].is_whitespace() && chars[end] != '<' {
        end += 1;
    }
    // Trailing punctuation is not part of the URL.
    while end > i
        && matches!(
            chars[end - 1],
            '.' | ',' | ':' | ';' | '!' | '?' | '"' | '\'' | '*' | '_' | '~'
        )
    {
        end -= 1;
    }
    // Drop an unbalanced closing parenthesis.
    if end > i && chars[end - 1] == ')' {
        let opens = chars[i..end].iter().filter(|&&c| c == '(').count();
        let closes = chars[i..end].iter().filter(|&&c| c == ')').count();
        if closes > opens {
            end -= 1;
        }
    }
    let url: String = chars[i..end].iter().collect();
    if url.len() <= 7 || url == "https://" {
        return None;
    }
    let href = if url.starts_with("www.") {
        format!("https://{url}")
    } else {
        url.clone()
    };
    Some((
        format!(
            "<a href=\"{}\">{}</a>",
            escape_attr(&href),
            escape_html(&url)
        ),
        end,
    ))
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

fn push_escaped(out: &mut String, c: char) {
    match c {
        '&' => out.push_str("&amp;"),
        '<' => out.push_str("&lt;"),
        '>' => out.push_str("&gt;"),
        '"' => out.push_str("&quot;"),
        _ => out.push(c),
    }
}

pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        push_escaped(&mut out, c);
    }
    out
}

pub fn escape_attr(s: &str) -> String {
    escape_html(s).replace('\'', "&#39;")
}

/// Strip tags and decode the basic entities from rendered inline HTML.
fn plain_text(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::render;

    fn html(md: &str) -> String {
        render(md).html
    }

    #[test]
    fn headings_and_paragraphs() {
        let out = html("# Title\n\nSome *emphasis* and **strong**\ntext.\n\nSetext\n---\n");
        assert!(out.contains("<h1 id=\"title\">Title</h1>"));
        assert!(out.contains("<p>Some <em>emphasis</em> and <strong>strong</strong>\ntext.</p>"));
        assert!(out.contains("<h2 id=\"setext\">Setext</h2>"));
    }

    #[test]
    fn duplicate_heading_ids_are_unique() {
        let out = html("## Task\n\n## Task\n\n## Custom {#mine}\n");
        assert!(out.contains("id=\"task\""));
        assert!(out.contains("id=\"task-1\""));
        assert!(out.contains("<h2 id=\"mine\">Custom</h2>"));
    }

    #[test]
    fn nested_lists_with_code() {
        let md = "1. Open terminal:\n   - Windows: right click\n   - Mac: press keys\n\n2. Connect:\n   ```bash\n   ssh abc12@raptor\n   ```\n   Replace `abc12`.\n";
        let out = html(md);
        assert!(
            out.starts_with("<ol>\n<li><p>Open terminal:</p>\n<ul>\n<li>Windows: right click</li>")
        );
        assert!(out.contains("language-bash"));
        assert!(out.contains("<p>Replace <code>abc12</code>.</p>"));
        assert_eq!(out.matches("<ol>").count(), 1);
    }

    #[test]
    fn tight_list() {
        let out = html("- a\n- b\n  - c\n");
        assert_eq!(
            out,
            "<ul>\n<li>a</li>\n<li>b\n<ul>\n<li>c</li>\n</ul></li>\n</ul>\n"
        );
    }

    #[test]
    fn ordered_start_and_task_list() {
        assert!(html("3. three\n4. four\n").contains("<ol start=\"3\">"));
        let out = html("- [x] done\n- [ ] todo\n");
        assert!(out.contains("<ul class=\"task-list\">"));
        assert!(out.contains("checked /> done</li>"));
    }

    #[test]
    fn tables() {
        let out = html("| a | b |\n|:--|--:|\n| `x|y` | 2 |\n");
        assert!(out.contains("<th style=\"text-align: left\">a</th>"));
        assert!(out.contains("<td style=\"text-align: left\"><code>x|y</code></td>"));
        assert!(out.contains("<td style=\"text-align: right\">2</td>"));
    }

    #[test]
    fn links_images_and_autolinks() {
        let out = html(
            "[site](https://example.com \"T\") ![alt](img.png) <https://a.b> see https://rust-lang.org.\n\n[ref]: https://ref.example\n\nA [ref] link.",
        );
        assert!(out.contains("<a href=\"https://example.com\" title=\"T\">site</a>"));
        assert!(out.contains("<img src=\"img.png\" alt=\"alt\" />"));
        assert!(out.contains("<a href=\"https://a.b\">https://a.b</a>"));
        assert!(out.contains("<a href=\"https://rust-lang.org\">https://rust-lang.org</a>."));
        assert!(out.contains("<a href=\"https://ref.example\">ref</a>"));
    }

    #[test]
    fn figure_from_titled_image() {
        let out = html("![A cat](cat.png \"Figure 1: A cat\")");
        assert!(out.contains("<figure>"));
        assert!(out.contains("<figcaption>Figure 1: A cat</figcaption>"));
    }

    #[test]
    fn blockquotes_and_alerts() {
        let out = html("> quoted\nlazy\n> > nested\n");
        assert!(out.contains("<blockquote>\n<p>quoted\nlazy</p>\n<blockquote>"));
        let alert = html("> [!WARNING]\n> Careful\n");
        assert!(alert.contains("alert-warning"));
        assert!(alert.contains("<p>Careful</p>"));
    }

    #[test]
    fn inline_edge_cases() {
        let out = html(
            "snake_case_name and 2 * 3 * 4 and \\*literal\\* and ~~gone~~ ==marked== a < b & c",
        );
        assert!(out.contains("snake_case_name"));
        assert!(out.contains("2 * 3 * 4"));
        assert!(out.contains("*literal*"));
        assert!(out.contains("<del>gone</del>"));
        assert!(out.contains("<mark>marked</mark>"));
        assert!(out.contains("a &lt; b &amp; c"));
    }

    #[test]
    fn nested_emphasis() {
        assert!(html("**bold *ital* bold**").contains("<strong>bold <em>ital</em> bold</strong>"));
        assert!(html("***both***").contains("<em><strong>both</strong></em>"));
        assert!(html("*a **b***").contains("<em>a <strong>b</strong></em>"));
    }

    #[test]
    fn footnotes_and_toc() {
        let out = html("[TOC]\n\n# One\n\nText[^n].\n\n[^n]: The note.\n");
        assert!(out.contains("<nav class=\"toc\">"));
        assert!(out.contains("href=\"#one\""));
        assert!(
            out.contains(
                "<sup class=\"footnote-ref\"><a href=\"#fn-1\" id=\"fnref-1\">1</a></sup>"
            )
        );
        assert!(out.contains("<li id=\"fn-1\">"));
    }

    #[test]
    fn page_breaks_hr_and_html() {
        let out = html("a\n\n\\pagebreak\n\n***\n\n<div class=\"x\">\nraw\n</div>\n");
        assert!(out.contains("<div class=\"page-break\"></div>"));
        assert!(out.contains("<hr />"));
        assert!(out.contains("<div class=\"x\">\nraw\n</div>"));
    }

    #[test]
    fn hard_breaks() {
        let out = html("line one  \nline two\\\nline three");
        assert_eq!(out, "<p>line one<br />\nline two<br />\nline three</p>\n");
    }

    #[test]
    fn title_from_first_h1() {
        assert_eq!(render("### Sub\n# Main\n").title.as_deref(), Some("Main"));
    }
}
