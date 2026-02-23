#!/bin/bash
# 💀 GHOST TERMINAL - Linux Binary Packaging Tool
# This script downloads official binaries and repackages them for the kyc-rip downloader.

set -e

WORKSPACE="linux_assembly"
mkdir -p $WORKSPACE
cd $WORKSPACE

echo "--- 📦 Downloading Official Binaries ---"
# Monero 0.18.4.5
curl -L -o monero.tar.bz2 https://downloads.getmonero.org/cli/monero-linux-x64-v0.18.4.5.tar.bz2
# Tor Expert Bundle 14.0.4
curl -L -o tor.tar.gz https://archive.torproject.org/tor-package-archive/torbrowser/14.0.4/tor-expert-bundle-linux-x86_64-14.0.4.tar.gz

echo "--- 🛠️ Repackaging Monero RPC ---"
mkdir -p monero_raw
tar -xjf monero.tar.bz2 -C monero_raw
mkdir -p rpc-core
# Adjust path if folder name differs
find monero_raw -name "monero-wallet-rpc" -exec cp {} rpc-core/ \;
tar -czvf monero-rpc.tar.gz -C rpc-core .

echo "--- 🛠️ Repackaging Tor Bundle ---"
mkdir -p tor-bundle
tar -xzf tor.tar.gz -C tor-bundle
tar -czvf tor-bundle.tar.gz -C tor-bundle .

echo "--- ✅ Finalizing ---"
mv monero-rpc.tar.gz ..
mv tor-bundle.tar.gz ..
cd ..

echo "--------------------------------------------------"
echo "TASKS COMPLETED."
echo "1. Upload 'monero-rpc.tar.gz' and 'tor-bundle.tar.gz' to your 'wallet-binaries' repo under 'linux-x64/'"
echo "2. Use these hashes in download-bins.js:"
echo ""
echo "Monero RPC Hash:"
shasum -a 256 monero-rpc.tar.gz
echo ""
echo "Tor Bundle Hash:"
shasum -a 256 tor-bundle.tar.gz
echo "--------------------------------------------------"

# Cleanup
rm -rf $WORKSPACE
