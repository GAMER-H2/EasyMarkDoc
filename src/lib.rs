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

    // Fenced code block state
    let mut in_code_block = false;
    let mut code_fence_char: char = '`';
    let mut code_fence_len: usize = 0;
    let mut code_lang: Option<String> = None;

    for line in md_text.lines() {
        let trimmed = line.trim();

        // Handle fenced code block opening: ``` or ~~~
        if !in_code_block {
            if !trimmed.is_empty() && (trimmed.starts_with("```") || trimmed.starts_with("~~~")) {
                let fence_char = trimmed.chars().next().unwrap();
                let fence_len = trimmed.chars().take_while(|&c| c == fence_char).count();
                if fence_len >= 3 {
                    // Close any open paragraph or list before starting a code block
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
                    let rest = trimmed[fence_len..].trim();
                    code_lang = if rest.is_empty() {
                        None
                    } else {
                        Some(rest.to_string())
                    };

                    if let Some(lang) = &code_lang {
                        html_text.push_str(
                            format!("<pre><code class=\"language-{}\">\n", html_escape(lang))
                                .as_str(),
                        );
                    } else {
                        html_text.push_str("<pre><code>\n");
                    }
                    continue;
                }
            }
        } else {
            // Currently inside a fenced code block: look for closing fence
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
                    // Close code block
                    html_text.push_str("</code></pre>\n");
                    in_code_block = false;
                    code_fence_len = 0;
                    code_lang = None;
                    continue;
                }
            }

            // Emit code line (escape HTML characters but preserve spacing)
            for ch in line.chars() {
                match ch {
                    '&' => html_text.push_str("&amp;"),
                    '<' => html_text.push_str("&lt;"),
                    '>' => html_text.push_str("&gt;"),
                    '"' => html_text.push_str("&quot;"),
                    _ => html_text.push(ch),
                }
            }
            html_text.push('\n');
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

    if in_code_block {
        html_text.push_str("</code></pre>\n");
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
    std::fs::read_to_string("src/styles.css").unwrap_or_default()
}

#[wasm_bindgen]
pub fn document_builder_wasm(md_text: String) -> String {
    document_builder(md_text)
}
