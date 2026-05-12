use clap::Parser;

#[derive(Parser)]
#[command(version, about = "Convert Markdown to HTML")]
struct Args {
    md_location: String,
    html_location: String,
}

fn main() {
    let args = Args::parse();
    let markdown =
        std::fs::read_to_string(&args.md_location).expect("failed to read markdown file");
    let html = EasyMarkDoc::document_builder(markdown);
    std::fs::write(&args.html_location, html).expect("failed to write html file");
}
