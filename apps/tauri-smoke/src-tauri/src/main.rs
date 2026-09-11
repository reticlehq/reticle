// The Rust "backend". The webview can only reach it through `invoke` — never over HTTP — which is
// exactly why Reticle's fetch/XHR patching sees nothing here and the IPC observer is required.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Clone, Serialize, Deserialize)]
struct Todo {
    id: u32,
    title: String,
    done: bool,
}

struct Store {
    todos: Mutex<Vec<Todo>>,
    next_id: Mutex<u32>,
}

#[tauri::command]
fn load_todos(store: State<Store>) -> Vec<Todo> {
    store.todos.lock().expect("todo lock").clone()
}

#[tauri::command]
fn add_todo(title: String, store: State<Store>) -> Result<Todo, String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("title is required".into());
    }
    let mut next_id = store.next_id.lock().expect("id lock");
    let todo = Todo {
        id: *next_id,
        title: trimmed.to_string(),
        done: false,
    };
    *next_id += 1;
    store.todos.lock().expect("todo lock").push(todo.clone());
    Ok(todo)
}

/// Always fails. The frontend calls this from a button that updates the UI first and swallows the
/// rejection — the false green Reticle exists to catch. The screen says "archived"; the IPC record
/// says `ipc://archive_todo ok:false`.
#[tauri::command]
fn archive_todo(_id: u32) -> Result<(), String> {
    Err("archive is not implemented in the backend".into())
}

/// Screenshots and headless mode come from `reticle-tauri` — see the two lines in `main` below.
///
/// Both used to be documented here as impossible on macOS. Neither is: `WKWebView.takeSnapshot`
/// renders the webview without reading the screen, and hiding the window AFTER its first page load
/// (rather than during `setup`, which is what every failing experiment did) leaves it running.

fn main() {
    tauri::Builder::default()
        .on_page_load(reticle_tauri::on_page_load)
        .manage(Store {
            todos: Mutex::new(vec![
                Todo {
                    id: 1,
                    title: "Wire Reticle into a Tauri app".into(),
                    done: true,
                },
                Todo {
                    id: 2,
                    title: "Assert on an invoke, not a screenshot".into(),
                    done: false,
                },
            ]),
            next_id: Mutex::new(3),
        })
        .invoke_handler(tauri::generate_handler![
            load_todos,
            add_todo,
            archive_todo,
            reticle_tauri::reticle_capture
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
