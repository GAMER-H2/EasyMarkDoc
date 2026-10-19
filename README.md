# EasyMarkDoc

Turn Markdown into well-designed PDF documents, styled entirely with CSS.

EasyMarkDoc renders Markdown to HTML with its own parser, applies a CSS theme,
and prints it to PDF with headless Chromium, so the PDF follows the CSS
exactly, including page size, margins, headers/footers and page numbers.

There are three ways to use it:

1. **Command line**: `EasyMarkDoc notes.md` writes `notes.pdf`.
2. **Web editor**: `EasyMarkDoc serve` opens a two-panel editor with a live
   PDF preview and a Word-style ribbon that edits the CSS theme for you.
3. **VS Code extension**: a live PDF preview beside your editor, plus export.

## Installation

```bash
cargo build --release
# optional: put it on your PATH
cargo install --path .
```

### PDF engine

PDFs are rendered by a Chromium-based browser in headless mode. EasyMarkDoc
looks for one in this order:

1. `--chrome <path>` (or the `easymarkdoc.chromePath` VS Code setting)
2. the `EASYMARKDOC_CHROME` environment variable
3. a copy of *chrome-headless-shell* previously downloaded by EasyMarkDoc
4. an installed Google Chrome, Chromium, Microsoft Edge, Brave or Vivaldi
5. otherwise it downloads *chrome-headless-shell* (about 100 MB, once) into
   your cache directory (`~/Library/Caches/easymarkdoc` on macOS,
   `~/.cache/easymarkdoc` on Linux, `%LOCALAPPDATA%\easymarkdoc` on Windows)

Run `EasyMarkDoc setup` to see which browser will be used (or to download one
ahead of time). Pass `--no-download` to never download.

> Arc is Chromium-based but does not support headless mode, so it is not used.

## Command line

```bash
EasyMarkDoc notes.md                       # → notes.pdf next to notes.md
EasyMarkDoc notes.md out/                  # → out/notes.pdf
EasyMarkDoc notes.md report.pdf --css theme.css
EasyMarkDoc notes.md --html                # standalone HTML instead of PDF
EasyMarkDoc notes.md --watch --open        # rebuild on every save
EasyMarkDoc theme > my-theme.css           # print the default theme
EasyMarkDoc serve notes.md                 # open the web editor
EasyMarkDoc setup                          # locate/download the PDF engine
```

If a file called `easymarkdoc.css` sits next to the Markdown file, it is used
as the theme automatically (by the CLI, the web editor and VS Code).

## Web editor

```bash
EasyMarkDoc serve [file.md] [--port 4848] [--css theme.css] [--output-dir DIR]
```

This opens `http://127.0.0.1:4848/` in your browser. The editor has:

- **The Document and Theme CSS tabs** on the left. The Markdown editor
  continues lists automatically and has formatting shortcuts (Ctrl/Cmd + B, I,
  K, Alt+1–3 for headings).
- **The preview** on the right:
  - *PDF*: the exact PDF from Chromium. This is the default.
  - *Pages (fast)*: paginated HTML for instant feedback while typing.
- **The ribbon**:
  - *Home*: text formatting, paragraph styles, lists, and inserting tables,
    code, page breaks, a table of contents and footnotes; document font,
    size, colour and alignment
  - *Design*: style sets (Default, Modern, Academic, Report, Technical,
    Elegant, Minimal), colours, code colour scheme, heading numbering
  - *Layout*: page size and orientation, margins (with presets), line and
    paragraph spacing, first-line indent
  - *Headings*: font, weight, colour, sizes, underline rules, alignment
  - *Header & Footer*: left, centre and right text with `{page}`,
    `{pages}`, `{title}` and `{date}` fields; hide on the first page
  - *Tables & More*: table, quote, inline code and image styling
- **File, Theme and Export menus**: upload or open Markdown from disk, save
  it back, load or save themes, and save the PDF (or HTML) to any folder on
  your computer, or download it.

Every ribbon change is written into the theme CSS (visible in the Theme CSS
tab), so you can save it as `easymarkdoc.css` and reuse it from the command
line or VS Code.

The server listens on localhost only, and every API call needs a random
per-session token.

## VS Code extension

The extension lives in [`vscode-extension/`](vscode-extension). It runs
`EasyMarkDoc serve` in the background and shows the preview page beside your
editor, updating as you type (like Live Preview).

Commands (Command Palette → *EasyMarkDoc*):

| Command | Shortcut |
|---|---|
| Open PDF Preview to the Side (also the editor title bar button) | Ctrl/Cmd+Alt+P |
| Export PDF (next to the file, or to `easymarkdoc.outputDirectory`) | Ctrl/Cmd+Alt+E |
| Export PDF As… | |
| Open Style Editor in Browser (opens the web editor's ribbon for this file) | |
| Create Theme File (`easymarkdoc.css`) / Select Theme CSS… | |

The preview reloads when the theme file changes, including unsaved edits to
an open `easymarkdoc.css`.

To install it:

```bash
cargo install --path .            # or set easymarkdoc.executablePath
cd vscode-extension
npx @vscode/vsce package          # creates easymarkdoc-0.2.0.vsix
code --install-extension easymarkdoc-0.2.0.vsix
```

For development, open `vscode-extension/` in VS Code and press F5. When the
workspace is this repository, the extension uses `target/release` or
`target/debug` automatically.

## Themes

A theme is a CSS file layered **on top of** the default theme
([`src/styles.css`](src/styles.css)), so it only needs what it changes:

```css
:root {
    --font-body: "Palatino Linotype", Palatino, serif;
    --page-size: Letter;
    --page-margin-left: 25mm;
    --footer-center: "Page {page} of {pages}";
    --header-right: "{title}";
    --code-theme: github;
    --heading-numbering: h2;
}

/* any CSS you like */
blockquote { font-style: italic; }
```

The settings variables are listed and documented at the top of
`src/styles.css`. EasyMarkDoc builds the `@page` rules (size, margins,
headers and footers), heading numbering, and the syntax-highlighting colours
from them. You can still write your own `@page` rules; they take precedence.

Code colour schemes: `dracula` (default), `github`, `solarized-light`,
`solarized-dark`, `ocean-dark`, `ocean-light`, `eighties`, `mocha`.

## Markdown support

- CommonMark blocks: ATX and setext headings, paragraphs, nested ordered and
  unordered lists (tight and loose), blockquotes, fenced and indented code,
  thematic breaks, raw HTML, hard line breaks
- Inline: emphasis, strong, code spans, links (inline, reference, autolinks,
  bare URLs), images, backslash escapes, HTML entities, inline HTML
- GitHub extensions: tables with alignment, task lists, ~~strikethrough~~,
  footnotes, alerts (`> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`, …)
- Document extras:
  - `[TOC]` inserts a table of contents
  - `\pagebreak` (or `\newpage`, `<!-- pagebreak -->`) starts a new page
  - `==highlight==`
  - `{#id}` after a heading sets a custom anchor
  - an image with a title becomes a captioned figure:
    `![alt](img.png "Figure 1: Caption")`
- Syntax highlighting for fenced code with a language tag (via syntect)

Relative image paths resolve from the Markdown file's folder.

## Library use

```rust
// HTML
let html = easymarkdoc::build_html(markdown, &easymarkdoc::HtmlOptions::default());

// PDF
let engine = easymarkdoc::PdfEngine::launch(&Default::default()).await?;
let pdf = easymarkdoc::render_pdf(&engine, markdown, Some(css), Some(base_dir)).await?;
engine.close().await;
```

## Project layout

```
src/
  main.rs        CLI (convert, serve, theme, setup)
  markdown.rs    Markdown → HTML parser
  highlight.rs   syntax highlighting / code themes
  theme.rs       stylesheet assembly from CSS variables
  document.rs    full HTML document builder
  pdf.rs         Chromium discovery, download and PDF rendering
  server.rs      web editor / preview HTTP server
  styles.css     default theme
web/             web editor (vanilla JS; vendored CodeMirror 5, pdf.js, paged.js)
vscode-extension/
```

Third-party front-end libraries in `web/vendor/` keep their own licences
(CodeMirror: MIT, pdf.js: Apache-2.0, paged.js: MIT).
