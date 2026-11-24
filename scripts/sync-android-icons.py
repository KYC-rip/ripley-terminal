#!/usr/bin/env python3
"""
Sync RipleyOS default icon and all embedded app icons into the Android project:
  - Replaces default Tauri launcher icon with the real RipleyOS icon (adaptive + legacy mipmaps)
  - Generates adaptive + fallback mipmap icons for every embedded ROS app
  - Updates <activity-alias> entries in AndroidManifest.xml (default ROS + per-app aliases)
  - Generates LauncherIcons.kt registry used by NativeIoPlugin for dynamic icon switching
"""
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ROS_DIST = Path(os.environ.get("ROS_DIR", ROOT.parent / "ripley-os")) / "dist"
ANDROID_MAIN = ROOT / "src-tauri/gen/android/app/src/main"
RES = ANDROID_MAIN / "res"
MANIFEST = ANDROID_MAIN / "AndroidManifest.xml"
KOTLIN_OUT = ANDROID_MAIN / "java/run/ripley/terminal/LauncherIcons.kt"

# Retired / internal alias IDs that shouldn't duplicate canonical apps in the icon picker.
SKIP_IDS = {
    "2fa", "about", "bridge", "console", "contacts", "devcenter", "dex",
    "evmwallet", "feedback", "ghost", "ghostbridge", "market", "permissions",
    "swap", "totp", "welcome",
}

LEGACY_DENSITIES = [
    ("mipmap-mdpi", 48),
    ("mipmap-hdpi", 72),
    ("mipmap-xhdpi", 96),
    ("mipmap-xxhdpi", 144),
    ("mipmap-xxxhdpi", 192),
]

BEGIN_MARKER = "        <!-- BEGIN GENERATED APP ICON ALIASES -->"
END_MARKER = "        <!-- END GENERATED APP ICON ALIASES -->"


def resize_png(src: Path, dst: Path, size: int) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["sips", "-z", str(size), str(size), str(src), "--out", str(dst)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def xml_escape(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "\\'")
    )


def main() -> None:
    if not (ROS_DIST / "m").is_dir():
        raise SystemExit(f"ROS dist/m not found at {ROS_DIST / 'm'} — run npm run build in ripley-os first")

    drawable_nodpi = RES / "drawable-nodpi"
    mipmap_v26 = RES / "mipmap-anydpi-v26"
    mipmap_xxxhdpi = RES / "mipmap-xxxhdpi"
    drawable_nodpi.mkdir(parents=True, exist_ok=True)
    mipmap_v26.mkdir(parents=True, exist_ok=True)
    mipmap_xxxhdpi.mkdir(parents=True, exist_ok=True)

    # 1. Ensure #08080b adaptive icon background color exists in colors.xml
    colors_xml = RES / "values/colors.xml"
    ctext = colors_xml.read_text()
    if 'name="ic_ros_bg"' not in ctext:
        ctext = ctext.replace(
            "</resources>",
            '    <color name="ic_ros_bg">#FF08080B</color>\n</resources>',
        )
        colors_xml.write_text(ctext)

    # 2. Replace default Tauri ic_launcher with real RipleyOS icon
    ros_maskable = ROS_DIST / "icon-maskable.png"
    ros_512 = ROS_DIST / "icon-512.png"
    shutil.copy2(ros_maskable, drawable_nodpi / "ic_ros_default_fg.png")
    adaptive_default = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_ros_bg" />
    <foreground android:drawable="@drawable/ic_ros_default_fg" />
</adaptive-icon>
"""
    (mipmap_v26 / "ic_launcher.xml").write_text(adaptive_default)
    (mipmap_v26 / "ic_launcher_round.xml").write_text(adaptive_default)
    for folder, px in LEGACY_DENSITIES:
        resize_png(ros_512, RES / folder / "ic_launcher.png", px)
        resize_png(ros_512, RES / folder / "ic_launcher_round.png", px)
        fg_dst = RES / folder / "ic_launcher_foreground.png"
        if fg_dst.exists():
            resize_png(ros_maskable, fg_dst, px)

    # 3. Collect all embedded ROS apps from dist/m/*-maskable.png + *.webmanifest
    entries: list[tuple[str, str]] = []
    for png in sorted((ROS_DIST / "m").glob("*-maskable.png")):
        app_id = png.name.removesuffix("-maskable.png").lower()
        if app_id in SKIP_IDS:
            continue
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,31}", app_id):
            continue
        label = app_id.capitalize()
        mf = ROS_DIST / "m" / f"{app_id}.webmanifest"
        if mf.exists():
            try:
                data = json.loads(mf.read_text())
                label = (data.get("short_name") or data.get("name") or label).strip()
            except Exception:
                pass
        # Copy maskable PNG as adaptive foreground + 192px fallback mipmap
        shutil.copy2(png, drawable_nodpi / f"ic_ros_app_{app_id}_fg.png")
        fallback_192 = ROS_DIST / "m" / f"{app_id}-192.png"
        shutil.copy2(fallback_192 if fallback_192.exists() else png, mipmap_xxxhdpi / f"ic_ros_app_{app_id}.png")
        (mipmap_v26 / f"ic_ros_app_{app_id}.xml").write_text(
            f"""<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_ros_bg" />
    <foreground android:drawable="@drawable/ic_ros_app_{app_id}_fg" />
</adaptive-icon>
"""
        )
        entries.append((app_id, label))

    # 4. Generate <activity-alias> entries in AndroidManifest.xml
    alias_blocks = [
        """        <activity-alias
            android:name=".LauncherDefault"
            android:enabled="true"
            android:exported="true"
            android:icon="@mipmap/ic_launcher"
            android:roundIcon="@mipmap/ic_launcher_round"
            android:label="RipleyOS"
            android:targetActivity=".MainActivity">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
            </intent-filter>
            <meta-data
                android:name="android.app.shortcuts"
                android:resource="@xml/shortcuts" />
        </activity-alias>"""
    ]
    for app_id, label in entries:
        esc = xml_escape(label)
        alias_blocks.append(
            f"""        <activity-alias
            android:name=".Launcher_{app_id}"
            android:enabled="false"
            android:exported="true"
            android:icon="@mipmap/ic_ros_app_{app_id}"
            android:roundIcon="@mipmap/ic_ros_app_{app_id}"
            android:label="{esc}"
            android:targetActivity=".MainActivity">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            <meta-data
                android:name="android.app.shortcuts"
                android:resource="@xml/shortcuts" />
        </activity-alias>"""
        )

    generated_section = BEGIN_MARKER + "\n" + "\n".join(alias_blocks) + "\n" + END_MARKER
    manifest_text = MANIFEST.read_text()

    # Remove direct MAIN/LAUNCHER filter from MainActivity if present (now owned by LauncherDefault alias)
    manifest_text = re.sub(
        r'\s*<intent-filter>\s*<action android:name="android\.intent\.action\.MAIN" />\s*<category android:name="android\.intent\.category\.LAUNCHER" />(?:\s*<category android:name="android\.intent\.category\.LEANBACK_LAUNCHER" />)?\s*</intent-filter>',
        "",
        manifest_text,
        count=1,
    )

    if BEGIN_MARKER in manifest_text and END_MARKER in manifest_text:
        manifest_text = re.sub(
            re.escape(BEGIN_MARKER) + r".*?" + re.escape(END_MARKER),
            generated_section,
            manifest_text,
            flags=re.S,
        )
    else:
        manifest_text = manifest_text.replace(
            "        </activity>\n",
            "        </activity>\n\n" + generated_section + "\n",
            1,
        )
    # Also ensure application tag declares roundIcon
    if 'android:roundIcon=' not in manifest_text:
        manifest_text = manifest_text.replace(
            'android:icon="@mipmap/ic_launcher"',
            'android:icon="@mipmap/ic_launcher"\n        android:roundIcon="@mipmap/ic_launcher_round"',
            1,
        )
    MANIFEST.write_text(manifest_text)

    # 5. Generate LauncherIcons.kt
    kt_rows = ['    Entry("default", "RipleyOS", "run.ripley.terminal.LauncherDefault"),']
    for app_id, label in entries:
        safe_label = label.replace("\\", "\\\\").replace('"', '\\"')
        kt_rows.append(f'    Entry("{app_id}", "{safe_label}", "run.ripley.terminal.Launcher_{app_id}"),')

    KOTLIN_OUT.write_text(
        """package run.ripley.terminal

// Auto-generated by scripts/sync-android-icons.py from ripley-os/dist/m/.
object LauncherIcons {
  data class Entry(val id: String, val label: String, val aliasClass: String)

  const val DEFAULT_ID = "default"

  val ALL: List<Entry> = listOf(
"""
        + "\n".join(kt_rows)
        + """
  )

  val BY_ID: Map<String, Entry> = ALL.associateBy { it.id }
}
"""
    )
    print(f"[icons] Synced ROS default icon + {len(entries)} embedded app icon aliases into Android manifest & resources.")


if __name__ == "__main__":
    main()
