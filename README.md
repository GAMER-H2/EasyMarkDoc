# EasyMarkDoc

Turn Markdown into well-designed PDF documents, styled entirely with CSS.

EasyMarkDoc renders Markdown to HTML with its own parser, applies a CSS theme,
and prints it to PDF with headless Chromium, so the PDF follows the CSS
exactly, including page size, margins, headers/footers and page numbers.

There are four ways to use it:

1. **Command line**: `EasyMarkDoc notes.md` writes `notes.pdf`.
2. **Web editor**: `EasyMarkDoc serve` opens a Pages-style editor where you
   type directly onto the pages (or into the Markdown source, kept in sync),
   style the document with an inspector, and lay out images by dragging.
3. **VS Code extension**: a live PDF preview beside your editor, plus export.
4. **Zed extension**: export and a live browser preview from Zed's code
   actions.

## Installation

```bash
cargo install --path . --force   # builds and puts EasyMarkDoc on your PATH
```

Use `--force` when updating, so cargo replaces the previously installed copy.
To just build without installing, run `cargo build --release`; the binary
is `target/release/EasyMarkDoc`.

The web editor's files are compiled into the binary, so stop any running
`EasyMarkDoc serve` and start it again after reinstalling. The editor works
in current Chromium-based browsers (Chrome, Edge, Arc, Brave) and
Firefox-based browsers (Firefox, Zen). If a browser still shows an old
version after an update, reload the page once.

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

This opens `http://127.0.0.1:4848/` in your browser. The layout follows Apple
Pages, with the inspector as a **format bar** across the top so the source and
the pages get the full width:

- **Toolbar**:
  - View (show or hide the source and the format bar) and Zoom
  - the document title (rename, open, save)
  - Insert (page break, table of contents, footnote, code, quote, checklist, link)
  - Table (pick a size), Media (add images), Proof (show the exact PDF)
  - Export
  - Format / Document (switch the format bar, or click again to hide it)
- **Format bar** (tabs on its left; scroll sideways if the window is narrow):
  - *Format › Style*: paragraph style (Body, Heading 1–4, Quote, Code);
    the style's font, size and colour; bold, italic, strikethrough,
    highlight, code and link; alignment; bullets and lists
  - *Format › Layout*: line and paragraph spacing, indents, and settings
    for the current heading, quote, code block or table
  - *Document*: paper size and orientation, margins, header and footer
    (with page number, page count, title and date fields), heading numbering
  - *Theme*: style sets, fonts, colours, code, tables, quotes and captions,
    and loading or saving the theme file
- **Markdown source** on the left (Markdown and Theme CSS tabs). Edits there
  update the pages. The **› and ‹ buttons** between the panels jump from your
  cursor in the source to the same place on the page, and back.
- **Pages**: the document laid out in pages exactly as it will print. Click
  and type to edit it. Every edit is written back into the Markdown as you
  type, and Enter, Backspace, Tab, Shift+Enter, paste and ⌘B/⌘I/⌘K work as
  you'd expect. Checkboxes can be ticked on the page. Links are edited like
  any other text; ⌘/Ctrl-click follows one (links in the table of contents
  jump to their heading).
- **Proof**: the real PDF from Chromium, read-only. The jump buttons work
  here too (click the PDF, then ‹).

Paragraph-style and document settings are CSS variables in the theme (see
the Theme CSS tab), so a theme saved as `easymarkdoc.css` applies to the
command line and VS Code too. Fonts that aren't installed on your computer
are marked in the font menus; they would fall back to another font in the PDF.

With **text selected on the page**, the font, size and colour controls change
just that text (the Font section's label turns blue to show it). This is
stored as an HTML span in the Markdown, e.g.
`<span style="color: #c00000">important</span>`; the clear-style button
next to Link removes it again.

### Images

Add images with **Media**, by pasting, or by dropping files onto the page.
They're copied into an `images/` folder next to the document. On the page:

- **click** an image to select it, then drag its handles to resize it
- **drag** it to move it to another place in the text
- **double-click** it to edit its crop mask: drag to reposition, scroll to
  zoom, then click Done
- press **Delete** to remove it

The Format inspector for a selected image has the rest:

- *Style*: frame presets (framed, polaroid, rounded, circle, outline),
  border, shadow, corner radius and opacity
- *Image*: mask shape and zoom, rotation and flipping, caption and
  description
- *Arrange*: width, text wrap (inline, above and below, or around) and
  alignment

All of this is stored as attributes on the image in the Markdown, so the
source stays readable and the PDF matches the page:

```markdown
![Chart](images/chart.png "Figure 1: Sales"){width=45% align=left wrap shadow=soft .img-rounded}
```

| Attribute | Meaning |
|---|---|
| `width=45%` | width (%, px, mm, cm, in, em) |
| `align=left\|center\|right` | position |
| `wrap` | text wraps around a left/right image |
| `inline` | image sits in the line of text |
| `aspect=4:3 zoom=1.5 focus=30,60` | crop mask: shape, zoom, focal point (%) |
| `rotate=15`, `flip=h\|v\|hv` | rotation (degrees) and flipping |
| `border=2 border-color=#333 border-style=dashed` | border |
| `radius=8` / `radius=50%` | rounded corners |
| `shadow=soft\|medium\|hard\|float`, `opacity=0.8` | shadow, transparency |
| `.img-framed` `.img-polaroid` `.img-rounded` `.img-circle` `.img-outline` | style presets (theme classes) |

A title (`"Figure 1: Sales"`) becomes a caption under the image.

The server listens on localhost only and requires a random per-session token
for every API call.

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
| Open Style Editor in Browser (opens this file in the web editor) | |
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

## Zed extension

The extension lives in [`zed-extension/`](zed-extension). Zed extensions
can't show web content inside the editor, so the extension runs
`EasyMarkDoc lsp` as a language server for Markdown (and CSS, so theme edits
are picked up) and adds these **code actions** to Markdown files. Open them
with ⌘. (Ctrl+. on Linux and Windows) or the ⚡ indicator next to the cursor
line:

| Code action | What it does |
|---|---|
| EasyMarkDoc: Export PDF | Saves `name.pdf` next to the file (or in `output_directory`), then offers *Open PDF* / *Reveal in Folder* |
| EasyMarkDoc: Export PDF and Open | The same, then opens the PDF in your PDF viewer |
| EasyMarkDoc: Export HTML | Saves a standalone `name.html` |
| EasyMarkDoc: Open Live Preview in Browser | Opens the preview in your default browser |

Exports and the preview use the text in the editor, including unsaved
changes. The preview updates as you type, and when the theme changes
(including unsaved edits to an open `easymarkdoc.css`). Its toolbar has the
PDF / Pages (fast) toggle and zoom, **Export PDF** (saves to the same place
as the code action), and **Style editor**, which opens the document in the
full web editor. The web editor works on the saved file, so save in Zed
first. Its saves are picked up by Zed and by the preview.

The preview server runs inside the language server, so a preview tab stops
updating when Zed quits. Reopen it with the code action.

### Installing

1. Install EasyMarkDoc so Zed can find it on your `PATH`:

   ```bash
   cargo install --path . --force
   ```

2. Zed compiles extensions itself, so Rust has to be installed through
   [rustup](https://rustup.rs) (Homebrew's Rust is not enough).
3. In Zed, open the command palette and run **zed: install dev extension**,
   then choose the `zed-extension/` folder of this repository.

Open a Markdown file and press ⌘. to see the actions. If they don't appear,
check **zed: open log** for "EasyMarkDoc". If you have restricted Markdown's
language servers in your settings, add `"easymarkdoc"` to that list.

After updating EasyMarkDoc, run `cargo install --path . --force` again and
**editor: restart language server** in Zed. After changing the extension
itself, use **Rebuild** next to it on the Extensions page.

### Settings

All settings are optional. They go in Zed's `settings.json`:

```jsonc
{
  "lsp": {
    "easymarkdoc": {
      // only needed if EasyMarkDoc isn't on your PATH
      "binary": { "path": "/Users/me/.cargo/bin/EasyMarkDoc" },
      "settings": {
        "output_directory": "pdf",        // relative to the Markdown file, or absolute
        "theme_path": "themes/report.css", // relative to the project, or absolute
        "preview_mode": "pdf",            // or "paged" for the fast HTML pages
        "chrome_path": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "allow_browser_download": true
      }
    }
  }
}
```

Without `theme_path`, `easymarkdoc.css` next to the Markdown file is used if
it exists. `chrome_path` and `allow_browser_download` take effect when the
language server restarts. Once you change the preview mode or zoom in the
browser, the browser remembers your choice.

### Publishing

To list the extension in Zed's extension store, add a licence file to
`zed-extension/` (Zed requires one) and open a pull request against
[zed-industries/extensions](https://github.com/zed-industries/extensions)
that adds this repository as a submodule, with `path = "zed-extension"` in
its `extensions.toml` entry (see Zed's
[extension publishing guide](https://zed.dev/docs/extensions/developing-extensions#publishing-your-extension)).
Users still have to install the EasyMarkDoc binary themselves, as in step 1.

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
  lsp.rs         language server for the Zed extension (`EasyMarkDoc lsp`)
  styles.css     default theme
web/             web editor (vanilla JS; vendored CodeMirror 5, pdf.js, paged.js)
  js/document-view.js  editable page view (paged.js + contenteditable)
  js/mdtools.js    page HTML → Markdown, image attributes, structural edits
  js/inspector.js  format bar (Pages-style inspector above the panels)
vscode-extension/
zed-extension/   Zed extension (Rust → WebAssembly; starts `EasyMarkDoc lsp`)
```

Third-party front-end libraries in `web/vendor/` keep their own licences
(CodeMirror: MIT, pdf.js: Apache-2.0, paged.js: MIT).
