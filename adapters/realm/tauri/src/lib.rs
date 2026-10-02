//! Reticle support for a Tauri app: screenshots, and a headless mode that actually stays awake.
//!
//! Tauri has no preload stage, so there is nowhere to install a JavaScript shim before app code
//! runs. Everything here is therefore Rust-side, and the browser SDK finds it on its own: it invokes
//! `reticle_capture` through Tauri's internals when no preload channel exists. An app wires this up
//! with two lines in `main.rs` and nothing at all in its frontend.
//!
//! ```no_run
//! tauri::Builder::default()
//!     .invoke_handler(tauri::generate_handler![reticle_tauri::reticle_capture])
//!     .on_page_load(reticle_tauri::on_page_load)
//! # ;
//! ```

mod capture;

pub use capture::*;

use tauri::{Runtime, Webview};

/// Filename prefix the daemon requires before it will read a capture off disk.
///
/// Source of truth is `RETICLE_CAPTURE_FILE_PREFIX` in `@reticlehq/core`; the two cannot share a
/// module graph, so `desktop-contract.test.ts` asserts this file still spells it the same way.
const CAPTURE_FILE_PREFIX: &str = "reticle-capture-";

/// How long to wait for the webview to hand back a snapshot before giving up.
const SNAPSHOT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Returned when `fullPage` is asked of a platform that can only give the composited viewport.
///
/// The SDK matches on this exact text, and `desktop-contract.test.ts` pins it to the daemon's
/// `VisualReason.FULL_PAGE_UNSUPPORTED`. Refusing beats downgrading: a caller who asked for the
/// whole scroll height and silently got the visible part banks a baseline that says nothing about
/// the content below the fold, and a later diff calls it a match.
pub const FULL_PAGE_UNSUPPORTED: &str = "full-page-unsupported";

/// Environment variable that asks for a window nobody can see.
const HEADLESS_ENV: &str = "RETICLE_HEADLESS";

/// Older macOS versions have no public WebKit background scheduling control.
#[cfg(target_os = "macos")]
const OFFSCREEN_PX: i32 = -32_000;

/// Hide the window after its first page load when `RETICLE_HEADLESS=1`.
///
/// Loading must finish before hiding: a webview that has never been presented may not load.
/// On macOS 14+, disable WebKit background throttling before hiding so commands and captures keep
/// working while idle. Older macOS versions retain the offscreen fallback; AppKit may constrain
/// that position back onto a display. Linux and Windows hide the loaded window directly.
pub fn on_page_load<R: Runtime>(
    webview: &Webview<R>,
    payload: &tauri::webview::PageLoadPayload<'_>,
) {
    if payload.event() != tauri::webview::PageLoadEvent::Finished {
        return;
    }
    if std::env::var(HEADLESS_ENV).as_deref() != Ok("1") {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        hide_macos(webview);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = webview.window().hide();
    }
}

#[cfg(target_os = "macos")]
fn hide_macos<R: Runtime>(webview: &Webview<R>) {
    use objc2::{runtime::NSObjectProtocol, sel};
    use objc2_web_kit::{WKInactiveSchedulingPolicy, WKWebView};

    let window = webview.window();
    let _ = webview.with_webview(move |inner| {
        // SAFETY: Tauri supplies the live WKWebView and executes this closure on the main thread.
        let wk: &WKWebView = unsafe { &*(inner.inner() as *const WKWebView) };
        let preferences = unsafe { wk.configuration().preferences() };
        if preferences.respondsToSelector(sel!(setInactiveSchedulingPolicy:)) {
            // SAFETY: this public selector is available on macOS 14+, checked above. Changing the
            // live view's preferences keeps its task scheduling active after the window is hidden.
            unsafe { preferences.setInactiveSchedulingPolicy(WKInactiveSchedulingPolicy::None) };
            let _ = window.hide();
        } else {
            let _ = window.set_position(tauri::PhysicalPosition::new(OFFSCREEN_PX, OFFSCREEN_PX));
        }
    });
}
