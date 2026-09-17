#!/bin/sh
# Builds the Swift package and assembles TensionMirror.app next to this
# script. Re-run any time the Swift sources change; the web app itself
# (../app.py, ../static, ../templates) is read directly at runtime, no
# rebuild needed for changes there.
set -e
cd "$(dirname "$0")"

swift build -c release

APP="TensionMirror.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp .build/release/TensionMirrorMac "$APP/Contents/MacOS/TensionMirror"
cp Info.plist "$APP/Contents/Info.plist"

codesign --force --deep --sign - "$APP"

echo "Built $APP"
