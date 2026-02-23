const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const tar = require('tar');

// Detect Platform and Architecture
const platform = process.env.TARGET_PLATFORM || process.platform; // darwin, linux, win32
const arch = process.env.TARGET_ARCH || process.arch; // arm64, x64

const PLATFORM_MAP = {
  'darwin-arm64': 'mac-arm64',
  'darwin-x64': 'mac-x64',
  'linux-x64': 'linux-x64',
  'win32-x64': 'win-x64'
};

const currentTarget = `${platform}-${arch}`;
const remoteSubDir = PLATFORM_MAP[currentTarget] || 'mac-arm64';

console.log(`[System] Identity: ${currentTarget} -> Mapping to: ${remoteSubDir}`);

const TARGETS = {
  tor: {
    url: `https://raw.githubusercontent.com/KYC-rip/wallet-binaries/main/${remoteSubDir}/tor-bundle.tar.gz`,
    hash: {
      'mac-arm64': '40ae11c3ec51d5d83d3208df6681e2142bd3cda1032d340e36fb0ee77d2cb818',
      'mac-x64': '50b3f5d6f83134e19191316f272a2752c492f5fa8d07b3db2bd3cda1032d340e', // Example placeholder
      'linux-x64': 'c421c7990e4a17df8269d680bdb8860d3cf1c77911ff5be5a874eb22ae08cc1c'
    }[remoteSubDir] || '40ae11c3ec51d5d83d3208df6681e2142bd3cda1032d340e36fb0ee77d2cb818',
    folder: 'tor-bundle'
  },
  rpc: {
    url: `https://raw.githubusercontent.com/KYC-rip/wallet-binaries/main/${remoteSubDir}/monero-rpc.tar.gz`,
    hash: {
      'mac-arm64': '0dbbab8147e3c6523c60ce5a62d35e3899606c727b7a2752c492f5fa8d07b3db',
      'mac-x64': '70d5f7d8f05336f19191316f272a2752c492f5fa8d07b3db4bd3cda1032d340g', // Example placeholder
      'linux-x64': '2c5e8f97d44bad338513a02b43fee919f93ac7bedfd1611dbb411b8731d3ddc7'
    }[remoteSubDir] || '0dbbab8147e3c6523c60ce5a62d35e3899606c727b7a2752c492f5fa8d07b3db',
    folder: 'rpc-core'
  },
};

const BIN_DIR = path.join(__dirname, '../resources/bin');
async function downloadAndExtractTarGz(name, url, expectedTarHash, destSubDir) {
  console.log(`\n[Armory] Processing: ${name}`);

  // Ensure binary directory exists before any FS operations
  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

  const destFolder = path.join(BIN_DIR, destSubDir);
  const tempTarFile = path.join(BIN_DIR, `temp_${Date.now()}.tar.gz`);
  const lockFilePath = path.join(destFolder, '.version.lock');

  const tempFiles = fs.readdirSync(BIN_DIR).filter(file => file.startsWith('temp_') && file.endsWith('.tar.gz'));
  tempFiles.forEach(file => fs.unlinkSync(path.join(BIN_DIR, file)));

  // 🛡️ Cache Hit Detection
  if (fs.existsSync(destFolder) && fs.existsSync(lockFilePath)) {
    const cachedHash = fs.readFileSync(lockFilePath, 'utf-8').trim();
    if (cachedHash === expectedTarHash) {
      console.log(`  [HIT] Cache verified for ${name}. Skipping download.`);
      return;
    } else {
      console.log(`  [MISS] Version mismatch. Cleaning up old files...`);
    }
  }

  // Ensure destination folder exists and is clean
  if (fs.existsSync(destFolder)) fs.rmSync(destFolder, { recursive: true, force: true });
  fs.mkdirSync(destFolder, { recursive: true });

  try {
    console.log(`  [DOWNLOADING] Fetching tarball from: ${url}`);

    await new Promise((resolve, reject) => {
      const download = (downloadUrl) => {
        https.get(downloadUrl, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return download(res.headers.location);
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`Failed to download: ${res.statusCode}`));
          }

          const writer = fs.createWriteStream(tempTarFile);
          res.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        }).on('error', reject);
      };
      download(url);
    });

    console.log(`  [AUDIT] Calculating SHA256...`);
    const downloadedHash = await calculateHash(tempTarFile);
    if (downloadedHash !== expectedTarHash) {
      throw new Error(`Hash mismatch! Expected: ${expectedTarHash}, Got: ${downloadedHash}`);
    }

    console.log(`  [EXTRACTING] Unpacking files...`);
    await tar.x({ file: tempTarFile, cwd: destFolder });

    if (process.platform === 'darwin') {
      const { execSync } = require('child_process');
      try {
        console.log(`  [SECURITY] Bypassing macOS Gatekeeper quarantine...`);
        execSync(`xattr -cr "${destFolder}"`);
      } catch (xattrErr) {
        console.warn(`  [WARNING] Failed to remove quarantine attribute: ${xattrErr.message}`);
      }
    }

    // 🔒 Write the lockfile for future cache hits
    fs.writeFileSync(lockFilePath, expectedTarHash, 'utf-8');

    fs.unlinkSync(tempTarFile);
    console.log(`  [SUCCESS] ${name} deployed.`);

  } catch (error) {
    if (fs.existsSync(tempTarFile)) fs.unlinkSync(tempTarFile);
    throw new Error(`Deployment failed: ${error.message}`);
  }
}

// Helper functions
function calculateHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------
// 🚀 Initialization Sequence
// ---------------------------------------------------------
async function main() {
  console.log(`=== 💀 KYC.RIP Hardcore Build Sequence Initiated ===`);

  try {
    // Concurrent Assembly
    await Promise.all([
      downloadAndExtractTarGz('Tor Obfuscated Bundle', TARGETS.tor.url, TARGETS.tor.hash, TARGETS.tor.folder),
      downloadAndExtractTarGz('Monero Lone Wolf Engine', TARGETS.rpc.url, TARGETS.rpc.hash, TARGETS.rpc.folder)
    ]);

    console.log(`\n=== 🟢 Armory assembled. Ready for React rendering layer! ===\n`);
  } catch (err) {
    console.error(`\n🔴 Critical Build Error:`, err.message);
    process.exit(1);
  }
}

main();