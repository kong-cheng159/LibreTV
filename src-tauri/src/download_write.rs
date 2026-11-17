//! 桌面端下载直写：用户另存为选路径后，按句柄流式追加写入，避免 WebView2 Blob「假完成」。

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use base64::Engine;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

pub struct DownloadWriteState {
    next_id: AtomicU32,
    files: Mutex<HashMap<u32, OpenDownload>>,
}

struct OpenDownload {
    path: PathBuf,
    file: File,
}

impl Default for DownloadWriteState {
    fn default() -> Self {
        Self {
            next_id: AtomicU32::new(1),
            files: Mutex::new(HashMap::new()),
        }
    }
}

/// 弹出系统另存为；取消返回 None。
#[tauri::command]
pub async fn desktop_download_pick(
    app: AppHandle,
    default_name: String,
    extensions: Vec<String>,
) -> Result<Option<String>, String> {
    let exts = extensions;
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_file_name(&default_name);
        let labels: Vec<&str> = exts.iter().map(String::as_str).collect();
        if !labels.is_empty() {
            let label = if labels.iter().any(|e| e.eq_ignore_ascii_case("mp4")) {
                "Video"
            } else if labels.iter().any(|e| e.eq_ignore_ascii_case("ts")) {
                "MPEG-TS"
            } else {
                "File"
            };
            dialog = dialog.add_filter(label, &labels);
        }
        dialog.blocking_save_file()
    })
    .await
    .map_err(|err| format!("另存为对话框中断：{err}"))?;

    let Some(file) = chosen else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|err| err.to_string())?;
    Ok(Some(path.display().to_string()))
}

/// 创建/截断文件并返回写句柄 id。
#[tauri::command]
pub fn desktop_download_open(
    state: State<'_, DownloadWriteState>,
    path: String,
) -> Result<u32, String> {
    let path = PathBuf::from(path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|err| format!("无法创建文件 {}: {err}", path.display()))?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let mut lock = state
        .files
        .lock()
        .map_err(|_| "下载写盘状态锁损坏".to_string())?;
    lock.insert(id, OpenDownload { path, file });
    Ok(id)
}

/// 追加一段 base64 编码的字节（避免 JSON 数字数组膨胀）。
#[tauri::command]
pub fn desktop_download_write(
    state: State<'_, DownloadWriteState>,
    id: u32,
    chunk_base64: String,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(chunk_base64.as_bytes())
        .map_err(|err| format!("分片解码失败：{err}"))?;
    let mut lock = state
        .files
        .lock()
        .map_err(|_| "下载写盘状态锁损坏".to_string())?;
    let entry = lock
        .get_mut(&id)
        .ok_or_else(|| format!("无效的下载写句柄：{id}"))?;
    entry
        .file
        .write_all(&bytes)
        .map_err(|err| format!("写入失败 {}: {err}", entry.path.display()))?;
    Ok(())
}

/// 刷盘并关闭句柄；返回最终路径。
#[tauri::command]
pub fn desktop_download_close(
    state: State<'_, DownloadWriteState>,
    id: u32,
) -> Result<String, String> {
    let mut lock = state
        .files
        .lock()
        .map_err(|_| "下载写盘状态锁损坏".to_string())?;
    let mut entry = lock
        .remove(&id)
        .ok_or_else(|| format!("无效的下载写句柄：{id}"))?;
    entry
        .file
        .flush()
        .map_err(|err| format!("刷盘失败：{err}"))?;
    Ok(entry.path.display().to_string())
}

/// 关闭并删除未完成文件。
#[tauri::command]
pub fn desktop_download_abort(
    state: State<'_, DownloadWriteState>,
    id: u32,
) -> Result<(), String> {
    let mut lock = state
        .files
        .lock()
        .map_err(|_| "下载写盘状态锁损坏".to_string())?;
    if let Some(entry) = lock.remove(&id) {
        drop(entry.file);
        let _ = std::fs::remove_file(&entry.path);
    }
    Ok(())
}
