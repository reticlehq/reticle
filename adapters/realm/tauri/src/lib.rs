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

/// Keep the window drivable behind other windows, and hide it when `RETICLE_HEADLESS=1`.
///
/// macOS throttles an occluded WKWebView: its timers and rendering stop, so every check a drive
/// makes while the window is behind another comes back "has not rendered". Reported from a drive the
/// platform's chat asked for, which proved nothing until the window was brought forward by hand. On
/// macOS 14+ WebKit can be told to keep scheduling while inactive, and this crate is dev-only, so it
/// is done for every window it is installed in.
///
/// Headless mode then hides the window, after its first load: a webview that has never been
/// presented may not load. Older macOS has no scheduling control, so headless falls back to an
/// offscreen position (AppKit may constrain it back onto a display). Linux and Windows hide directly.
pub fn on_page_load<R: Runtime>(
    webview: &Webview<R>,
    payload: &tauri::webview::PageLoadPayload<'_>,
) {
    if payload.event() != tauri::webview::PageLoadEvent::Finished {
        return;
    }
    let headless = std::env::var(HEADLESS_ENV).as_deref() == Ok("1");
    #[cfg(target_os = "macos")]
    {
        awake_macos(webview, headless);
    }
    #[cfg(not(target_os = "macos"))]
    {
        if headless {
            let _ = webview.window().hide();
        }
    }
}

#[cfg(target_os = "macos")]
fn awake_macos<R: Runtime>(webview: &Webview<R>, headless: bool) {
    use objc2::{runtime::NSObjectProtocol, sel};
    use objc2_web_kit::{WKInactiveSchedulingPolicy, WKWebView};

    let window = webview.window();
    let _ = webview.with_webview(move |inner| {
        // SAFETY: Tauri supplies the live WKWebView and executes this closure on the main thread.
        let wk: &WKWebView = unsafe { &*(inner.inner() as *const WKWebView) };
        let preferences = unsafe { wk.configuration().preferences() };
        let awake = preferences.respondsToSelector(sel!(setInactiveSchedulingPolicy:));
        if awake {
            // SAFETY: this public selector is available on macOS 14+, checked above. Changing the
            // live view's preferences keeps its task scheduling active while it is not in front.
            unsafe { preferences.setInactiveSchedulingPolicy(WKInactiveSchedulingPolicy::None) };
        }
        if !headless {
            return;
        }
        if awake {
            let _ = window.hide();
        } else {
            let _ = window.set_position(tauri::PhysicalPosition::new(OFFSCREEN_PX, OFFSCREEN_PX));
        }
    });
}
