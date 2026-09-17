#!/bin/sh
# Builds the Swift package and assembles TensionMirror.app next to this
# script. Re-run any time the Swift sources (or AppIcon/icon.svg) change;
# the web app itself (../app.py, ../static, ../templates) is read directly
# at runtime, no rebuild needed for changes there.
#
# Icon regeneration needs `rsvg-convert` (brew install librsvg) and the
# built-in `iconutil`. If rsvg-convert isn't installed, this just skips
# the icon and keeps whatever AppIcon.icns already exists (if any).
set -e
cd "$(dirname "$0")"

swift build -c release

APP="TensionMirror.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/TensionMirrorMac "$APP/Contents/MacOS/TensionMirror"
cp Info.plist "$APP/Contents/Info.plist"

if command -v rsvg-convert >/dev/null 2>&1; then
    ICONSET="AppIcon/AppIcon.iconset"
    rm -rf "$ICONSET"
    mkdir -p "$ICONSET"
    for spec in "16:icon_16x16" "32:icon_16x16@2x" "32:icon_32x32" "64:icon_32x32@2x" \
                "128:icon_128x128" "256:icon_128x128@2x" "256:icon_256x256" \
                "512:icon_256x256@2x" "512:icon_512x512" "1024:icon_512x512@2x"; do
        size="${spec%%:*}"
        name="${spec##*:}"
        rsvg-convert -w "$size" -h "$size" "AppIcon/icon.svg" -o "$ICONSET/${name}.png"
    done
    iconutil -c icns "$ICONSET" -o "AppIcon/AppIcon.icns"
    rm -rf "$ICONSET"
fi

if [ -f "AppIcon/AppIcon.icns" ]; then
    cp "AppIcon/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
fi

codesign --force --deep --sign - "$APP"

echo "Built $APP"
