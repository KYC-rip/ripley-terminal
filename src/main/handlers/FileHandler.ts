import { app, ipcMain } from 'electron';
import { join } from 'path';
import fs from 'fs';

export function registerFileHandlers() {
  ipcMain.handle('read-wallet-file', async (_, filename) => {
    try {
      const p = join(app.getPath('userData'), 'wallets', filename);
      if (!fs.existsSync(p)) return null;
      
      // 🔥 FIX: Read raw binary buffer. Electron IPC will clone this 
      // safely as a Uint8Array to the renderer. No Base64 needed.
      return fs.readFileSync(p);
    } catch (e) {
      return null;
    }
  });

  ipcMain.handle('write-wallet-file', async (_, { filename, data }) => {
    try {
      const dir = join(app.getPath('userData'), 'wallets');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      
      if (!data) return false;

      // 🔥 FIX: Handle both direct Buffer and Uint8Array (which IPC sends)
      const bufferToWrite = Buffer.isBuffer(data) ? data : Buffer.from(data);
      
      if (bufferToWrite.length === 0) return false;

      fs.writeFileSync(join(dir, filename), bufferToWrite);
      return true;
    } catch (e) {
      console.error(`[FileHandler] Write failed for ${filename}:`, e);
      return false;
    }
  });

  ipcMain.handle('get-wallet-path', () => join(app.getPath('userData'), 'wallets'));
}
