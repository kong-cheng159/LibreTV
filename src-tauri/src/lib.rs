use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::webview::{DownloadEvent, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use url::Url;
use uuid::Uuid;

const DESKTOP_PORT: u16 = 47321;
const DEV_PORT: u16 = 18080;
const DEV_BOOT_TOKEN: &str = "dev-desktop";

struct SidecarState {
    child: Mutex<Option<CommandChild>>,
}

#[derive(Serialize, Deserialize)]
struct DesktopConfig {
    password: String,
    #[serde(rename = "proxySecret")]
    proxy_secret: String,
}

pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState {
            child: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![save_text_file])
        .setup(|app| {
            let opener_url_ok = |url: &Url| {
                if allow_in_app(url) {
                    return true;
                }
                let _ = opener::open(url.as_str());
                false
            };

            let start_url = if cfg!(debug_assertions) {
                WebviewUrl::External(Url::parse("http://127.0.0.1:18080").expect("dev url"))
            } else {
                WebviewUrl::App("index.html".into())
            };

            let window = WebviewWindowBuilder::new(app, "main", start_url)
                .title("LibreTV")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 600.0)
                .resizable(true)
                .center()
                .visible(false)
                .on_navigation(opener_url_ok)
                .on_download(|webview, event| {
                    match event {
                        DownloadEvent::Requested { destination, .. } => {
                            place_download(&webview, destination);
                            true
                        }
                        DownloadEvent::Finished { .. } => true,
                        _ => true,
                    }
                })
                .build()?;

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = boot(handle.clone()).await {
                    report_error(&handle, &err);
                }
            });
            let _ = window;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("启动 LibreTV 桌面壳失败")
        .run(|app, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                kill_sidecar(app);
            }
        });
}

/// 站内导航留在窗口里。Tauri 在 Windows 上用 http://tauri.localhost 提供启动页，
/// 这个名字同样解析到 127.0.0.1。若把它交给系统浏览器，浏览器会去连 80 端口，
/// 本机若跑着 Nginx 就会打开 Nginx 默认页。
fn allow_in_app(url: &Url) -> bool {
    if url.scheme() != "http" && url.scheme() != "https" {
        return true;
    }
    match url.host_str() {
        Some("127.0.0.1") | Some("localhost") | Some("::1") => true,
        Some(host) if host.ends_with(".localhost") => true,
        _ => false,
    }
}

/// 系统「另存为」对话框，写入文本后返回绝对路径；用户取消返回 None。
#[tauri::command]
async fn save_text_file(
    app: AppHandle,
    default_name: String,
    contents: String,
    extensions: Vec<String>,
) -> Result<Option<String>, String> {
    let exts = extensions;
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_file_name(&default_name);
        let labels: Vec<&str> = exts.iter().map(String::as_str).collect();
        if !labels.is_empty() {
            dialog = dialog.add_filter("JSON", &labels);
        }
        dialog.blocking_save_file()
    })
    .await
    .map_err(|err| format!("另存为对话框中断：{err}"))?;

    let Some(file) = chosen else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|err| err.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(&path, contents).map_err(|err| err.to_string())?;
    Ok(Some(path.display().to_string()))
}

/// WebView2 没有浏览器的下载栏。这里把文件放到系统「下载」目录，允许下载继续。
fn place_download(webview: &tauri::Webview, destination: &mut PathBuf) {
    let name = destination
        .file_name()
        .map(|n| n.to_os_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| std::ffi::OsString::from("LibreTV-download"));
    let dir = if destination.is_absolute() {
        destination
            .parent()
            .map(|p| p.to_path_buf())
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| download_dir(webview))
    } else {
        download_dir(webview)
    };
    let _ = fs::create_dir_all(&dir);
    *destination = dir.join(name);
}

fn download_dir(webview: &tauri::Webview) -> PathBuf {
    let path = webview.app_handle().path();
    path.download_dir()
        .or_else(|_| path.document_dir())
        .unwrap_or_else(|_| std::env::temp_dir())
}

fn kill_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    if let Some(child) = state.child.lock().ok().and_then(|mut lock| lock.take()) {
        let _ = child.kill();
    }
}

async fn boot(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;

    if cfg!(debug_assertions) {
        set_status(&window, "正在连接开发服务器…");
        let _ = window.show();
        if !wait_for_server(DEV_PORT).await {
            return Err("开发服务器没有在 127.0.0.1:18080 就绪。请确认 desktop:dev 已启动 next dev。".into());
        }
        navigate_bootstrap(&window, DEV_PORT, DEV_BOOT_TOKEN)?;
        let _ = window.set_focus();
        return Ok(());
    }

    set_status(&window, "正在启动…");
    let _ = window.show();

    if !port_is_free(DESKTOP_PORT) {
        return Err(format!(
            "127.0.0.1:{DESKTOP_PORT} 已被占用。请结束占用该端口的进程后重新打开 LibreTV。"
        ));
    }

    let config = load_or_create_config(&app)?;
    let boot_token = Uuid::new_v4().to_string();
    let log_path = log_path(&app);
    append_log(
        &log_path,
        &format!("\n----- boot port={DESKTOP_PORT} -----\n"),
    );

    let resource_dir = app.path().resource_dir().map_err(|err| err.to_string())?;
    // resource_dir 在 Windows 上会带 \\?\ 前缀。Node 把这种路径当成脚本入口时会解析成 "C:"。
    let standalone_dir = strip_verbatim(&resource_dir.join("standalone"));
    let server_js = standalone_dir.join("server.js");
    if !server_js.is_file() {
        return Err(format!("找不到服务入口：{}", server_js.display()));
    }
    append_log(&log_path, &format!("cwd = {}\n", standalone_dir.display()));

    let (mut rx, child) = app
        .shell()
        .sidecar("node")
        .map_err(|err| format!("无法定位 Node sidecar：{err}"))?
        .args(["server.js"])
        .current_dir(&standalone_dir)
        .env("PORT", DESKTOP_PORT.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("NODE_ENV", "production")
        .env("DESKTOP_MODE", "1")
        .env("DESKTOP_BOOT_TOKEN", &boot_token)
        .env("PASSWORD", &config.password)
        .env("PROXY_SECRET", &config.proxy_secret)
        .env("COOKIE_SECURE", "false")
        .env("LIVE_ALLOW_PRIVATE", "1")
        .set_process_group(true)
        .spawn()
        .map_err(|err| format!("启动 Node sidecar 失败：{err}"))?;

    {
        let state = app.state::<SidecarState>();
        let mut lock = state.child.lock().map_err(|_| "sidecar 状态锁损坏".to_string())?;
        *lock = Some(child);
    }

    let log_for_output = log_path.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    append_log(&log_for_output, &String::from_utf8_lossy(&bytes));
                    append_log(&log_for_output, "\n");
                }
                CommandEvent::Error(message) => {
                    append_log(&log_for_output, &format!("[sidecar] {message}\n"));
                }
                CommandEvent::Terminated(payload) => {
                    append_log(
                        &log_for_output,
                        &format!("[sidecar] exited code={:?}\n", payload.code),
                    );
                }
                _ => {}
            }
        }
    });

    if !wait_for_server_logged(DESKTOP_PORT, Some(&log_path)).await {
        kill_sidecar(&app);
        return Err(format!(
            "服务在 30 秒内没有就绪（/api/status 未成功）。日志：{}",
            log_path.display()
        ));
    }

    navigate_bootstrap(&window, DESKTOP_PORT, &boot_token)?;
    let _ = window.set_focus();
    Ok(())
}

fn navigate_bootstrap(window: &tauri::WebviewWindow, port: u16, token: &str) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/api/desktop-bootstrap?t={token}");
    let parsed = Url::parse(&url).map_err(|err| err.to_string())?;
    window.navigate(parsed).map_err(|err| err.to_string())
}

async fn wait_for_server(port: u16) -> bool {
    wait_for_server_logged(port, None).await
}

async fn wait_for_server_logged(port: u16, log: Option<&PathBuf>) -> bool {
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(2)).build() {
        Ok(client) => client,
        Err(_) => return false,
    };
    let url = format!("http://127.0.0.1:{port}/api/status");
    let mut last_status = String::from("无响应");
    for i in 0..60 {
        match client.get(&url).send().await {
            Ok(response) => {
                let code = response.status();
                if code.is_success() {
                    return true;
                }
                last_status = format!("HTTP {}", code.as_u16());
                // 每 5 秒记一次，方便判断是 404（路由清单坏了）还是其它错误
                if let Some(path) = log {
                    if i % 10 == 0 {
                        append_log(path, &format!("[wait] /api/status -> {last_status}\n"));
                    }
                }
            }
            Err(err) => {
                last_status = err.to_string();
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    if let Some(path) = log {
        append_log(path, &format!("[wait] 超时，最后状态：{last_status}\n"));
    }
    false
}

fn strip_verbatim(path: &std::path::Path) -> PathBuf {
    let text = path.to_string_lossy();
    text.strip_prefix(r"\\?\")
        .map(PathBuf::from)
        .unwrap_or_else(|| path.to_path_buf())
}

fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn load_or_create_config(app: &AppHandle) -> Result<DesktopConfig, String> {
    let dir = app.path().app_config_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let path = dir.join("config.json");
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(config) = serde_json::from_str::<DesktopConfig>(&raw) {
            if !config.password.is_empty() && !config.proxy_secret.is_empty() {
                return Ok(config);
            }
        }
    }
    let config = DesktopConfig {
        password: Uuid::new_v4().to_string(),
        proxy_secret: Uuid::new_v4().to_string(),
    };
    let raw = serde_json::to_string_pretty(&config).map_err(|err| err.to_string())?;
    fs::write(&path, raw).map_err(|err| err.to_string())?;
    Ok(config)
}

fn log_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("libretv-desktop"));
    let _ = fs::create_dir_all(&dir);
    dir.join("sidecar.log")
}

fn append_log(path: &PathBuf, text: &str) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(text.as_bytes());
    }
}

fn set_status(window: &tauri::WebviewWindow, text: &str) {
    let quoted = serde_json::to_string(text).unwrap_or_else(|_| "\"正在启动…\"".to_string());
    let script = format!(
        "(function(){{var el=document.getElementById('status');if(el){{el.textContent={quoted};}}else{{document.title={quoted};}}}})();"
    );
    let _ = window.eval(&script);
}

fn report_error(app: &AppHandle, message: &str) {
    append_log(&log_path(app), &format!("[boot] {message}\n"));
    if let Some(window) = app.get_webview_window("main") {
        set_status(&window, message);
        let _ = window.show();
        let _ = window.set_focus();
    }
}
