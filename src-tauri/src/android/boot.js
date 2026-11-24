// Lightweight Android WebView compatibility shim for RipleyOS:
// 1. Routes navigator.clipboard.{readText,writeText} to Android ClipboardManager
//    (with EXTRA_IS_SENSITIVE on API 24+).
// 2. Routes <a download href="blob:..."> exports to Android Storage Access Framework
//    (ACTION_CREATE_DOCUMENT) before the page revokes the object URL.
// Everything else (wallet, Tor, fetch, browser, SOLO shortcuts, secure screen, KV,
// wallpapers, OTA) runs directly over standard window.__TAURI__.core.invoke in native.ts.
if (window === window.top && window.__TAURI__ && window.__TAURI__.core) {
  const invoke = window.__TAURI__.core.invoke;

  const clipboardRead = () => invoke('android_clipboard_read').then(r => (r && r.text) || '');
  const clipboardWrite = text => invoke('android_clipboard_write', { text: String(text) }).then(() => {});
  try {
    if (!navigator.clipboard) Object.defineProperty(navigator, 'clipboard', { value: {} });
    Object.defineProperty(navigator.clipboard, 'readText', { value: clipboardRead, configurable: true });
    Object.defineProperty(navigator.clipboard, 'writeText', { value: clipboardWrite, configurable: true });
  } catch { /* WebView clipboard shim best effort */ }

  const originalFetch = window.fetch.bind(window);
  const downloadBlobs = new Map();
  const createBlobURL = URL.createObjectURL.bind(URL);
  const revokeBlobURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = b => {
    const u = createBlobURL(b);
    if (b instanceof Blob) downloadBlobs.set(u, b);
    return u;
  };
  URL.revokeObjectURL = u => {
    downloadBlobs.delete(String(u));
    revokeBlobURL(u);
  };

  const saveAnchor = async a => {
    if (!a.download || !a.href.startsWith('blob:')) return false;
    const captured = downloadBlobs.get(a.href);
    const b = captured || await (await originalFetch(a.href)).blob();
    if (b.size > 16 * 1024 * 1024) throw new Error('Export exceeds 16 MiB');
    const bytes = new Uint8Array(await b.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
    await invoke('android_save_export', { name: a.download, mime: b.type || 'application/octet-stream', base64: btoa(s) });
    return true;
  };
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && this.href.startsWith('blob:')) {
      saveAnchor(this).catch(e => console.warn('[android] export failed', e));
    } else {
      origClick.call(this);
    }
  };
  document.addEventListener('click', e => {
    const a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
    if (a && a.href && a.href.startsWith('blob:')) {
      e.preventDefault();
      saveAnchor(a).catch(x => console.warn('[android] export failed', x));
    }
  }, true);
}
