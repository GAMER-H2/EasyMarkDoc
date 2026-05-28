use clap::Parser;

#[derive(Parser)]
#[command(version, about = "Convert Markdown to HTML or PDF")]
struct Args {
    /// Path to the input Markdown file
    md_location: String,

    /// Path to the output file (HTML or PDF)
    output_location: String,

    /// Generate only HTML output (default is to generate PDF)
    #[arg(long, default_value_t = false)]
    html_only: bool,
}

fn main() {
    let args = Args::parse();
    let markdown =
        std::fs::read_to_string(&args.md_location).expect("failed to read markdown file");

    if args.html_only {
        // Only output HTML
        let html = EasyMarkDoc::document_builder(markdown);
        std::fs::write(&args.output_location, html).expect("failed to write html file");
        println!("HTML generated: {}", args.output_location);
    } else {
        // Generate PDF directly from Markdown
        let pdf_path = if args.output_location.ends_with(".pdf") {
            args.output_location.clone()
        } else if args.output_location.ends_with(".html") {
            args.output_location.replace(".html", ".pdf")
        } else {
            format!("{}.pdf", args.output_location)
        };

        match EasyMarkDoc::markdown_to_pdf(&markdown, &pdf_path) {
            Ok(_) => {
                println!("PDF generated: {}", pdf_path);
            }
            Err(e) => {
                eprintln!("Failed to generate PDF: {}", e);
                eprintln!("Try using --html-only to generate HTML instead.");
                std::process::exit(1);
            }
        }
    }
}
