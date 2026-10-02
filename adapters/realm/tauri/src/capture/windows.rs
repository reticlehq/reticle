//! Windows: WebView2's `CapturePreview`, which renders the webview into a stream.
//!
//! Like the macOS path this asks the WEBVIEW for its pixels rather than reading the screen, so it is
//! correct while the window is occluded, hidden, or headless, and it cannot return another window's
//! contents. WebView2 encodes PNG itself, so there is no bitmap conversion step here.

use crate::SNAPSHOT_TIMEOUT;

use webview2_com::CapturePreviewCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
use windows::Win32::System::Com::{IStream, STATFLAG_NONAME, STREAM_SEEK_SET};
use windows::Win32::UI::Shell::SHCreateMemStream;

pub fn snapshot_png(window: &tauri::WebviewWindow, full_page: bool) -> Result<Vec<u8>, String> {
    // This API composites what is on screen; there is no offscreen full-document render to ask for.
    if full_page {
        return Err(crate::FULL_PAGE_UNSUPPORTED.into());
    }
    let (sender, receiver) = std::sync::mpsc::channel::<Result<Vec<u8>, String>>();
    window
        .with_webview(move |webview| {
            let _ = sender.send(capture(&webview));
        })
        .map_err(|error| error.to_string())?;

    receiver
        .recv_timeout(SNAPSHOT_TIMEOUT)
        .map_err(|_| "webview snapshot timed out".to_string())?
}

/// Runs on the UI thread, inside `with_webview`.
///
/// `wait_for_async_operation` blocks until WebView2 calls back, pumping the message loop while it
/// waits — which is why this has to be on the UI thread and why it does not deadlock there.
fn capture(webview: &tauri::webview::PlatformWebview) -> Result<Vec<u8>, String> {
    let core = unsafe { webview.controller().CoreWebView2() }.map_err(|e| e.to_string())?;
    let stream = unsafe { SHCreateMemStream(None) }.ok_or("could not allocate a capture buffer")?;

    let target = stream.clone();
    CapturePreviewCompletedHandler::wait_for_async_operation(
        Box::new(move |handler| {
            unsafe {
                core.CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                    &target,
                    &handler,
                )
            }
            .map_err(webview2_com::Error::WindowsError)
        }),
        // WebView2's HRESULT already arrives decoded as a `Result`; pass its verdict straight on.
        Box::new(|result| result),
    )
    .map_err(|error| error.to_string())?;

    read_stream(&stream)
}

/// Drain the memory stream WebView2 wrote the PNG into.
fn read_stream(stream: &IStream) -> Result<Vec<u8>, String> {
    let mut stat = Default::default();
    unsafe { stream.Stat(&mut stat, STATFLAG_NONAME) }.map_err(|error| error.to_string())?;

    let size = usize::try_from(stat.cbSize).map_err(|_| "capture was too large to read")?;
    if size == 0 {
        return Err("webview returned no snapshot".into());
    }
    unsafe { stream.Seek(0, STREAM_SEEK_SET, None) }.map_err(|error| error.to_string())?;

    let mut png = vec![0u8; size];
    let mut read = 0u32;
    let length = u32::try_from(size).map_err(|_| "capture was too large to read")?;
    unsafe { stream.Read(png.as_mut_ptr().cast(), length, Some(&mut read)) }
        .ok()
        .map_err(|error| error.to_string())?;

    // A short read is a truncated PNG. Reporting the bytes actually read keeps the IEND check that
    // guards the daemon meaningful, instead of padding the tail with zeroes that decode as garbage.
    png.truncate(usize::try_from(read).unwrap_or(0));
    Ok(png)
}
