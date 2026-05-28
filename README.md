# EasyMarkDoc

Convert Markdown documents to HTML or PDF with syntax highlighting.

## Features

- Convert Markdown to HTML
- Convert Markdown to A4-sized PDF documents **(pure Rust, no Chrome needed!)**
- Syntax highlighting for code blocks using the Dracula theme
- Support for headings, lists, bold, italic, and inline code
- Command-line interface for easy usage
- Embedded Roboto fonts for PDF generation

## Installation

```bash
cargo build --release
```

## Usage

### Generate PDF (default)

```bash
./target/release/EasyMarkDoc input.md output.pdf
```

This generates a PDF directly from Markdown.

### Generate only HTML

```bash
./target/release/EasyMarkDoc --html-only input.md output.html
```

### Command-line Options

```
Usage: EasyMarkDoc [OPTIONS] <MD_LOCATION> <OUTPUT_LOCATION>

Arguments:
  <MD_LOCATION>      Path to the input Markdown file
  <OUTPUT_LOCATION>  Path to the output file (HTML or PDF)

Options:
      --html-only  Generate only HTML output (default is to generate PDF)
  -h, --help       Print help
  -V, --version    Print version
```

## PDF Generation

PDF generation uses **pure Rust** with the `genpdf` library and embedded Roboto fonts. **No Chrome or external dependencies required!**

The PDF output is formatted for A4 paper size (210 × 297 mm) with automatic:
- **Text wrapping** within page margins
- **Multi-page** document handling
- **Pagination** when content exceeds one page

### Benefits

- **Lightweight**: No need to install Chrome/Chromium
- **Fast**: Direct Markdown to PDF conversion
- **Portable**: Works anywhere Rust compiles
- **Embedded fonts**: Roboto fonts are included in the binary
- **Smart layout**: Automatic text wrapping and page breaks

## Supported Markdown Features

- **Headings**: `# H1` through `###### H6`
- **Bold**: `**bold text**`
- **Italic**: `*italic text*`
- **Inline code**: `` `code` ``
- **Code blocks**: Triple backticks with optional language specification
- **Unordered lists**: `- item` or `* item`
- **Ordered lists**: `1. item`, `2. item`, etc.

## Example

Input (`example.md`):
```markdown
# My Document

This is a **bold** statement with *italic* emphasis.

## Code Example

\`\`\`rust
fn main() {
    println!("Hello, world!");
}
\`\`\`
```

Generate HTML only:
```bash
./target/release/EasyMarkDoc --html-only example.md example.html
```

Generate PDF:
```bash
./target/release/EasyMarkDoc example.md example.pdf
```

## Library Usage

The core functionality is also available as a library:

```rust
use EasyMarkDoc;

// Convert Markdown to HTML
let html = EasyMarkDoc::document_builder(markdown_text);

// Convert Markdown to PDF (pure Rust, no Chrome needed!)
EasyMarkDoc::markdown_to_pdf(&markdown_text, "output.pdf")?;
```

## Technical Details

- **HTML Generation**: Uses a custom Markdown parser with syntax highlighting via `syntect`
- **PDF Generation**: Uses `genpdf` for direct PDF creation from Markdown with automatic text wrapping and pagination
- **Fonts**: Roboto Regular and Bold fonts embedded in the binary
- **No external dependencies**: Everything needed is compiled into the binary

## License

See LICENSE file for details.
