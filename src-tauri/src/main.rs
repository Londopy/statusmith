#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ipc;

#[cfg(not(windows))]
compile_error!("Statusmith currently supports Windows only: Discord IPC is done over named pipes (see ipc.rs). Unix-socket support welcome.");

use ipc::{Conn, IpcError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

const TRAY_ID: &str = "main-tray";

#[derive(Deserialize, Clone)]
struct TrayPreset {
    index: usize,
    name: String,
}

#[derive(Deserialize, Clone)]
struct TrayGroup {
    app: String,
    presets: Vec<TrayPreset>,
}

#[derive(Default, Clone)]
struct TrayInfo {
    status: String,
    groups: Vec<TrayGroup>,
    rotating: bool,
}

struct AppState {
    conn: Mutex<Option<Conn>>,
    tray: Mutex<TrayInfo>,
}

static START_MS: OnceLock<u64> = OnceLock::new();

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn data_dir() -> PathBuf {
    std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("Statusmith")
}

// ---------------------------------------------------------------- store

#[tauri::command]
fn load_store() -> Value {
    std::fs::read(data_dir().join("store.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}

#[tauri::command]
fn save_store(data: Value) -> Result<(), String> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(err)?;
    std::fs::write(dir.join("store.json"), serde_json::to_string_pretty(&data).map_err(err)?).map_err(err)
}

#[tauri::command]
fn open_data_dir() -> Result<(), String> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(err)?;
    std::process::Command::new("explorer.exe").arg(&dir).spawn().map(|_| ()).map_err(err)
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) links can be opened".into());
    }
    std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn()
        .map(|_| ())
        .map_err(err)
}

// ---------------------------------------------------------------- discord

#[derive(Serialize)]
struct Status {
    connected: bool,
    client_id: String,
    user: Value,
}

fn status_of(conn: &Option<Conn>) -> Status {
    match conn {
        Some(c) => Status { connected: true, client_id: c.client_id.clone(), user: c.user.clone() },
        None => Status { connected: false, client_id: String::new(), user: Value::Null },
    }
}

/// Make sure `guard` holds a live connection handshaken with `client_id`.
fn ensure_conn(guard: &mut Option<Conn>, client_id: &str) -> Result<(), String> {
    let client_id = client_id.trim();
    if client_id.is_empty() {
        return Err("Set an Application ID first (top bar)".into());
    }
    let reuse = matches!(guard, Some(c) if c.client_id == client_id && c.alive());
    if !reuse {
        *guard = None;
        *guard = Some(Conn::connect(client_id).map_err(|e| e.message().to_string())?);
    }
    Ok(())
}

#[tauri::command]
fn connect(state: State<'_, AppState>, client_id: String) -> Result<Status, String> {
    let mut guard = lock(&state.conn);
    ensure_conn(&mut guard, &client_id)?;
    Ok(status_of(&guard))
}

#[tauri::command]
fn disconnect(state: State<'_, AppState>) {
    *lock(&state.conn) = None;
}

#[tauri::command]
fn status(state: State<'_, AppState>) -> Status {
    let mut guard = lock(&state.conn);
    if matches!(&*guard, Some(c) if !c.alive()) {
        *guard = None;
    }
    status_of(&guard)
}

/// `activity` = null clears the presence. Returns the activity as Discord resolved it
/// (includes the application `name`, which the UI shows in the preview).
#[tauri::command]
fn set_activity(state: State<'_, AppState>, client_id: String, activity: Value) -> Result<Value, String> {
    let mut guard = lock(&state.conn);
    ensure_conn(&mut guard, &client_id)?;
    let act = if activity.is_null() { None } else { Some(activity) };
    match guard.as_mut().unwrap().set_activity(act) {
        Ok(v) => Ok(v),
        Err(IpcError::Transport(m)) => {
            *guard = None;
            Err(m)
        }
        Err(IpcError::Rejected(m)) => Err(m),
    }
}

// ---------------------------------------------------------------- window / tray / autostart

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn show_window(app: AppHandle) {
    show_main(&app);
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn app_start_ms() -> u64 {
    *START_MS.get_or_init(now_ms)
}

#[tauri::command]
fn autostart_enabled(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let al = app.autolaunch();
    if enabled {
        al.enable().map_err(err)
    } else if al.is_enabled().unwrap_or(false) {
        al.disable().map_err(err)
    } else {
        Ok(())
    }
}

fn build_tray_menu(app: &AppHandle, info: &TrayInfo) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "status", info.status.as_str(), false, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "show", "Open Statusmith", true, None::<&str>)?)?;

    // One flat list for a single app, one submenu per app otherwise.
    let groups: Vec<&TrayGroup> = info.groups.iter().filter(|g| !g.presets.is_empty()).collect();
    let sub = Submenu::with_id(app, "presets", "Apply preset", !groups.is_empty())?;
    if groups.len() == 1 {
        for p in &groups[0].presets {
            sub.append(&MenuItem::with_id(app, format!("preset:{}", p.index), p.name.as_str(), true, None::<&str>)?)?;
        }
    } else {
        for (gi, g) in groups.iter().enumerate() {
            let gs = Submenu::with_id(app, format!("group:{gi}"), g.app.as_str(), true)?;
            for p in &g.presets {
                gs.append(&MenuItem::with_id(app, format!("preset:{}", p.index), p.name.as_str(), true, None::<&str>)?)?;
            }
            sub.append(&gs)?;
        }
    }
    menu.append(&sub)?;

    let rot = if info.rotating { "Stop rotation" } else { "Start rotation" };
    menu.append(&MenuItem::with_id(app, "rotation", rot, true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "clear", "Clear presence", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit Statusmith", true, None::<&str>)?)?;
    Ok(menu)
}

fn rebuild_tray(app: &AppHandle) {
    let info = lock(&app.state::<AppState>().tray).clone();
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_tray_menu(app, &info) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

#[tauri::command]
fn set_tray(app: AppHandle, state: State<'_, AppState>, status: String, groups: Vec<TrayGroup>, rotating: bool, tooltip: String) {
    *lock(&state.tray) = TrayInfo { status, groups, rotating };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        rebuild_tray(&handle);
        if let Some(tray) = handle.tray_by_id(TRAY_ID) {
            let _ = tray.set_tooltip(Some(tooltip.as_str()));
        }
    });
}

fn on_tray_menu(app: &AppHandle, id: &str) {
    match id {
        "show" => show_main(app),
        "quit" => app.exit(0),
        "clear" => {
            let _ = app.emit("tray-clear", ());
        }
        "rotation" => {
            let _ = app.emit("tray-rotation", ());
        }
        other => {
            if let Some(idx) = other.strip_prefix("preset:").and_then(|s| s.parse::<usize>().ok()) {
                let _ = app.emit("tray-preset", idx);
            }
        }
    }
}

fn main() {
    START_MS.get_or_init(now_ms);
    tauri::Builder::default()
        // Must be registered first: a second launch just surfaces the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .manage(AppState { conn: Mutex::new(None), tray: Mutex::new(TrayInfo::default()) })
        .setup(|app| {
            let handle = app.handle().clone();
            let info = TrayInfo { status: "Discord: not connected".into(), groups: vec![], rotating: false };
            let menu = build_tray_menu(&handle, &info)?;
            *lock(&app.state::<AppState>().tray) = info;
            let mut tray = TrayIconBuilder::with_id(TRAY_ID)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("Statusmith")
                .on_menu_event(|app, e| on_tray_menu(app, e.id.as_ref()))
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.build(app)?;
            if std::env::args().any(|a| a == "--hidden") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // A tray app: closing the window only hides it. Quit lives in the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_store, save_store, open_data_dir, open_url,
            connect, disconnect, status, set_activity,
            show_window, hide_window, app_start_ms, autostart_enabled, set_autostart, set_tray
        ])
        .run(tauri::generate_context!())
        .expect("error while running Statusmith");
}
