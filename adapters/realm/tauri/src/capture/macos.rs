//! macOS: `WKWebView.takeSnapshot`, which renders the webview's own contents.

use crate::SNAPSHOT_TIMEOUT;

pub fn snapshot_png(window: &tauri::WebviewWindow, full_page: bool) -> Result<Vec<u8>, String> {
    // This API composites what is on screen; there is no offscreen full-document render to ask for.
    if full_page {
        return Err(crate::FULL_PAGE_UNSUPPORTED.into());
    }
    use block2::RcBlock;
    use objc2_app_kit::NSImage;
    use objc2_foundation::NSError;
    use objc2_web_kit::WKWebView;

    let (sender, receiver) = std::sync::mpsc::channel::<Result<Vec<u8>, String>>();
    window
        .with_webview(move |webview| {
            // SAFETY: on macOS `inner()` is the `WKWebView` backing this window, and the closure runs
            // on the main thread, which is where WebKit requires its objects to be touched.
            let wk: &WKWebView = unsafe { &*(webview.inner() as *const WKWebView) };
            let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let _ = sender.send(encode_png(image, error));
            });
            unsafe { wk.takeSnapshotWithConfiguration_completionHandler(None, &handler) };
        })
        .map_err(|error| error.to_string())?;

    receiver
        .recv_timeout(SNAPSHOT_TIMEOUT)
        .map_err(|_| "webview snapshot timed out".to_string())?
}

fn encode_png(
    image: *mut objc2_app_kit::NSImage,
    error: *mut objc2_foundation::NSError,
) -> Result<Vec<u8>, String> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::NSDictionary;

    if !error.is_null() {
        // SAFETY: WebKit hands back a live NSError here; it is only read.
        return Err(unsafe { &*error }.localizedDescription().to_string());
    }
    if image.is_null() {
        return Err("webview returned no snapshot".into());
    }
    // SAFETY: non-null, and owned by the completion handler for the duration of this call.
    let image = unsafe { &*image };
    let tiff = image.TIFFRepresentation().ok_or("snapshot had no bitmap")?;
    let rep = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("snapshot bitmap was unreadable")?;
    let png = unsafe {
        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }
    .ok_or("snapshot could not be encoded as PNG")?;
    Ok(png.to_vec())
}
