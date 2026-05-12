use wasm_bindgen::prelude::*;

pub fn document_builder(md_text: String) -> String {
    let mut html_text = String::new();
    html_text.push_str("<!DOCTYPE html>\n<html>\n<head>\n<title>Document</title>\n");
    html_text.push_str("<style>\n");
    html_text.push_str(get_css().as_str());
    html_text.push_str("\n</style>\n");
    html_text.push_str("</head>\n<body>\n");
    let mut in_paragraph = false;
    let mut in_list = false;

    for line in md_text.lines() {
        let trimmed = line.trim();

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

            let mut item_escaped = String::new();
            let mut chars = rest.chars().peekable();
            let mut bold = false;
            let mut italic = false;
            let mut code = false;

            while let Some(ch) = chars.next() {
                if ch == '*' {
                    if let Some('*') = chars.peek() {
                        chars.next();
                        item_escaped.push_str(if bold { "</strong>" } else { "<strong>" });
                        bold = !bold;
                    } else {
                        item_escaped.push_str(if italic { "</em>" } else { "<em>" });
                        italic = !italic;
                    }
                } else if ch == '`' {
                    item_escaped.push_str(if code { "</code>" } else { "<code>" });
                    code = !code;
                } else {
                    match ch {
                        '&' => item_escaped.push_str("&amp;"),
                        '<' => item_escaped.push_str("&lt;"),
                        '>' => item_escaped.push_str("&gt;"),
                        '"' => item_escaped.push_str("&quot;"),
                        _ => item_escaped.push(ch),
                    }
                }
            }

            if bold {
                item_escaped.push_str("</strong>");
            }
            if italic {
                item_escaped.push_str("</em>");
            }
            if code {
                item_escaped.push_str("</code>");
            }

            html_text.push_str(format!("  <li>{}</li>\n", item_escaped).as_str());
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

    if in_paragraph {
        html_text.push_str("</p>\n");
    }
    if in_list {
        html_text.push_str("</ul>\n");
    }
    html_text.push_str("\n</body>\n</html>");
    html_text
}

fn get_css() -> String {
    std::fs::read_to_string("/Users/mh968/git/EasyMarkDoc/src/styles.css").unwrap_or_default()
}

#[wasm_bindgen]
pub fn document_builder_wasm(md_text: String) -> String {
    document_builder(md_text)
}
