//! Linux and the BSDs: WebKitGTK's `webkit_web_view_get_snapshot`.
//!
//! Same property as the other two platforms — it renders the webview rather than the screen, so it
//! cannot photograph whatever window happens to be in front, and it works under `xvfb` where there
//! is no physical display at all.

use crate::SNAPSHOT_TIMEOUT;

use webkit2gtk::{gio, glib, SnapshotOptions, SnapshotRegion, WebViewExt};

pub fn snapshot_png(window: &tauri::WebviewWindow, full_page: bool) -> Result<Vec<u8>, String> {
    let (sender, receiver) = std::sync::mpsc::channel::<Result<Vec<u8>, String>>();
    window
        .with_webview(move |webview| {
            // Viewport by default, so a baseline captured here matches one captured on macOS or
            // Windows. WebKitGTK is the only one of the three that can render the whole document
            // offscreen, so `fullPage` is honoured here and refused there — never silently downgraded.
            let region = if full_page {
                SnapshotRegion::FullDocument
            } else {
                SnapshotRegion::Visible
            };
            webview.inner().snapshot(
                region,
                SnapshotOptions::NONE,
                None::<&gio::Cancellable>,
                move |result| {
                    let _ = sender.send(encode_png(result));
                },
            );
        })
        .map_err(|error| error.to_string())?;

    receiver
        .recv_timeout(SNAPSHOT_TIMEOUT)
        .map_err(|_| "webview snapshot timed out".to_string())?
}

fn encode_png(result: Result<cairo::Surface, glib::Error>) -> Result<Vec<u8>, String> {
    let surface = result.map_err(|error| error.to_string())?;
    let mut png = Vec::new();
    surface
        .write_to_png(&mut png)
        .map_err(|error| error.to_string())?;
    Ok(png)
}
