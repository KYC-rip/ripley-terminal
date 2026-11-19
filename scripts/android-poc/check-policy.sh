#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
bin=$(mktemp)
trap 'rm -f "$bin"' EXIT
rustc --edition 2021 --test src-tauri/src/android_policy.rs -o "$bin"
"$bin"
# Ensure the desktop entry point is a byte-for-byte move except the self-test path
# and the crate recursion attribute, which now lives in lib.rs.
python3 - <<'PY'
import subprocess,pathlib
old=subprocess.check_output(['git','show','59176fdfb12450006b68caeaa93785fd8a530692:src-tauri/src/lib.rs'],text=True)
expected=old.replace('#![recursion_limit = "512"]\n','').replace('include_str!("lib.rs")','include_str!("desktop.rs")')
assert pathlib.Path('src-tauri/src/desktop.rs').read_text()==expected
print('PASS: desktop runtime source preserved')
PY
