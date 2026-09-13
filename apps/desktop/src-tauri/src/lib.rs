use std::{env, net::TcpStream, process::{Child, Command, Stdio}, sync::Mutex, thread, time::Duration};
use tauri::Manager;

struct WebServer(Mutex<Option<Child>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let explicit = env::var_os("PI_HARNESS_SERVER_SCRIPT");
    tauri::Builder::default()
        .setup(move |app| {
            let script = explicit.or_else(|| app.path().resource_dir().ok().map(|p| p.join("server-dist/bin.js").into_os_string()));
            let child = script.and_then(|script| {
        let bin = env::var_os("PI_HARNESS_SERVER_BIN").unwrap_or_else(|| "node".into());
        let web_dist = env::var_os("PI_HARNESS_WEB_DIST").or_else(|| app.path().resource_dir().ok().map(|p| p.join("dist").into_os_string()));
        let mut command = Command::new(bin);
        command.arg(script).env("PI_HARNESS_DISABLE_UPDATE_CHECK", "1");
        if let Some(dist) = web_dist { command.env("PI_HARNESS_WEB_DIST", dist); }
        command.stdin(Stdio::null()).stdout(Stdio::inherit()).stderr(Stdio::inherit()).spawn().ok()
            });
            app.manage(WebServer(Mutex::new(child)));
            if env::var_os("PI_HARNESS_SERVER_SCRIPT").is_some() || app.path().resource_dir().is_ok() {
                let window = app.get_webview_window("main");
                thread::spawn(move || {
                    for _ in 0..50 {
                        if TcpStream::connect_timeout(&"127.0.0.1:3141".parse().unwrap(), Duration::from_millis(100)).is_ok() {
                            if let Some(window) = window { let _ = window.url(); let _ = window.navigate("http://127.0.0.1:3141/".parse().unwrap()); }
                            break;
                        }
                        thread::sleep(Duration::from_millis(100));
                    }
                });
            }
            Ok(())
        })
        .plugin(tauri_plugin_shell::init())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(state) = window.try_state::<WebServer>() {
                    if let Ok(mut child) = state.0.lock() {
                        if let Some(mut process) = child.take() { let _ = process.kill(); }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Pi Harness");
}
