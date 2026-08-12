//! The capture command, in its own module because `#[tauri::command]` re-exports a macro beside the
//! function — at the crate root that collides with the function's own re-export.
//!
//! Each platform reaches its webview through a different API, but all three share the property that
//! matters: they render the WEBVIEW, never the screen. Capturing a screen region instead was tried
//! and rejected — it photographs the glass, so a window sitting behind the editor yields a picture of
//! the editor, banked as a visual baseline a later diff would trust. None of these can do that, none
//! needs a screen-recording permission, and all three are correct with nothing on screen at all.

use crate::CAPTURE_FILE_PREFIX;

#[cfg(target_os = "macos")]
#[path = "capture/macos.rs"]
mod platform;

#[cfg(windows)]
#[path = "capture/windows.rs"]
mod platform;

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd"
))]
#[path = "capture/linux.rs"]
mod platform;

/// Capture the webview and return the path of the PNG written to the OS temp directory.
///
/// A path rather than the bytes: the SDK's transport caps every string at 64KB, so a base64 image
/// came back SILENTLY TRUNCATED and was banked as a "successful" screenshot no decoder could read.
/// The daemon and the app always share a machine, so a path keeps the image off the event wire.
///
/// The whole body runs on a BLOCKING thread. `snapshot_png` waits on a channel the webview answers
/// on (up to `SNAPSHOT_TIMEOUT`), and doing that directly in an `async fn` parks one of Tauri's async
/// worker threads for as long as the webview takes — so a wedged webview degrades every other
/// command in the app, not just this one.
#[tauri::command]
pub async fn reticle_capture(
    window: tauri::WebviewWindow,
    full_page: Option<bool>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || capture_to_temp_file(&window, full_page))
        .await
        .map_err(|error| error.to_string())?
}

fn capture_to_temp_file(
    window: &tauri::WebviewWindow,
    full_page: Option<bool>,
) -> Result<String, String> {
    let png = snapshot_png(window, full_page == Some(true))?;
    let dir = captures_dir()?;
    let path = dir.join(format!("{}{}.png", CAPTURE_FILE_PREFIX, nanos()));
    write_new_file(&path, &png).map_err(|error| error.to_string())?;
    sweep_stale_captures(dir, &path);
    Ok(path.to_string_lossy().into_owned())
}

/// This process's own capture directory, created 0700 on the first capture and reused after.
///
/// A screenshot of the app window can hold customer records, a token on screen, an authenticated
/// session. Written straight into the SHARED temp directory it is readable by any other local user
/// until the sweep removes it, and a symlink pre-placed at the name we are about to use would be
/// followed by the write.
///
/// A less guessable filename does not fix that — `nanos()` was already hard to guess. The property
/// that was missing is a private PARENT: another user cannot enter a 0700 directory to read a
/// capture, and cannot pre-create anything inside one that did not exist until this process made
/// it. `DirBuilder::create` is `mkdir(2)`, which fails rather than reusing an existing path, and
/// the mode is applied AS it is created so there is no window where it sits world-readable.
fn captures_dir() -> Result<&'static std::path::Path, String> {
    static CAPTURES_DIR: std::sync::OnceLock<Option<std::path::PathBuf>> =
        std::sync::OnceLock::new();
    CAPTURES_DIR
        .get_or_init(|| create_private_dir(&std::env::temp_dir()).ok())
        .as_deref()
        // Deliberately an error rather than a fall back to the shared temp directory: that fallback
        // is the exposure this directory exists to remove, and a capture that cannot be written
        // privately is one the caller should hear about.
        .ok_or_else(|| "reticle-tauri could not create a private capture directory".to_string())
}

/// Create `<base>/<prefix><pid>-<nanos>` with mode 0700, retrying only a name collision.
fn create_private_dir(base: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    let mut last = std::io::Error::new(std::io::ErrorKind::AlreadyExists, "no attempt made");
    for _ in 0..MAX_DIR_NAME_ATTEMPTS {
        let candidate = base.join(format!(
            "{CAPTURE_FILE_PREFIX}{}-{}",
            std::process::id(),
            nanos()
        ));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&candidate) {
            Ok(()) => return Ok(candidate),
            // Two captures on the same nanosecond tick, or a name an attacker guessed and squatted.
            // Both are answered by trying a new name rather than by adopting the existing one.
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => last = error,
            Err(error) => return Err(error),
        }
    }
    Err(last)
}

/// How many times to re-roll a colliding directory name before giving up.
const MAX_DIR_NAME_ATTEMPTS: u8 = 8;

/// Write, refusing an existing path instead of writing through it.
///
/// `create_new` is `O_CREAT|O_EXCL`, which does not follow a final symlink. The 0700 directory
/// already stops an attacker placing one here; this is the second lock on the same door, and the
/// one that still holds if a later change moves the write back out into the shared temp directory.
fn write_new_file(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)
}

/// How long a capture may sit in the temp dir before this process treats it as abandoned.
const STALE_CAPTURE_SECS: u64 = 60;

/// Delete this process's ABANDONED captures.
///
/// The daemon unlinks a capture once it has read it — but only if it ever reads. A session that
/// died, a command that timed out, or a path the daemon rejected each leave a ~500KB PNG in the temp
/// directory forever, and nothing else ever collects them. Sweeping on the next capture needs no
/// timer and no shutdown hook.
///
/// Age-gated, not "delete every sibling": two captures in flight and an unconditional sweep would
/// unlink the older one before the daemon had read it, turning a working screenshot into a
/// no-provider error. Best-effort throughout — a failed sweep must never fail a capture.
fn sweep_stale_captures(dir: &std::path::Path, keep: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return; // the capture directory is unreadable; the capture itself already succeeded
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Everything in here is this process's own, so the pid no longer has to be spelled into
        // each filename to keep one app from unlinking another's pending capture — the directory
        // carries that guarantee now.
        if path == keep {
            continue;
        }
        // A clock that went backwards yields Err here; that reads as "not old enough", which errs
        // toward keeping a file rather than deleting one a capture in flight may still need.
        let abandoned = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .is_ok_and(|modified| {
                modified
                    .elapsed()
                    .is_ok_and(|age| age.as_secs() >= STALE_CAPTURE_SECS)
            });
        if abandoned {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since_epoch| since_epoch.as_nanos())
        .unwrap_or(0)
}

#[cfg(any(
    target_os = "macos",
    windows,
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd"
))]
use platform::snapshot_png;

/// Anywhere with no webview API to call — say so, rather than return a plausible wrong image.
///
/// Reporting no-provider makes the tool answer "no screenshots here", which is a result an agent can
/// act on. A picture of the wrong thing is not.
#[cfg(not(any(
    target_os = "macos",
    windows,
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd"
)))]
fn snapshot_png(_window: &tauri::WebviewWindow, _full_page: bool) -> Result<Vec<u8>, String> {
    Err("reticle-tauri cannot capture a webview on this platform".into())
}

/// The capture directory and the write are a trust boundary, not a tidiness detail: a screenshot of
/// the app window is exactly the kind of thing another local user should not be able to read, and
/// the path we write is one they should not be able to redirect. These cover both without a webview.
#[cfg(test)]
mod tests {
    use super::{create_private_dir, write_new_file, CAPTURE_FILE_PREFIX};

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("reticle-tauri-test-{}-{}", name, super::nanos()));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn private_dir_is_a_named_child_of_the_base() {
        let base = scratch("child");
        let dir = create_private_dir(&base).expect("create");
        assert_eq!(dir.parent(), Some(base.as_path()));
        assert!(dir
            .file_name()
            .expect("name")
            .to_string_lossy()
            .starts_with(CAPTURE_FILE_PREFIX));
        std::fs::remove_dir_all(&base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn private_dir_is_created_0700_so_no_other_user_can_enter_it() {
        use std::os::unix::fs::PermissionsExt;
        let base = scratch("mode");
        let dir = create_private_dir(&base).expect("create");
        let mode = std::fs::metadata(&dir)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            mode, 0o700,
            "capture directory must not be readable by other local users"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn two_calls_never_share_a_directory() {
        let base = scratch("unique");
        let first = create_private_dir(&base).expect("first");
        let second = create_private_dir(&base).expect("second");
        assert_ne!(first, second);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn write_refuses_an_existing_path_instead_of_overwriting_it() {
        let base = scratch("exists");
        let path = base.join("taken.png");
        std::fs::write(&path, b"ORIGINAL").expect("seed");
        assert!(write_new_file(&path, b"REPLACED").is_err());
        assert_eq!(std::fs::read(&path).expect("read"), b"ORIGINAL");
        std::fs::remove_dir_all(&base).ok();
    }

    /// The half that catches a regression a permissions assertion alone would not: if the write is
    /// ever moved back out into the shared temp directory, a pre-placed symlink must still not be
    /// written through.
    #[cfg(unix)]
    #[test]
    fn write_does_not_follow_a_pre_placed_symlink() {
        let base = scratch("symlink");
        let victim = base.join("victim.txt");
        std::fs::write(&victim, b"ORIGINAL").expect("seed");
        let link = base.join("capture.png");
        std::os::unix::fs::symlink(&victim, &link).expect("symlink");

        assert!(write_new_file(&link, b"ATTACKER").is_err());
        assert_eq!(std::fs::read(&victim).expect("read"), b"ORIGINAL");
        std::fs::remove_dir_all(&base).ok();
    }
}
