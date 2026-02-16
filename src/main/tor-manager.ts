import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import * as tar from 'tar';
import AdmZip from 'adm-zip';

export class TorManager {
  private process: ChildProcess | null = null;
  private binPath: string;
  private torDir: string;

  constructor() {
    this.torDir = path.join(app.getPath('userData'), 'tor-bin');
    const exeName = process.platform === 'win32' ? 'tor.exe' : 'tor';
    this.binPath = path.join(this.torDir, 'tor', exeName); 
  }

  private getDownloadUrl() {
    const version = '14.0.1'; 
    if (process.platform === 'win32') {
      return `https://archive.torproject.org/tor-package-archive/torbrowser/${version}/tor-expert-bundle-windows-x86_64-${version}.tar.gz`;
    } else if (process.platform === 'darwin') {
      return `https://archive.torproject.org/tor-package-archive/torbrowser/${version}/tor-expert-bundle-macos-x86_64-${version}.tar.gz`;
    }
    return `https://archive.torproject.org/tor-package-archive/torbrowser/${version}/tor-expert-bundle-linux-x86_64-${version}.tar.gz`;
  }

  async ensureTorExists(onProgress: (msg: string) => void) {
    if (fs.existsSync(this.binPath) || fs.existsSync(path.join(this.torDir, 'tor'))) return true;

    if (!fs.existsSync(this.torDir)) fs.mkdirSync(this.torDir, { recursive: true });

    onProgress("Downloading Tor Expert Bundle...");
    const url = this.getDownloadUrl();
    const tempFile = path.join(this.torDir, 'tor-package.tar.gz');

    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      if (!response.body) throw new Error("Response body is null");

      const totalLength = response.headers.get('content-length');
      let downloadedLength = 0;

      const writer = fs.createWriteStream(tempFile);
      const reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        downloadedLength += value.length;
        if (totalLength) {
          const percent = ((downloadedLength / parseInt(totalLength)) * 100).toFixed(1);
          onProgress(`Downloading: ${percent}%`);
        }
        writer.write(Buffer.from(value));
      }

      writer.end();

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      onProgress("Extracting Tor binaries...");
      if (tempFile.endsWith('.tar.gz')) {
        await tar.x({
          file: tempFile,
          cwd: this.torDir
        });
      } else {
        const zip = new AdmZip(tempFile);
        zip.extractAllTo(this.torDir, true);
      }

      fs.unlinkSync(tempFile);

      if (process.platform !== 'win32') {
        fs.chmodSync(this.binPath, 0o755);
      }

      onProgress("Tor installation complete.");
      return true;
    } catch (e: any) {
      onProgress(`Tor Download Failed: ${e.message}`);
      return false;
    }
  }

  start(onLog: (msg: string) => void) {
    if (this.process) return;

    onLog(`Starting Tor from ${this.binPath}...`);
    
    this.process = spawn(this.binPath, ['--DataDirectory', path.join(this.torDir, 'data')], {
      stdio: 'pipe'
    });

    this.process.stdout?.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Bootstrapped')) onLog(msg.trim());
    });

    this.process.on('error', (err) => {
      onLog(`Tor Process Error: ${err.message}`);
    });
  }

  stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}
