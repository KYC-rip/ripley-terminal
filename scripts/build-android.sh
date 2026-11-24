#!/usr/bin/env bash
set -euo pipefail

# Build Ripley Terminal Native Android APK hosting the latest RipleyOS bundle.
# Usage:
#   ./scripts/build-android.sh [--debug|--release] [--local-ui] [--target aarch64|x86_64] [--ros-dir /path/to/ripley-os]

MODE="debug"
LOCAL_UI="0"
TARGET="aarch64"
ROS_DIR="${ROS_DIR:-$(cd "$(dirname "$0")/../../ripley-os" && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --debug) MODE="debug"; shift ;;
    --release) MODE="release"; shift ;;
    --local-ui) LOCAL_UI="1"; shift ;;
    --target) TARGET="$2"; shift 2 ;;
    --ros-dir) ROS_DIR="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/27.1.12297006}"
export TAURI_ANDROID_CLI="${TAURI_ANDROID_CLI:-$(command -v cargo-tauri || command -v tauri)}"
if [[ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]]; then
  export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
elif [[ -d "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home" ]]; then
  export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
fi

# Android 15+ 16 KB page alignment for native shared libraries (keep Tauri's Android link libs).
export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-Wl,-z,max-page-size=16384"

if [[ -d "$ROS_DIR/dist/m" && -f "$ROOT_DIR/scripts/sync-android-icons.py" ]]; then
  ROS_DIR="$ROS_DIR" python3 "$ROOT_DIR/scripts/sync-android-icons.py"
fi

LOCAL_RELEASE_MANIFEST="$ROOT_DIR/src-tauri/target/ros-android-local.manifest"
if [[ "$MODE" == "debug" && -d "$ROS_DIR/dist" ]]; then
  BUNDLE_OUT="$ROOT_DIR/src-tauri/target/ros-android-debug.tar.zst"
  MANIFEST_OUT="$ROOT_DIR/src-tauri/target/ros-android-debug.manifest"
  mkdir -p "$(dirname "$BUNDLE_OUT")"
  echo "[android] Packaging ROS bundle from $ROS_DIR/dist -> $BUNDLE_OUT"
  tar -C "$ROS_DIR/dist" --exclude='.DS_Store' -cf - . | zstd -q -f -3 -o "$BUNDLE_OUT"
  export ROS_ANDROID_DEBUG_BUNDLE="$BUNDLE_OUT"
  export ROS_ANDROID_DEBUG_BUNDLE_SHA256="$(shasum -a 256 "$BUNDLE_OUT" | awk '{print $1}')"
  export ROS_ANDROID_UI_REVISION="$(git -C "$ROS_DIR" rev-parse HEAD)"
  # Write manifest file so warm Gradle daemons (which do not inherit updated shell env vars)
  # still instruct build.rs to embed this freshly packaged ROS bundle.
  printf '%s\n%s\n%s\n' "$BUNDLE_OUT" "$ROS_ANDROID_DEBUG_BUNDLE_SHA256" "$ROS_ANDROID_UI_REVISION" > "$MANIFEST_OUT"
  echo "[android] Bundle SHA256=$ROS_ANDROID_DEBUG_BUNDLE_SHA256 REV=$ROS_ANDROID_UI_REVISION"
elif [[ "$MODE" == "release" && "$LOCAL_UI" == "1" && -d "$ROS_DIR/dist" ]]; then
  BUNDLE_OUT="$ROOT_DIR/src-tauri/target/ros-android-local.tar.zst"
  mkdir -p "$(dirname "$BUNDLE_OUT")"
  echo "[android] Packaging local ROS bundle for release testing -> $BUNDLE_OUT"
  tar -C "$ROS_DIR/dist" --exclude='.DS_Store' -cf - . | zstd -q -f -11 -o "$BUNDLE_OUT"
  SHA="$(shasum -a 256 "$BUNDLE_OUT" | awk '{print $1}')"
  REV="$(git -C "$ROS_DIR" rev-parse HEAD)"
  printf '%s\n%s\n%s\n' "$BUNDLE_OUT" "$SHA" "$REV" > "$LOCAL_RELEASE_MANIFEST"
  echo "[android] Local release bundle SHA256=$SHA REV=$REV"
else
  rm -f "$LOCAL_RELEASE_MANIFEST"
fi

cd "$ROOT_DIR"
EXTRA_FLAGS=()
if [[ "$MODE" == "debug" ]]; then
  EXTRA_FLAGS+=(--debug)
fi

echo "[android] Running cargo tauri android build (${MODE}, target=${TARGET})"
cargo tauri android build "${EXTRA_FLAGS[@]}" --target "$TARGET" --apk --config src-tauri/tauri.android.conf.json
