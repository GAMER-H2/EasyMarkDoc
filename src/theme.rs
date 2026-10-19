//! Stylesheet assembly.
//!
//! The final stylesheet is: generated rules derived from the theme's CSS
//! variables (page setup, headers/footers, heading numbering, code colours)
//! followed by the default theme and then the user's theme.

use std::collections::HashMap;

use base64::Engine;

use crate::highlight;

/// The built-in default theme.
pub const DEFAULT_CSS: &str = include_str!("styles.css");

const FONT_REGULAR: &[u8] = include_bytes!("Roboto-Regular.ttf");
const FONT_BOLD: &[u8] = include_bytes!("Roboto-Bold.ttf");

/// Build the complete stylesheet for a document.
pub fn stylesheet(user_css: Option<&str>, title: &str) -> String {
    let mut combined = String::from(DEFAULT_CSS);
    if let Some(user) = user_css {
        combined.push_str("\n/* ---- Custom theme ---- */\n");
        combined.push_str(user);
    }
    let vars = parse_variables(&combined);
    let get = |name: &str| vars.get(name).map(String::as_str).unwrap_or("");

    let mut css = String::new();
    if mentions_roboto(&vars) {
        css.push_str(&roboto_font_face());
    }
    css.push_str(&page_rules(&vars, title));
    let code_theme = match get("--code-theme") {
        "" => highlight::DEFAULT_CODE_THEME,
        other => other,
    };
    css.push_str(&highlight::theme_css(code_theme));
    css.push('\n');
    css.push_str(&combined);
    css.push('\n');
    css.push_str(&heading_numbering(get("--heading-numbering")));
    if get("--show-link-urls") == "on" {
        css.push_str(
            "a[href^=\"http\"]::after { content: \" (\" attr(href) \")\"; font-size: 0.85em; color: var(--muted-color); word-break: break-all; }\n",
        );
    }
    css
}

/// Collect custom property declarations (`--name: value;`). Later
/// declarations override earlier ones, matching the cascade for `:root`.
pub fn parse_variables(css: &str) -> HashMap<String, String> {
    let css = strip_comments(css);
    let mut vars = HashMap::new();
    let bytes = css.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        let at_boundary =
            i == 0 || matches!(bytes[i - 1], b'{' | b';' | b' ' | b'\n' | b'\t' | b'\r');
        if at_boundary && bytes[i] == b'-' && bytes[i + 1] == b'-' {
            let name_end = css[i..]
                .find(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_'))
                .map(|p| p + i)
                .unwrap_or(css.len());
            let rest = css[name_end..].trim_start();
            if let Some(value_part) = rest.strip_prefix(':') {
                let value_end = find_value_end(value_part);
                let value = value_part[..value_end].trim().to_string();
                vars.insert(css[i..name_end].to_string(), value);
                i = name_end;
                continue;
            }
            i = name_end;
            continue;
        }
        i += 1;
    }
    vars
}

/// Find the end of a declaration value: the first `;` or `}` outside quotes
/// and parentheses.
fn find_value_end(s: &str) -> usize {
    let mut quote: Option<char> = None;
    let mut depth = 0;
    for (idx, c) in s.char_indices() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None => match c {
                '"' | '\'' => quote = Some(c),
                '(' => depth += 1,
                ')' => depth -= 1,
                ';' | '}' if depth <= 0 => return idx,
                _ => {}
            },
        }
    }
    s.len()
}

fn strip_comments(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(start) = rest.find("/*") {
        out.push_str(&rest[..start]);
        match rest[start + 2..].find("*/") {
            Some(end) => rest = &rest[start + 2 + end + 2..],
            None => {
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

fn page_rules(vars: &HashMap<String, String>, title: &str) -> String {
    let get = |name: &str, default: &str| -> String {
        vars.get(name)
            .filter(|v| !v.is_empty())
            .cloned()
            .unwrap_or_else(|| default.to_string())
    };

    let size = get("--page-size", "A4");
    let orientation = get("--page-orientation", "portrait");
    let size_value = if size.split_whitespace().count() >= 2 {
        size
    } else {
        format!("{size} {orientation}")
    };
    let margin = format!(
        "{} {} {} {}",
        get("--page-margin-top", "20mm"),
        get("--page-margin-right", "18mm"),
        get("--page-margin-bottom", "20mm"),
        get("--page-margin-left", "18mm"),
    );
    let background = get("--page-background", "#ffffff");
    let font = get("--font-body", "serif");
    let font_size = get("--header-footer-font-size", "9pt");
    let color = get("--header-footer-color", "#6b7280");

    let mut css = format!(
        "@page {{\n    size: {size_value};\n    margin: {margin};\n    background: {background};\n"
    );
    let boxes = [
        ("top-left", "--header-left", "left"),
        ("top-center", "--header-center", "center"),
        ("top-right", "--header-right", "right"),
        ("bottom-left", "--footer-left", "left"),
        ("bottom-center", "--footer-center", "center"),
        ("bottom-right", "--footer-right", "right"),
    ];
    let mut any_box = false;
    for (margin_box, var, align) in boxes {
        let Some(content) = vars.get(var).and_then(|v| margin_box_content(v, title)) else {
            continue;
        };
        any_box = true;
        css.push_str(&format!(
            "    @{margin_box} {{ content: {content}; font-family: {font}; font-size: {font_size}; color: {color}; text-align: {align}; }}\n"
        ));
    }
    css.push_str("}\n");

    if any_box && get("--first-page-header-footer", "show") == "hide" {
        css.push_str("@page :first {\n");
        for (margin_box, _, _) in boxes {
            css.push_str(&format!("    @{margin_box} {{ content: none; }}\n"));
        }
        css.push_str("}\n");
    }
    css
}

/// Convert a header/footer template such as `"Page {page} of {pages}"` into
/// a CSS `content` value. Returns `None` for empty templates.
fn margin_box_content(value: &str, title: &str) -> Option<String> {
    let text = unquote(value.trim());
    if text.trim().is_empty() || text.trim() == "none" {
        return None;
    }
    let date = today();
    let mut parts: Vec<String> = Vec::new();
    let mut literal = String::new();
    let mut rest = text.as_str();
    while let Some(start) = rest.find('{') {
        let Some(len) = rest[start..].find('}') else {
            break;
        };
        let token = &rest[start + 1..start + len];
        let replacement = match token {
            "page" => Some("counter(page)".to_string()),
            "pages" => Some("counter(pages)".to_string()),
            _ => None,
        };
        literal.push_str(&rest[..start]);
        match (token, replacement) {
            (_, Some(counter)) => {
                if !literal.is_empty() {
                    parts.push(css_string(&literal));
                    literal.clear();
                }
                parts.push(counter);
            }
            ("title", None) => literal.push_str(title),
            ("date", None) => literal.push_str(&date),
            _ => literal.push_str(&rest[start..start + len + 1]),
        }
        rest = &rest[start + len + 1..];
    }
    literal.push_str(rest);
    if !literal.is_empty() {
        parts.push(css_string(&literal));
    }
    Some(parts.join(" "))
}

fn unquote(value: &str) -> String {
    let v = value.trim();
    if v.len() >= 2
        && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')))
    {
        v[1..v.len() - 1].replace("\\\"", "\"").replace("\\'", "'")
    } else {
        v.to_string()
    }
}

fn css_string(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\A "),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

fn heading_numbering(setting: &str) -> String {
    let start = match setting.trim() {
        "h1" | "on" => 1,
        "h2" => 2,
        "h3" => 3,
        _ => return String::new(),
    };
    let levels: Vec<usize> = (start..=6).take(4).collect();
    let mut css = String::new();
    css.push_str(&format!(
        ".markdown-body {{ counter-reset: emd-h{start}; }}\n"
    ));
    for (idx, &level) in levels.iter().enumerate() {
        let reset = levels
            .get(idx + 1)
            .map(|next| format!(" counter-reset: emd-h{next};"))
            .unwrap_or_default();
        let counters: Vec<String> = levels[..=idx]
            .iter()
            .map(|l| format!("counter(emd-h{l})"))
            .collect();
        css.push_str(&format!(
            ".markdown-body h{level} {{ counter-increment: emd-h{level};{reset} }}\n.markdown-body h{level}::before {{ content: {} \". \"; }}\n",
            counters.join(" \".\" ")
        ));
    }
    css
}

fn mentions_roboto(vars: &HashMap<String, String>) -> bool {
    ["--font-body", "--font-heading"]
        .iter()
        .any(|v| vars.get(*v).is_some_and(|f| f.contains("Roboto")))
}

/// Roboto is bundled so there's always a good sans-serif font available.
fn roboto_font_face() -> String {
    let engine = base64::engine::general_purpose::STANDARD;
    format!(
        "@font-face {{ font-family: \"Roboto\"; font-weight: 400; src: url(data:font/ttf;base64,{}) format(\"truetype\"); }}\n\
         @font-face {{ font-family: \"Roboto\"; font-weight: 700; src: url(data:font/ttf;base64,{}) format(\"truetype\"); }}\n",
        engine.encode(FONT_REGULAR),
        engine.encode(FONT_BOLD)
    )
}

/// Today's date (UTC) as YYYY-MM-DD.
fn today() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Civil-from-days algorithm (Howard Hinnant).
    let z = secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_variables_with_override_and_comments() {
        let vars =
            parse_variables(":root { --a: 1px; /* --a: 9px; */ --b: \"x; y\"; }\n:root{--a:2px}");
        assert_eq!(vars["--a"], "2px");
        assert_eq!(vars["--b"], "\"x; y\"");
    }

    #[test]
    fn page_rules_from_variables() {
        let css = stylesheet(
            Some(
                ":root { --page-size: Letter; --page-orientation: landscape; --header-right: \"{title} – p{page}\"; --first-page-header-footer: hide; }",
            ),
            "My Doc",
        );
        assert!(css.contains("size: Letter landscape;"));
        assert!(css.contains("@top-right { content: \"My Doc – p\" counter(page);"));
        assert!(css.contains("@bottom-center { content: counter(page) \" / \" counter(pages);"));
        assert!(css.contains("@page :first"));
    }

    #[test]
    fn heading_numbering_rules() {
        let css = heading_numbering("h2");
        assert!(css.contains("counter-reset: emd-h2"));
        assert!(css.contains("h3::before { content: counter(emd-h2) \".\" counter(emd-h3) \". \""));
        assert!(heading_numbering("off").is_empty());
    }

    #[test]
    fn date_format() {
        let d = today();
        assert_eq!(d.len(), 10);
        assert!(d.starts_with("20"));
    }
}
