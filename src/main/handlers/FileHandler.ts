import { app, ipcMain } from 'electron';
import { join } from 'path';
import fs from 'fs';

export function registerFileHandlers() {
  ipcMain.handle('read-wallet-file', async (_, filename) => {
    try {
      const p = join(app.getPath('userData'), 'wallets', filename);
      if (!fs.existsSync(p)) return null;
      return fs.readFileSync(p, { encoding: 'base64' });
    } catch (e) {
      return null;
    }
  });

  ipcMain.handle('write-wallet-file', async (_, { filename, data }) => {
    try {
      const dir = join(app.getPath('userData'), 'wallets');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      
      // Allow empty string for clearing files, only block null/undefined
      if (data === undefined || data === null) return false;
      
      fs.writeFileSync(join(dir, filename), Buffer.from(data, 'base64'));
      return true;
    } catch (e) {
      console.error(`[FileHandler] Write failed for ${filename}:`, e);
      return false;
    }
  });

  ipcMain.handle('get-wallet-path', () => join(app.getPath('userData'), 'wallets'));
}
