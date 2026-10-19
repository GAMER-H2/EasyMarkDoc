use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand};

use easymarkdoc::document::{self, HtmlOptions};
use easymarkdoc::pdf::{self, EngineOptions, PdfEngine};
use easymarkdoc::server::{self, ServeOptions};
use easymarkdoc::theme;

#[derive(Parser)]
#[command(
    version,
    about = "Convert Markdown into beautifully styled PDF documents",
    args_conflicts_with_subcommands = true,
    after_help = "Examples:\n  EasyMarkDoc notes.md                 # writes notes.pdf\n  EasyMarkDoc notes.md out/ --css theme.css\n  EasyMarkDoc serve notes.md           # open the web editor\n  EasyMarkDoc theme > my-theme.css     # start a custom theme"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    #[command(flatten)]
    convert: ConvertArgs,
}

#[derive(Subcommand)]
enum Command {
    /// Convert a Markdown file to PDF (or HTML)
    Convert(ConvertArgs),
    /// Start the web editor with live PDF preview
    Serve(ServeArgs),
    /// Print the default CSS theme (use it as a starting point)
    Theme {
        /// Write to this file instead of stdout
        #[arg(short, long)]
        output: Option<PathBuf>,
    },
    /// Find a browser for PDF rendering, downloading one if needed
    Setup {
        /// Download chrome-headless-shell even if a browser is installed
        #[arg(long)]
        force_download: bool,
    },
}

#[derive(Args, Clone)]
struct BrowserArgs {
    /// Path to a Chrome/Chromium/Edge executable used for PDF rendering
    #[arg(long, value_name = "PATH")]
    chrome: Option<PathBuf>,

    /// Never download a browser automatically
    #[arg(long)]
    no_download: bool,
}

impl BrowserArgs {
    fn engine_options(&self) -> EngineOptions {
        EngineOptions {
            chrome_path: self.chrome.clone(),
            allow_download: !self.no_download,
        }
    }
}

#[derive(Args, Clone)]
struct ConvertArgs {
    /// Markdown file to convert
    input: Option<PathBuf>,

    /// Output file or directory (default: next to the input)
    output: Option<PathBuf>,

    /// CSS theme layered on top of the default theme
    /// (default: easymarkdoc.css next to the input, if present)
    #[arg(long, value_name = "FILE")]
    css: Option<PathBuf>,

    /// Write HTML instead of PDF
    #[arg(long, alias = "html-only")]
    html: bool,

    /// Re-convert whenever the input or theme changes
    #[arg(short, long)]
    watch: bool,

    /// Open the result when done
    #[arg(long)]
    open: bool,

    #[command(flatten)]
    browser: BrowserArgs,
}

#[derive(Args)]
struct ServeArgs {
    /// Markdown file to open in the editor
    file: Option<PathBuf>,

    /// Port to listen on (falls back to a random port if busy; 0 = random)
    #[arg(short, long, default_value_t = 4848)]
    port: u16,

    /// Address to bind to
    #[arg(long, default_value = "127.0.0.1")]
    host: String,

    /// CSS theme to load into the editor
    #[arg(long, value_name = "FILE")]
    css: Option<PathBuf>,

    /// Default directory for saved PDFs
    #[arg(long, value_name = "DIR")]
    output_dir: Option<PathBuf>,

    /// Don't open a browser window
    #[arg(long)]
    no_open: bool,

    /// Session token for API requests (default: random)
    #[arg(long, hide = true)]
    token: Option<String>,

    /// Exit when stdin is closed (used by editor integrations)
    #[arg(long, hide = true)]
    exit_on_stdin_close: bool,

    #[command(flatten)]
    browser: BrowserArgs,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };

    let result = runtime.block_on(async {
        match cli.command {
            Some(Command::Convert(args)) => convert(args).await,
            Some(Command::Serve(args)) => serve(args).await,
            Some(Command::Theme { output }) => print_theme(output),
            Some(Command::Setup { force_download }) => setup(force_download).await,
            None => convert(cli.convert).await,
        }
    });

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}

async fn convert(args: ConvertArgs) -> Result<()> {
    let Some(input) = args.input.clone() else {
        bail!("no input file given. Run `EasyMarkDoc --help` for usage.");
    };
    if !input.is_file() {
        bail!("input file '{}' not found", input.display());
    }
    let input = input.canonicalize()?;
    let base_dir = input.parent().map(Path::to_path_buf).unwrap_or_default();
    let css_path = args
        .css
        .clone()
        .or_else(|| server::discover_theme(&base_dir));
    let output = output_path(&input, args.output.as_deref(), args.html);

    let engine = if args.html {
        None
    } else {
        Some(PdfEngine::launch(&args.browser.engine_options()).await?)
    };

    let result = async {
        convert_once(&input, &output, css_path.as_deref(), engine.as_ref()).await?;
        if args.open {
            let _ = open::that(&output);
        }
        if args.watch {
            watch(&input, &output, css_path.as_deref(), engine.as_ref()).await?;
        }
        Ok(())
    }
    .await;

    if let Some(engine) = engine {
        engine.close().await;
    }
    result
}

async fn convert_once(
    input: &Path,
    output: &Path,
    css_path: Option<&Path>,
    engine: Option<&PdfEngine>,
) -> Result<()> {
    let markdown =
        std::fs::read_to_string(input).with_context(|| format!("reading {}", input.display()))?;
    let css = match css_path {
        Some(p) => {
            Some(std::fs::read_to_string(p).with_context(|| format!("reading {}", p.display()))?)
        }
        None => None,
    };
    let base_dir = input.parent().unwrap_or(Path::new("."));
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    match engine {
        Some(engine) => {
            let pdf =
                easymarkdoc::render_pdf(engine, &markdown, css.as_deref(), Some(base_dir)).await?;
            std::fs::write(output, pdf).with_context(|| format!("writing {}", output.display()))?;
            println!("PDF generated: {}", output.display());
        }
        None => {
            let html = document::build(
                &markdown,
                &HtmlOptions {
                    css,
                    base_href: Some(document::file_base_href(base_dir)),
                    standalone: true,
                    ..Default::default()
                },
            );
            std::fs::write(output, html)
                .with_context(|| format!("writing {}", output.display()))?;
            println!("HTML generated: {}", output.display());
        }
    }
    Ok(())
}

async fn watch(
    input: &Path,
    output: &Path,
    css_path: Option<&Path>,
    engine: Option<&PdfEngine>,
) -> Result<()> {
    let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let snapshot = || -> (Option<SystemTime>, Option<SystemTime>) {
        (modified(input), css_path.and_then(modified))
    };
    let mut last = snapshot();
    eprintln!(
        "Watching {} for changes (Ctrl+C to stop)...",
        input.display()
    );
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => return Ok(()),
            _ = tokio::time::sleep(Duration::from_millis(400)) => {}
        }
        let current = snapshot();
        if current != last {
            last = current;
            if let Err(e) = convert_once(input, output, css_path, engine).await {
                eprintln!("error: {e:#}");
            }
        }
    }
}

/// Work out where to write the output file.
fn output_path(input: &Path, output: Option<&Path>, html: bool) -> PathBuf {
    let extension = if html { "html" } else { "pdf" };
    let file_name = input
        .file_stem()
        .map(|s| format!("{}.{extension}", s.to_string_lossy()))
        .unwrap_or_else(|| format!("document.{extension}"));
    match output {
        None => input.with_file_name(file_name),
        Some(out) if out.is_dir() || out.to_string_lossy().ends_with(['/', '\\']) => {
            out.join(file_name)
        }
        Some(out) => {
            let has_ext = out
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case(extension));
            if has_ext {
                out.to_path_buf()
            } else if out
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("pdf") || e.eq_ignore_ascii_case("html"))
            {
                out.with_extension(extension)
            } else {
                PathBuf::from(format!("{}.{extension}", out.display()))
            }
        }
    }
}

async fn serve(args: ServeArgs) -> Result<()> {
    server::serve(ServeOptions {
        host: args.host,
        port: args.port,
        file: args.file,
        css_path: args.css,
        output_dir: args.output_dir,
        token: args.token,
        open_browser: !args.no_open,
        exit_on_stdin_close: args.exit_on_stdin_close,
        engine: args.browser.engine_options(),
    })
    .await
}

fn print_theme(output: Option<PathBuf>) -> Result<()> {
    match output {
        Some(path) => {
            std::fs::write(&path, theme::DEFAULT_CSS)?;
            println!("Theme written to {}", path.display());
        }
        None => print!("{}", theme::DEFAULT_CSS),
    }
    Ok(())
}

async fn setup(force_download: bool) -> Result<()> {
    if !force_download && let Some(found) = pdf::find_browser() {
        println!("Using browser: {}", found.display());
        return Ok(());
    }
    println!(
        "Downloading chrome-headless-shell to {} ...",
        pdf::browser_cache_dir().display()
    );
    let path = pdf::download_browser().await?;
    println!("Installed: {}", path.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::output_path;
    use std::path::{Path, PathBuf};

    #[test]
    fn output_paths() {
        let input = Path::new("/docs/notes.md");
        assert_eq!(
            output_path(input, None, false),
            PathBuf::from("/docs/notes.pdf")
        );
        assert_eq!(
            output_path(input, None, true),
            PathBuf::from("/docs/notes.html")
        );
        assert_eq!(
            output_path(input, Some(Path::new("out.pdf")), false),
            PathBuf::from("out.pdf")
        );
        assert_eq!(
            output_path(input, Some(Path::new("out.html")), false),
            PathBuf::from("out.pdf")
        );
        assert_eq!(
            output_path(input, Some(Path::new("out")), false),
            PathBuf::from("out.pdf")
        );
        assert_eq!(
            output_path(input, Some(Path::new("dir/")), false),
            PathBuf::from("dir/notes.pdf")
        );
    }
}
