import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Tauri-specific Vite config (replaces electron.vite.config.ts for Tauri builds)
export default defineConfig({
  root: '.',
  publicDir: 'public',
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer')
    }
  },
  plugins: [
    react(),
    tailwindcss()
  ],
  // Tauri expects a fixed port
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  // Env variables prefixed with TAURI_ are available in the frontend
  envPrefix: ['VITE_', 'TAURI_'],
});
