//! Path-locked KV for RipleyOS (`ripleyos:*` keys) under `$APPDATA/ros-kv/`.
//!
//! This is NOT general filesystem access and must stay off `fs:*` capabilities.
//! Compromised ROS JS can already read/write OS state in webview localStorage;
//! these commands persist that same namespaced map on disk so WKWebView quota
//! cannot drop settings. Vault ciphertext is still whatever RosSecure wrote —
//! the backend does not encrypt.
//!
//! Per-key files (atomic tmp+rename), not one JSON map: a ~2.5 MB currency
//! catalog must not rewrite every window-position save.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const DIR_NAME: &str = "ros-kv";
const MAX_VALUE_BYTES: usize = 32 * 1024 * 1024;
const KEY_PREFIX: &str = "ripleyos:";
const TMP_SUFFIX: &str = ".tmp";

/// Tauri runs `async` commands concurrently, and ROS fires `ros_kv_set` for the
/// same key back-to-back (the JS facade is synchronous and never awaits the
/// disk write). One GLOBAL lock — deliberately coarser than per-key — around
/// every mutation makes "last call wins" hold on disk the way it holds in the
/// JS cache; a hold is a few ms of synchronous fs work, never an await.
static KV_LOCK: Mutex<()> = Mutex::new(());
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn lock_kv() -> std::sync::MutexGuard<'static, ()> {
    // A panic while holding the lock must not brick every later write.
    KV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn kv_dir_from(app_data: &Path) -> PathBuf {
    app_data.join(DIR_NAME)
}

fn kv_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    let dir = kv_dir_from(&d);
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir)
}

fn assert_kv_dir(dir: &Path) -> Result<(), String> {
    match dir.file_name().and_then(|n| n.to_str()) {
        Some(DIR_NAME) => Ok(()),
        _ => Err("refuse to operate outside ros-kv".into()),
    }
}

/// Percent-encode so the filename mapping is injective. Unreserved: A-Za-z0-9._-
/// (`:` → `%3A`, `~` → `%7E`, `%` → `%25`). Reject path separators and NUL.
pub fn encode_key(key: &str) -> Result<String, String> {
    if !key.starts_with(KEY_PREFIX) {
        return Err("key must start with ripleyos:".into());
    }
    if key.contains('\0') || key.contains('/') || key.contains('\\') {
        return Err("key contains illegal path characters".into());
    }
    let mut out = String::with_capacity(key.len() + 8);
    for b in key.bytes() {
        if b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    Ok(out)
}

pub fn decode_key(stem: &str) -> Result<String, String> {
    if stem.is_empty() || stem == "." || stem == ".." {
        return Err("illegal stem".into());
    }
    let bytes = stem.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err("truncated percent-encoding".into());
            }
            let h = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|_| "bad percent")?;
            let v = u8::from_str_radix(h, 16).map_err(|_| "bad percent")?;
            out.push(v);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let key = String::from_utf8(out).map_err(|_| "filename is not utf-8")?;
    if !key.starts_with(KEY_PREFIX) {
        return Err("decoded key missing ripleyos: prefix".into());
    }
    Ok(key)
}

pub fn put(dir: &Path, key: &str, value: &str) -> Result<(), String> {
    assert_kv_dir(dir)?;
    if value.len() > MAX_VALUE_BYTES {
        return Err("value exceeds the 32 MiB limit".into());
    }
    fs::create_dir_all(dir).map_err(|e| format!("mkdir: {e}"))?;
    let stem = encode_key(key)?;
    let path = dir.join(&stem);
    // A tmp name unique to this call: two writers of one key sharing `<stem>.tmp`
    // used to rename each other's half-written file. The old `remove_file(path)`
    // before the rename is gone too — it let a concurrent writer delete the
    // freshly renamed file and then fail its own rename, leaving NO file at all
    // (that is how mail:accounts vanished). `rename` replaces atomically on
    // Unix and on Windows (MOVEFILE_REPLACE_EXISTING).
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!("{stem}.{}-{seq}{TMP_SUFFIX}", std::process::id()));
    let _guard = lock_kv();
    fs::write(&tmp, value.as_bytes()).map_err(|e| format!("write: {e}"))?;
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("rename: {e}"));
    }
    Ok(())
}

pub fn load(dir: &Path) -> Result<HashMap<String, String>, String> {
    assert_kv_dir(dir)?;
    let mut out = HashMap::new();
    if !dir.is_dir() {
        return Ok(out);
    }
    for entry in fs::read_dir(dir).map_err(|e| format!("read_dir: {e}"))? {
        let entry = entry.map_err(|e| format!("read_dir: {e}"))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(TMP_SUFFIX) {
            continue;
        }
        let Ok(key) = decode_key(&name) else { continue };
        // One unreadable/corrupt file must not fail the whole map — otherwise the
        // probe returns null and ROS boots on a webview that prior migrations emptied.
        let Ok(val) = fs::read_to_string(entry.path()) else { continue };
        out.insert(key, val);
    }
    Ok(out)
}

pub fn remove_key(dir: &Path, key: &str) -> Result<(), String> {
    assert_kv_dir(dir)?;
    let stem = encode_key(key)?;
    let path = dir.join(stem);
    let _guard = lock_kv();
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("remove: {e}"))?;
    }
    Ok(())
}

/// Delete only decoded `ripleyos:*` files inside ros-kv/. Never touches siblings
/// (wallpapers/, wallets, ghost_trades.json).
pub fn clear(dir: &Path) -> Result<(), String> {
    assert_kv_dir(dir)?;
    if !dir.is_dir() {
        return Ok(());
    }
    let _guard = lock_kv();
    for entry in fs::read_dir(dir).map_err(|e| format!("read_dir: {e}"))? {
        let entry = entry.map_err(|e| format!("read_dir: {e}"))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(TMP_SUFFIX) {
            let _ = fs::remove_file(entry.path());
            continue;
        }
        if decode_key(&name).is_ok() {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ros_kv_load(app: AppHandle) -> Result<HashMap<String, String>, String> {
    load(&kv_dir(&app)?)
}

#[tauri::command]
pub async fn ros_kv_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    put(&kv_dir(&app)?, &key, &value)
}

#[tauri::command]
pub async fn ros_kv_remove(app: AppHandle, key: String) -> Result<(), String> {
    remove_key(&kv_dir(&app)?, &key)
}

#[tauri::command]
pub async fn ros_kv_clear(app: AppHandle) -> Result<(), String> {
    clear(&kv_dir(&app)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch() -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let d = std::env::temp_dir()
            .join(format!("ros-kv-test-{n}"))
            .join("ros-kv");
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn concurrent_puts_to_one_key_never_lose_the_file() {
        let dir = scratch();
        let key = "ripleyos:race";
        let mut hs = Vec::new();
        for t in 0..4 {
            let d = dir.clone();
            hs.push(std::thread::spawn(move || {
                let mut errs = 0usize;
                for i in 0..2000 {
                    if put(&d, key, &format!("t{t}-{i}")).is_err() { errs += 1; }
                }
                errs
            }));
        }
        let errs: usize = hs.into_iter().map(|h| h.join().unwrap()).sum();
        let got = load(&dir).unwrap();
        assert_eq!(errs, 0, "{errs} concurrent puts failed (a failed put used to leave NO file behind)");
        assert!(got.contains_key(key), "file for {key} vanished after concurrent puts");
        // Complete value from one writer, never a torn/partial tmp.
        assert!(got[key].starts_with('t') && got[key].contains('-'), "torn value: {:?}", got[key]);
        // No stray per-call tmp files survive a clean run.
        let strays = fs::read_dir(&dir).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".tmp")).count();
        assert_eq!(strays, 0);
    }

    #[test]
    fn put_replaces_existing_file_and_remove_then_put_recreates() {
        let dir = scratch();
        put(&dir, "ripleyos:k", "one").unwrap();
        put(&dir, "ripleyos:k", "two").unwrap();
        assert_eq!(load(&dir).unwrap()["ripleyos:k"], "two");
        remove_key(&dir, "ripleyos:k").unwrap();
        assert!(!load(&dir).unwrap().contains_key("ripleyos:k"));
        put(&dir, "ripleyos:k", "three").unwrap();
        assert_eq!(load(&dir).unwrap()["ripleyos:k"], "three");
    }

    #[test]
    fn kv_dir_is_app_data_join_ros_kv() {
        let app_data = PathBuf::from("/tmp/Application Support/run.ripley.terminal");
        assert_eq!(kv_dir_from(&app_data), app_data.join("ros-kv"));
        let win = PathBuf::from(r"C:\Users\a\AppData\Roaming\run.ripley.terminal");
        assert_eq!(kv_dir_from(&win), win.join("ros-kv"));
        let xdg = PathBuf::from("/home/a/.local/share/run.ripley.terminal");
        assert_eq!(kv_dir_from(&xdg), xdg.join("ros-kv"));
    }

    #[test]
    fn encode_is_injective_and_round_trips_adversarial_names() {
        let keys = [
            "ripleyos:foo:bar",
            "ripleyos:foo~bar",
            "ripleyos:foo_bar",
            "ripleyos:foo%bar",
            "ripleyos:swap:currencies:cache:v4",
            "ripleyos:__native_migrated",
        ];
        let mut stems = std::collections::HashSet::new();
        for k in keys {
            let stem = encode_key(k).unwrap();
            assert!(stems.insert(stem.clone()), "collision on {k}");
            assert_eq!(decode_key(&stem).unwrap(), k);
        }
        assert_ne!(encode_key("ripleyos:foo:bar").unwrap(), encode_key("ripleyos:foo~bar").unwrap());
    }

    #[test]
    fn encode_rejects_bad_keys() {
        assert!(encode_key("not-namespaced").is_err());
        assert!(encode_key("ripleyos:foo/bar").is_err());
        assert!(encode_key("ripleyos:foo\\bar").is_err());
        assert!(encode_key("ripleyos:foo\0bar").is_err());
    }

    #[test]
    fn put_load_remove_round_trip() {
        let dir = scratch();
        put(&dir, "ripleyos:a", "one").unwrap();
        put(&dir, "ripleyos:b", "two").unwrap();
        let map = load(&dir).unwrap();
        assert_eq!(map.get("ripleyos:a").unwrap(), "one");
        assert_eq!(map.get("ripleyos:b").unwrap(), "two");
        remove_key(&dir, "ripleyos:a").unwrap();
        let map = load(&dir).unwrap();
        assert!(map.get("ripleyos:a").is_none());
        assert_eq!(map.get("ripleyos:b").unwrap(), "two");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn skips_tmp_and_refuses_to_operate_outside_ros_kv() {
        let dir = scratch();
        fs::write(dir.join("orphan.tmp"), "x").unwrap();
        put(&dir, "ripleyos:ok", "v").unwrap();
        let map = load(&dir).unwrap();
        assert_eq!(map.len(), 1);
        let elsewhere = std::env::temp_dir().join(format!("not-kv-{}", dir.file_name().unwrap().to_string_lossy()));
        fs::create_dir_all(&elsewhere).unwrap();
        assert!(put(&elsewhere, "ripleyos:x", "y").is_err());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&elsewhere);
    }

    #[test]
    fn clear_does_not_touch_sibling_wallpapers() {
        let parent = scratch().parent().unwrap().join(format!(
            "ros-kv-parent-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let kv = parent.join("ros-kv");
        let walls = parent.join("wallpapers");
        fs::create_dir_all(&kv).unwrap();
        fs::create_dir_all(&walls).unwrap();
        put(&kv, "ripleyos:a", "1").unwrap();
        fs::write(walls.join("keep.img"), b"img").unwrap();
        clear(&kv).unwrap();
        assert!(load(&kv).unwrap().is_empty());
        assert!(walls.join("keep.img").is_file());
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn load_skips_unreadable_entries_and_keeps_the_rest() {
        let dir = scratch();
        put(&dir, "ripleyos:good", "ok").unwrap();
        let stem = encode_key("ripleyos:bin").unwrap();
        fs::write(dir.join(stem), [0xff, 0xfe]).unwrap();
        let map = load(&dir).unwrap();
        assert_eq!(map.get("ripleyos:good").unwrap(), "ok");
        assert!(map.get("ripleyos:bin").is_none());
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn value_cap() {
        let dir = scratch();
        let too_big = "x".repeat(MAX_VALUE_BYTES + 1);
        assert!(put(&dir, "ripleyos:big", &too_big).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
