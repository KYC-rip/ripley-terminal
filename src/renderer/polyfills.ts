// Standard Polyfills
window.global = window;
if (!window.process) {
  window.process = { env: { NODE_DEBUG: false }, versions: { electron: '1.0.0' }, nextTick: (cb: any) => setTimeout(cb, 0) };
}

// 🔥 Tactical FS Mock for monero-ts
// This matches the Node.js fs.promises API structure expected by the library
const mockFsPromises = {
  readFile: async () => { throw new Error("MOCK_FS_DISABLED"); },
  writeFile: async () => { },
  mkdir: async () => { },
  unlink: async () => { },
  stat: async () => { throw new Error("MOCK_FS_DISABLED"); },
  access: async () => { },
  rename: async () => { },
  copyFile: async () => { },
  readdir: async () => []
};

const mockFs = {
  promises: mockFsPromises
};

window.fs = mockFs;
(globalThis as any).fs = mockFs;

console.log("[Polyfills] Tactical FS injected to global scope.");
