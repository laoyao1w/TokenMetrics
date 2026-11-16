mod snapshot;

use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::image::Image;
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

/// 托盘图标动画帧（醍醐嘴部开合，共 16 帧周期）。
const TRAY_ICON_SIZE: u32 = 48;

fn tray_icon_frames() -> Vec<Image<'static>> {
    let mut frames = Vec::with_capacity(16);
    for i in 0..16u32 {
        // include_bytes 需要字面量路径，这里按帧序号展开。
        let raw: &[u8] = match i {
            0 => include_bytes!("../icons/tray/pelican-00.raw"),
            1 => include_bytes!("../icons/tray/pelican-01.raw"),
            2 => include_bytes!("../icons/tray/pelican-02.raw"),
            3 => include_bytes!("../icons/tray/pelican-03.raw"),
            4 => include_bytes!("../icons/tray/pelican-04.raw"),
            5 => include_bytes!("../icons/tray/pelican-05.raw"),
            6 => include_bytes!("../icons/tray/pelican-06.raw"),
            7 => include_bytes!("../icons/tray/pelican-07.raw"),
            8 => include_bytes!("../icons/tray/pelican-08.raw"),
            9 => include_bytes!("../icons/tray/pelican-09.raw"),
            10 => include_bytes!("../icons/tray/pelican-10.raw"),
            11 => include_bytes!("../icons/tray/pelican-11.raw"),
            12 => include_bytes!("../icons/tray/pelican-12.raw"),
            13 => include_bytes!("../icons/tray/pelican-13.raw"),
            14 => include_bytes!("../icons/tray/pelican-14.raw"),
            _ => include_bytes!("../icons/tray/pelican-15.raw"),
        };
        let image = Image::new_owned(raw.to_vec(), TRAY_ICON_SIZE, TRAY_ICON_SIZE);
        frames.push(image);
    }
    frames
}

/// 悬浮球窗口尺寸（球体 + 四周光晕边距），逻辑像素。
const FLOATBALL_WINDOW_SIZE: f64 = 80.0;
/// 悬浮球球体直径。
const FLOATBALL_BALL_SIZE: f64 = 60.0;
/// 悬浮球右缘距离屏幕右边缘的像素。
const FLOATBALL_RIGHT_GAP: f64 = 300.0;
/// 需要监测 CPU 波动以判断“是否在猛蹬”的工具进程关键词（大小写不敏感）。
const WATCH_KEYWORDS: [&str; 2] = ["trae", "workbuddy"];
/// 被监测工具合计 CPU 占用超过该值（%）才认为有动静。
const PEDAL_CPU_FLOOR: f32 = 3.0;
/// 滑动窗口内的占用波动超过该值（%）才认定为“波动”。
const PEDAL_FLUCTUATION: f32 = 1.0;

/// 悬浮球蹬车状态，供前端拉取初始值。
#[derive(Default)]
struct PelicanActivity {
    active: Arc<AtomicBool>,
}

/// 目录条目（Node `Dirent` 的浏览器侧最小等价物）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FsEntry {
    name: String,
    #[serde(rename = "isDir")]
    is_dir: bool,
    #[serde(rename = "isSymlink")]
    is_symlink: bool,
}

/// 文件/目录统计信息（Node `statSync` 的浏览器侧最小等价物）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FsStat {
    #[serde(rename = "isFile")]
    is_file: bool,
    #[serde(rename = "isDir")]
    is_dir: bool,
    size: u64,
    /// 最后修改毫秒时间戳（Node `mtimeMs`）。
    mtime_ms: Option<u64>,
    /// 最后修改纳秒余数（Node bigint `mtimeNs` 的剩余精度，用于稳定性判断）。
    mtime_ns: Option<u64>,
}

/// 读取一个环境变量（Node `process.env[name]`）。
#[tauri::command]
fn os_env(name: String) -> Option<String> {
    std::env::var(&name).ok()
}

/// 平台标识，返回 Node 风格值（win32 / darwin / linux）。
#[tauri::command]
fn platform() -> String {
    match std::env::consts::OS {
        "windows" => "win32".to_string(),
        "macos" => "darwin".to_string(),
        other => other.to_string(),
    }
}

/// 列出目录条目（Node `readdir withFileTypes` 的最小等价物）。
#[tauri::command]
fn read_dir(path: String) -> Result<Vec<FsEntry>, String> {
    let mut entries = Vec::new();
    let iterator = std::fs::read_dir(&path).map_err(|error| format!("读取目录失败 {path}: {error}"))?;
    for entry in iterator {
        match entry {
            Ok(entry) => {
                let kind = entry
                    .file_type()
                    .map_err(|error| format!("读取条目类型失败: {error}"))?;
                entries.push(FsEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    is_dir: kind.is_dir(),
                    is_symlink: kind.is_symlink(),
                });
            }
            Err(error) => return Err(format!("读取目录条目失败 {path}: {error}")),
        }
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(entries)
}

#[tauri::command]
async fn walk_files(
    root: String,
    max_depth: usize,
    skip_substrings: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    let output = tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
        fn walk(
            current_path: &std::path::Path,
            depth: usize,
            max_depth: usize,
            skip_substrings: &[String],
            output: &mut Vec<String>,
        ) -> Result<(), String> {
            if depth > max_depth {
                return Ok(());
            }

            let current_lower = current_path.to_string_lossy().to_lowercase();
            if skip_substrings
                .iter()
                .any(|fragment| !fragment.is_empty() && current_lower.contains(fragment))
            {
                return Ok(());
            }

            let iterator = match std::fs::read_dir(current_path) {
                Ok(iterator) => iterator,
                Err(_) => return Ok(()),
            };

            for entry in iterator {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(_) => continue,
                };
                let entry_path = entry.path();
                let entry_lower = entry_path.to_string_lossy().to_lowercase();
                if skip_substrings
                    .iter()
                    .any(|fragment| !fragment.is_empty() && entry_lower.contains(fragment))
                {
                    continue;
                }

                let kind = match entry.file_type() {
                    Ok(kind) => kind,
                    Err(_) => continue,
                };
                if kind.is_dir() {
                    walk(&entry_path, depth + 1, max_depth, skip_substrings, output)?;
                } else if kind.is_file() {
                    output.push(entry_path.to_string_lossy().into_owned());
                }
            }

            Ok(())
        }

        let normalized_skips = skip_substrings
            .unwrap_or_default()
            .into_iter()
            .map(|value| value.to_lowercase())
            .collect::<Vec<_>>();
        let mut files = Vec::new();
        walk(
            std::path::Path::new(&root),
            0,
            max_depth,
            &normalized_skips,
            &mut files,
        )?;
        files.sort();
        Ok(files)
    })
    .await
    .map_err(|error| error.to_string())??;

    Ok(output)
}

#[tauri::command]
async fn file_contains_any(
    path: String,
    needles: Vec<String>,
    max_bytes: Option<u64>,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || -> Result<bool, String> {
        if needles.is_empty() {
            return Ok(false);
        }

        let file = std::fs::File::open(&path)
            .map_err(|error| format!("打开文件失败 {path}: {error}"))?;
        let mut reader = std::io::BufReader::new(file);
        let mut chunk = vec![0u8; 64 * 1024];
        let needles = needles
            .into_iter()
            .filter(|needle| !needle.is_empty())
            .map(|needle| needle.into_bytes())
            .collect::<Vec<_>>();

        if needles.is_empty() {
            return Ok(false);
        }

        let overlap = needles.iter().map(|needle| needle.len()).max().unwrap_or(1).saturating_sub(1);
        let mut carry = Vec::<u8>::new();
        let mut bytes_scanned = 0u64;

        loop {
            let remaining = match max_bytes {
                Some(limit) => limit.saturating_sub(bytes_scanned) as usize,
                None => chunk.len(),
            };
            if remaining == 0 {
                return Ok(false);
            }

            let bytes_to_read = remaining.min(chunk.len());
            let bytes_read = std::io::Read::read(&mut reader, &mut chunk[..bytes_to_read])
                .map_err(|error| format!("读取文件失败 {path}: {error}"))?;
            if bytes_read == 0 {
                return Ok(false);
            }

            bytes_scanned += bytes_read as u64;
            let mut haystack = Vec::with_capacity(carry.len() + bytes_read);
            haystack.extend_from_slice(&carry);
            haystack.extend_from_slice(&chunk[..bytes_read]);

            if needles.iter().any(|needle| haystack.windows(needle.len()).any(|window| window == needle)) {
                return Ok(true);
            }

            if overlap == 0 {
                carry.clear();
            } else if haystack.len() > overlap {
                carry = haystack[haystack.len() - overlap..].to_vec();
            } else {
                carry = haystack;
            }
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 读文件为原始字节（经 Tauri IPC 以二进制返回给 WebView）。
#[tauri::command]
async fn read_file(path: String) -> Result<Response, String> {
    let path_for_block = path.clone();
    let bytes = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<u8>> {
        std::fs::read(&path_for_block)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| format!("读取文件失败 {path}: {error}"))?;
    Ok(Response::new(bytes))
}

/// 读取 Trae 国际版 SQLCipher 快照，返回解密后的明文 SQLite 字节。
#[tauri::command]
async fn read_trae_snapshot(path: String, key_override: Option<String>) -> Result<Response, String> {
    let path_for_block = path.clone();
    let bytes = tokio::task::spawn_blocking(move || {
        snapshot::read_trae_snapshot(&path_for_block, key_override.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| format!("读取 Trae 快照失败 {path}: {error}"))?;
    Ok(Response::new(bytes))
}

/// 文件/目录统计（Node `statSync` 的最小等价物）。
#[tauri::command]
fn fs_stat(path: String) -> Result<FsStat, String> {
    let link_meta =
        std::fs::symlink_metadata(&path).map_err(|error| format!("读取元数据失败 {path}: {error}"))?;
    let kind = link_meta.file_type();
    let (is_file, is_dir) = if kind.is_symlink() {
        match std::fs::metadata(&path) {
            Ok(target) => (target.is_file(), target.is_dir()),
            Err(_) => (false, false),
        }
    } else {
        (kind.is_file(), kind.is_dir())
    };

    let duration = link_meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .unwrap_or(Duration::ZERO);

    Ok(FsStat {
        is_file,
        is_dir,
        size: link_meta.len(),
        mtime_ms: Some(duration.as_millis() as u64),
        mtime_ns: Some(duration.subsec_nanos() as u64),
    })
}

#[tauri::command]
fn toggle_always_on_top(window: tauri::WebviewWindow) -> Result<bool, String> {
    let current = window.is_always_on_top().map_err(|error| error.to_string())?;
    window
        .set_always_on_top(!current)
        .map_err(|error| error.to_string())?;
    Ok(!current)
}

#[tauri::command]
fn hide_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// 点击悬浮球：恢复主窗口并收起悬浮球。
#[tauri::command]
fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window
            .show()
            .map_err(|error| format!("恢复主窗口失败: {error}"))?;
        let _ = window.unminimize();
        window
            .set_focus()
            .map_err(|error| format!("激活主窗口失败: {error}"))?;
    }
    if let Some(ball) = app.get_webview_window("floatball") {
        let _ = ball.hide();
    }
    Ok(())
}

/// 返回悬浮球是否处于“猛蹬”状态（用于页面加载时同步初始动画）。
#[tauri::command]
fn get_floatball_state(activity: tauri::State<'_, PelicanActivity>) -> bool {
    activity.active.load(Ordering::Relaxed)
}

#[tauri::command]
fn start_window_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show_item = MenuItem::with_id(app, "show", "显示悬浮窗", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let frames = tray_icon_frames();

    let _tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("TokenMetrics")
        .menu(&menu)
        .icon(frames[0].clone())
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                if let Some(ball) = app.get_webview_window("floatball") {
                    let _ = ball.hide();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                if let Some(ball) = app.get_webview_window("floatball") {
                    let _ = ball.hide();
                }
            }
        })
        .build(app)?;

    // 托盘图标动画：循环切换醍醐嘴部开合帧
    let app_handle = app.handle().clone();
    std::thread::spawn(move || {
        let frames = tray_icon_frames();
        let mut frame_index = 0usize;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(120));
            let Some(tray) = app_handle.tray_by_id("main-tray") else {
                break; // 托盘已销毁（应用退出）
            };
            if tray.set_icon(Some(frames[frame_index].clone())).is_err() {
                break;
            }
            frame_index = (frame_index + 1) % frames.len();
        }
    });

    Ok(())
}

/// 悬浮球位置存档文件名（存放在应用配置目录下）。
const FLOATBALL_POS_FILE: &str = "floatball-pos.json";

fn floatball_pos_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(FLOATBALL_POS_FILE))
}

/// 读取上次记忆的悬浮球屏幕位置（物理像素）。
fn load_floatball_pos(app: &AppHandle) -> Option<(i32, i32)> {
    let path = floatball_pos_path(app)?;
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<(i32, i32)>(&content).ok()
}

/// 记忆悬浮球屏幕位置（物理像素），供下次启动恢复。
fn save_floatball_pos(app: &AppHandle, pos: (i32, i32)) {
    if let Some(path) = floatball_pos_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string(&pos) {
            let _ = std::fs::write(path, json);
        }
    }
}

/// 创建悬浮球窗口：无边框、透明、置顶、跳过任务栏，默认隐藏。
/// 优先恢复上次记忆的位置；无存档时回退到默认位置（屏幕顶边、球右缘距屏幕右边缘 300px）。
fn build_floatball(app: &tauri::App) -> tauri::Result<()> {
    let ball = tauri::WebviewWindowBuilder::new(
        app,
        "floatball",
        tauri::WebviewUrl::App("floatball.html".into()),
    )
    .title("猛蹬小球")
    .inner_size(FLOATBALL_WINDOW_SIZE, FLOATBALL_WINDOW_SIZE)
    .min_inner_size(FLOATBALL_WINDOW_SIZE, FLOATBALL_WINDOW_SIZE)
    .max_inner_size(FLOATBALL_WINDOW_SIZE, FLOATBALL_WINDOW_SIZE)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .shadow(false)
    .skip_taskbar(true)
    .focusable(false)
    .visible(false)
    .build()?;

    // 恢复记忆位置（物理像素），避免重新打开后跳到默认坐标。
    if let Some((x, y)) = load_floatball_pos(app.handle()) {
        let _ = ball.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)));
        return Ok(());
    }

    if let Ok(Some(monitor)) = ball.primary_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size();
        let pos = monitor.position();
        let logical_right = pos.x as f64 / scale + size.width as f64 / scale;
        // 球体在窗口内居中，左右各留 (窗口-球体)/2 光晕边距，据此反推窗口横坐标。
        let halo = (FLOATBALL_WINDOW_SIZE - FLOATBALL_BALL_SIZE) / 2.0;
        let x = logical_right - FLOATBALL_RIGHT_GAP - (FLOATBALL_WINDOW_SIZE - halo);
        let _ = ball.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, 0.0)));
    }
    Ok(())
}

fn sync_floatball_visibility(app: &AppHandle) {
    let (Some(main_window), Some(ball)) = (
        app.get_webview_window("main"),
        app.get_webview_window("floatball"),
    ) else {
        return;
    };
    let main_visible = main_window.is_visible().unwrap_or(false);
    let main_minimized = main_window.is_minimized().unwrap_or(false);
    let ball_visible = ball.is_visible().unwrap_or(false);
    // 主窗口不可见（隐藏到托盘）或处于最小化时浮出悬浮球，恢复后收起。
    if (!main_visible || main_minimized) && !ball_visible {
        let _ = ball.show();
    } else if main_visible && !main_minimized && ball_visible {
        let _ = ball.hide();
    }
}

/// 后台线程：每 600ms 同步悬浮球显隐，并采样 Trae / WorkBuddy 的合计 CPU 占用，
/// 按“占用足够高且存在波动”判定是否进入猛蹬状态，
/// 状态变化时向悬浮球窗口广播 `floatball-activity` 事件。
fn spawn_cpu_monitor(app: AppHandle, activity: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut sys = sysinfo::System::new();
        let mut samples: VecDeque<f32> = VecDeque::with_capacity(5);
        let mut last_active: Option<bool> = None;
        // 记录上次已存档的悬浮球位置，拖动结束时仅写入一次。
        let mut last_ball_pos: Option<(i32, i32)> = None;
        // 预热一次，让 sysinfo 拿到 CPU 计算基准。
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        loop {
            std::thread::sleep(std::time::Duration::from_millis(600));
            sync_floatball_visibility(&app);
            // 拖动后记忆悬浮球新位置，供下次启动恢复。
            if let Some(ball) = app.get_webview_window("floatball") {
                if let Ok(pos) = ball.outer_position() {
                    let pos = (pos.x, pos.y);
                    if last_ball_pos != Some(pos) {
                        last_ball_pos = Some(pos);
                        save_floatball_pos(&app, pos);
                    }
                }
            }
            sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            let total: f32 = sys
                .processes()
                .values()
                .filter(|process| {
                    let name = process.name().to_string_lossy().to_lowercase();
                    WATCH_KEYWORDS.iter().any(|keyword| name.contains(keyword))
                })
                .map(|process| process.cpu_usage())
                .sum();
            samples.push_back(total);
            if samples.len() > 5 {
                samples.pop_front();
            }
            let active = if samples.len() >= 2 {
                let min = samples.iter().copied().fold(f32::INFINITY, f32::min);
                let max = samples.iter().copied().fold(f32::NEG_INFINITY, f32::max);
                total >= PEDAL_CPU_FLOOR && (max - min) >= PEDAL_FLUCTUATION
            } else {
                false
            };
            activity.store(active, Ordering::Relaxed);
            if last_active != Some(active) {
                last_active = Some(active);
                let payload = serde_json::json!({
                    "active": active,
                    "cpu": (total * 10.0).round() / 10.0
                });
                let _ = app.emit_to(
                    tauri::EventTarget::webview_window("floatball"),
                    "floatball-activity",
                    payload,
                );
            }
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            build_tray(app)?;
            build_floatball(app)?;
            let activity = Arc::new(AtomicBool::new(false));
            app.manage(PelicanActivity {
                active: activity.clone(),
            });
            spawn_cpu_monitor(app.handle().clone(), activity);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            os_env,
            platform,
            read_dir,
            walk_files,
            file_contains_any,
            read_file,
            read_trae_snapshot,
            fs_stat,
            toggle_always_on_top,
            hide_window,
            exit_app,
            show_main_window,
            get_floatball_state,
            start_window_drag
        ])
        .on_window_event(|window, event| {
            // Hide to tray instead of exiting on close.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running TokenMetrics");
}
