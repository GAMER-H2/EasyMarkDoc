//! EasyMarkDoc for Zed: starts `EasyMarkDoc lsp`, which offers the export
//! and live preview code actions for Markdown files.

use zed_extension_api::{self as zed, settings::LspSettings, LanguageServerId, Result};

const SERVER_NAME: &str = "easymarkdoc";

struct EasyMarkDocExtension;

impl EasyMarkDocExtension {
    /// `lsp.easymarkdoc.binary.path` if set, otherwise `EasyMarkDoc` on the
    /// worktree's PATH.
    fn find_binary(settings: &LspSettings, worktree: &zed::Worktree) -> Result<String> {
        if let Some(path) = settings.binary.as_ref().and_then(|b| b.path.clone()) {
            return Ok(path);
        }
        ["EasyMarkDoc", "easymarkdoc"]
            .into_iter()
            .find_map(|name| worktree.which(name))
            .ok_or_else(|| {
                "EasyMarkDoc executable not found on your PATH. Install it with \
                 `cargo install --path .` from the EasyMarkDoc repository, or set \
                 `lsp.easymarkdoc.binary.path` in your Zed settings."
                    .to_string()
            })
    }
}

impl zed::Extension for EasyMarkDocExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let settings = LspSettings::for_worktree(SERVER_NAME, worktree).unwrap_or_default();
        let command = Self::find_binary(&settings, worktree)?;
        let mut args = vec!["lsp".to_string()];
        let mut env = worktree.shell_env();
        if let Some(binary) = settings.binary {
            args.extend(binary.arguments.unwrap_or_default());
            env.extend(binary.env.unwrap_or_default());
        }
        Ok(zed::Command { command, args, env })
    }

    fn language_server_initialization_options(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        let settings = LspSettings::for_worktree(SERVER_NAME, worktree).unwrap_or_default();
        Ok(settings.initialization_options.or(settings.settings))
    }

    fn language_server_workspace_configuration(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        let settings = LspSettings::for_worktree(SERVER_NAME, worktree).unwrap_or_default();
        Ok(settings.settings.or(settings.initialization_options))
    }
}

zed::register_extension!(EasyMarkDocExtension);
