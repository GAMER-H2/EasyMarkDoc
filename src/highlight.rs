//! Syntax highlighting for code blocks using syntect.
//!
//! Code is emitted with CSS classes (not inline styles) so the colour scheme
//! is chosen by the stylesheet's `--code-theme` variable.

use std::collections::HashMap;
use std::io::Cursor;
use std::sync::{Mutex, OnceLock};

use syntect::highlighting::{Theme, ThemeSet};
use syntect::html::{ClassStyle, ClassedHTMLGenerator, css_for_theme_with_class_style};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

use crate::markdown::{escape_attr, escape_html};

const DRACULA_THEME: &str = include_str!("dracula.tmTheme");
const CLASS_STYLE: ClassStyle = ClassStyle::SpacedPrefixed { prefix: "syntax-" };

/// Code themes available to `--code-theme`, as (id, display name).
pub const CODE_THEMES: &[(&str, &str)] = &[
    ("dracula", "Dracula"),
    ("github", "GitHub (light)"),
    ("solarized-light", "Solarized Light"),
    ("solarized-dark", "Solarized Dark"),
    ("ocean-dark", "Ocean Dark"),
    ("ocean-light", "Ocean Light"),
    ("eighties", "Eighties"),
    ("mocha", "Mocha"),
];

pub const DEFAULT_CODE_THEME: &str = "dracula";

static SYNTAX_SET: OnceLock<SyntaxSet> = OnceLock::new();
static THEME_SET: OnceLock<ThemeSet> = OnceLock::new();
static DRACULA: OnceLock<Theme> = OnceLock::new();
static THEME_CSS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn syntax_set() -> &'static SyntaxSet {
    SYNTAX_SET.get_or_init(SyntaxSet::load_defaults_newlines)
}

fn theme(id: &str) -> &'static Theme {
    let set = THEME_SET.get_or_init(ThemeSet::load_defaults);
    let builtin = match id {
        "github" => Some("InspiredGitHub"),
        "solarized-light" => Some("Solarized (light)"),
        "solarized-dark" => Some("Solarized (dark)"),
        "ocean-dark" => Some("base16-ocean.dark"),
        "ocean-light" => Some("base16-ocean.light"),
        "eighties" => Some("base16-eighties.dark"),
        "mocha" => Some("base16-mocha.dark"),
        _ => None,
    };
    if let Some(theme) = builtin.and_then(|name| set.themes.get(name)) {
        return theme;
    }
    DRACULA.get_or_init(|| {
        ThemeSet::load_from_reader(&mut Cursor::new(DRACULA_THEME.as_bytes())).unwrap_or_default()
    })
}

/// CSS rules for the given code theme id (falls back to Dracula).
pub fn theme_css(id: &str) -> String {
    let cache = THEME_CSS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut cache = cache.lock().unwrap();
    cache
        .entry(id.to_string())
        .or_insert_with(|| {
            css_for_theme_with_class_style(theme(id), CLASS_STYLE).unwrap_or_default()
        })
        .clone()
}

/// Render a code block. Unknown or missing languages are rendered as plain
/// text with the same styling so all code blocks look consistent.
pub fn code_block(code: &str, lang: Option<&str>) -> String {
    let set = syntax_set();
    let syntax = lang
        .and_then(|l| set.find_syntax_by_token(l))
        .unwrap_or_else(|| set.find_syntax_plain_text());

    let mut generator = ClassedHTMLGenerator::new_with_class_style(syntax, set, CLASS_STYLE);
    let mut ok = true;
    for line in LinesWithEndings::from(code) {
        if generator
            .parse_html_for_line_which_includes_newline(line)
            .is_err()
        {
            ok = false;
            break;
        }
    }
    let body = if ok {
        generator.finalize()
    } else {
        escape_html(code)
    };

    let lang_class = lang
        .map(|l| format!(" language-{}", escape_attr(l)))
        .unwrap_or_default();
    let label = lang
        .map(|l| format!(" data-lang=\"{}\"", escape_attr(l)))
        .unwrap_or_default();
    format!("<pre class=\"code-block syntax-code{lang_class}\"{label}><code>{body}</code></pre>\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn highlights_known_languages() {
        let html = code_block("fn main() {}\n", Some("rust"));
        assert!(html.starts_with(
            "<pre class=\"code-block syntax-code language-rust\" data-lang=\"rust\"><code>"
        ));
        assert!(html.contains("syntax-"));
    }

    #[test]
    fn plain_blocks_share_styling_and_escape() {
        let html = code_block("<b> & stuff\n", None);
        assert!(html.starts_with("<pre class=\"code-block syntax-code\"><code>"));
        assert!(html.contains("&lt;b&gt; &amp; stuff"));
    }

    #[test]
    fn theme_css_has_background() {
        assert!(theme_css("dracula").contains(".syntax-code"));
        assert!(theme_css("github").contains(".syntax-code"));
    }
}
