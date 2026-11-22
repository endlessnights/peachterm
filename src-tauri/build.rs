/// Every IPC command the renderer may call. Declaring them here makes Tauri
/// generate an `allow-<command>` permission for each one, so a command that is
/// not listed in `permissions/app-commands.toml` cannot be invoked at all.
const COMMANDS: &[&str] = &[
    "app_info",
    "connections_load",
    "connections_save",
    "connections_delete",
    "connections_duplicate",
    "connections_move",
    "folders_save",
    "folders_delete",
    "settings_load",
    "settings_save",
    "credentials_status",
    "credentials_set_password",
    "credentials_clear",
    "credentials_clear_all",
    "known_hosts_list",
    "known_hosts_remove",
    "editor_presets",
    "logging_status",
    "logging_open_dir",
    "logging_export_preview",
    "logging_export",
    "logging_reveal_export",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
