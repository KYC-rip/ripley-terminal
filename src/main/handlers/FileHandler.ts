import { app, ipcMain } from 'electron';
import { join } from 'path';
import fs from 'fs';
import zlib from 'zlib';
import { promisify } from 'util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export function registerFileHandlers() {
  ipcMain.handle('read-wallet-file', async (_, filename) => {
    try {
      const dir = join(app.getPath('userData'), 'wallets');
      if (!fs.existsSync(dir)) return null;

      const keysPath = join(dir, filename + ".keys");
      const cachePath = join(dir, filename + ".cache");
      
      const readAndDecompress = async (path: string) => {
        try {
          const buffer = await fs.promises.readFile(path);
          // Check for Gzip magic number (0x1f 0x8b)
          if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
            return await gunzip(buffer);
          }
          return buffer;
        } catch (e) {
          return null;
        }
      };

      const [keys, cache] = await Promise.all([
        readAndDecompress(keysPath),
        readAndDecompress(cachePath)
      ]);

      return [keys, cache];
    } catch (e) {
      return null;
    }
  });

  ipcMain.handle('write-wallet-file', async (_, { filename, data }) => {
    try {
      const dir = join(app.getPath('userData'), 'wallets');
      if (!fs.existsSync(dir)) await fs.promises.mkdir(dir, { recursive: true });

      if (!data) return false;

      const keysPath = join(dir, filename + ".keys");
      const cachePath = join(dir, filename + ".cache");

      if (data.length === 0) {
        await Promise.all([
          fs.promises.unlink(keysPath).catch(() => {}),
          fs.promises.unlink(cachePath).catch(() => {})
        ]);
      } else {
        // Compress data before writing to disk
        const compressAndWrite = async (path: string, rawData: any) => {
          if (!rawData) return;
          const compressed = await gzip(Buffer.from(rawData));
          await fs.promises.writeFile(path, compressed);
        };

        await Promise.all([
          compressAndWrite(keysPath, data[0]),
          compressAndWrite(cachePath, data[1])
        ]);
      }

      return true;
    } catch (e) {
      console.error(`[FileHandler] Write failed for ${filename}:`, e);
      return false;
    }
  });

  ipcMain.handle('get-wallet-path', () => join(app.getPath('userData'), 'wallets'));
}
