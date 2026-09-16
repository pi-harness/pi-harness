use std::{
    env,
    ffi::OsString,
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};
use tauri::Manager;

struct WebServer(Mutex<Option<Child>>);

/// tauri-utils rewrites every parent-directory component of a bundled resource to `_up_`
/// (tauri-utils/src/resources.rs), so the `../../web/...` entries in tauri.conf.json are installed under
/// `_up_/_up_/web/...`, not at the resource root. A dev run resolves them in place, so try both and take
/// whichever is actually there rather than assuming either layout.
fn bundled_resource(root: &Path, relative: &str) -> Option<OsString> {
    [root.join("_up_").join("_up_").join("web").join(relative), root.join(relative)]
        .into_iter()
        .find(|candidate| candidate.exists())
        .map(PathBuf::into_os_string)
}

fn stop_server(server: &Mutex<Option<Child>>) {
    if let Ok(mut guard) = server.lock() {
        if let Some(mut process) = guard.take() {
            let _ = process.kill();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let explicit = env::var_os("PI_HARNESS_SERVER_SCRIPT");
    // The server takes its address from PI_HARNESS_HOST and PI_HARNESS_PORT (apps/web/src/server/bin.ts) and
    // inherits this process's environment, so the address to wait for and navigate to is whatever those say.
    // Reading them here rather than assuming 127.0.0.1:3141 keeps the window pointed at the server we spawned.
    let host = env::var("PI_HARNESS_HOST").unwrap_or_else(|_| "127.0.0.1".to_owned());
    let port = env::var("PI_HARNESS_PORT").ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(3141);
    let address = format!("{host}:{port}");

    tauri::Builder::default()
        .setup(move |app| {
            let resource_dir = app.path().resource_dir().ok();
            let script = explicit.clone().or_else(|| {
                resource_dir.as_deref().and_then(|root| bundled_resource(root, "server-dist/bin.js"))
            });
            let child = script.and_then(|script| {
                let bin = env::var_os("PI_HARNESS_SERVER_BIN").unwrap_or_else(|| "node".into());
                let web_dist = env::var_os("PI_HARNESS_WEB_DIST")
                    .or_else(|| resource_dir.as_deref().and_then(|root| bundled_resource(root, "dist")));
                let mut command = Command::new(bin);
                command.arg(script).env("PI_HARNESS_DISABLE_UPDATE_CHECK", "1");
                if let Some(dist) = web_dist {
                    command.env("PI_HARNESS_WEB_DIST", dist);
                }
                command.stdin(Stdio::null()).stdout(Stdio::inherit()).stderr(Stdio::inherit()).spawn().ok()
            });
            app.manage(WebServer(Mutex::new(child)));
            if explicit.is_some() || resource_dir.is_some() {
                let window = app.get_webview_window("main");
                let address = address.clone();
                thread::spawn(move || {
                    let targets: Vec<_> = address.to_socket_addrs().map(Iterator::collect).unwrap_or_default();
                    for _ in 0..50 {
                        let listening = targets
                            .iter()
                            .any(|target| TcpStream::connect_timeout(target, Duration::from_millis(100)).is_ok());
                        if listening {
                            if let Some(window) = window {
                                if let Ok(url) = format!("http://{address}/").parse() {
                                    let _ = window.navigate(url);
                                }
                            }
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
                    stop_server(&state.0);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running Pi Harness")
        // Quitting from the menu or with Cmd+Q never closes the window first, so CloseRequested alone leaves
        // the server we spawned running and holding its port after the app is gone.
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                if let Some(state) = app.try_state::<WebServer>() {
                    stop_server(&state.0);
                }
            }
        });
}
