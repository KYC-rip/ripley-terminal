// scripts/get-hash.js
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// Get file path from command line arguments
const targetFile = process.argv[2];

if (!targetFile) {
  console.error('❌ Please provide a file path! Example: node scripts/get-hash.js ./my-file.tar.gz');
  process.exit(1);
}

const fullPath = path.resolve(targetFile);

if (!fs.existsSync(fullPath)) {
  console.error(`❌ File does not exist: ${fullPath}`);
  process.exit(1);
}

console.log(`\n🔍 Calculating SHA256: ${path.basename(fullPath)} ...\n`);

const hash = crypto.createHash('sha256');
const stream = fs.createReadStream(fullPath);

stream.on('data', chunk => hash.update(chunk));
stream.on('end', () => {
  const finalHash = hash.digest('hex');
  console.log(`================================================================`);
  console.log(`✅ SHA256: ${finalHash}`);
  console.log(`================================================================\n`);
  console.log(`You can now copy this hash into your deployment scripts.`);
});

stream.on('error', err => {
  console.error('❌ Failed to read file:', err);
});