import { app, ipcMain } from 'electron';
import { join } from 'path';
import fs from 'fs';

export function registerFileHandlers() {
  ipcMain.handle('read-wallet-file', async (_, filename) => {
    try {
      const dir = join(app.getPath('userData'), 'wallets');
      if (!fs.existsSync(dir)) return null;

      const paths = [join(dir, filename + ".keys"), join(dir, filename + ".cache")];
      const fileData = paths.map(p => fs.readFileSync(p));

      return fileData;
    } catch (e) {
      return null;
    }
  });

  ipcMain.handle('write-wallet-file', async (_, { filename, data }) => {
    try {
      const dir = join(app.getPath('userData'), 'wallets');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      if (!data) return false;

      const paths = [join(dir, filename + ".keys"), join(dir, filename + ".cache")];

      if (data.length === 0)
        paths.forEach((p) => {
          fs.unlinkSync(p);
        });
      else
        paths.forEach((p, index) => {
          fs.writeFileSync(p, Uint8Array.from(data[index]));
        });

      return true;
    } catch (e) {
      console.error(`[FileHandler] Write failed for ${filename}:`, e);
      return false;
    }
  });

  ipcMain.handle('get-wallet-path', () => join(app.getPath('userData'), 'wallets'));
}
