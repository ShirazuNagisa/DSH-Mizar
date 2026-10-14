#!/usr/bin/env bash
#
# Build and run the iOS app.
#
# Usage: scripts/ios.sh build|run|screenshot [simulator name]
#
# The project compiles MizarKit as an in-project framework target rather than as
# a Swift package reference. That is not a style choice: Xcode resolves a package
# by loading its manifest through swift-plugin-server, which writes a
# diagnostics file under ~/Library/Caches/org.swift.swiftpm. There is no build
# setting or environment variable that relocates it, so a package reference
# cannot resolve under a restricted file policy. The framework target compiles
# the same sources with no resolution step, and `swift test` still exercises the
# package for the test suite.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIMULATOR="${2:-iPhone 18 Pro}"
BUNDLE_ID="me.shirazu.dshmizar"
DERIVED="$ROOT/.devcache/DerivedData"

# Simulator builds are signed ad-hoc. That is not cosmetic: an unsigned app has
# no keychain entitlement, and the app stores its device token in the keychain,
# so it would launch and then fail to read its own credential (errSecMissingEntitlement,
# -34018). Ad-hoc signing costs nothing and needs no developer account.
xcb() {
  xcodebuild -project "$ROOT/iOS/DSH-Mizar.xcodeproj" \
    -scheme DSH-Mizar \
    -destination "platform=iOS Simulator,name=$SIMULATOR" \
    -derivedDataPath "$DERIVED" \
    CODE_SIGN_IDENTITY="-" \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGNING_ALLOWED=YES \
    "$@"
}

case "${1:-build}" in
  build)
    xcb build 2>&1 | grep -E "error:|warning:|BUILD" | sort -u || true
    xcb build >/dev/null 2>&1 || { echo "ios.sh: build failed"; exit 1; }
    echo "ios.sh: built"
    ;;
  run)
    xcrun simctl boot "$SIMULATOR" 2>/dev/null || true
    xcrun simctl bootstatus "$SIMULATOR" -b >/dev/null 2>&1 || true
    xcb build >/dev/null 2>&1 || { echo "ios.sh: build failed"; exit 1; }
    APP="$DERIVED/Build/Products/Debug-iphonesimulator/DSH-Mizar.app"
    # Uninstall first. Installing over a running app silently kept the old
    # binary in place at least once while localisation was being added, which
    # cost three rounds of screenshots that showed the previous build's English
    # strings while the bundle on disk already had the new ones.
    xcrun simctl uninstall "$SIMULATOR" "$BUNDLE_ID" 2>/dev/null || true
    xcrun simctl install "$SIMULATOR" "$APP"
    xcrun simctl terminate "$SIMULATOR" "$BUNDLE_ID" 2>/dev/null || true
    xcrun simctl launch "$SIMULATOR" "$BUNDLE_ID"
    ;;
  screenshot)
    OUT="${3:-/tmp/dsh-mizar.png}"
    xcrun simctl io "$SIMULATOR" screenshot "$OUT"
    echo "ios.sh: $OUT"
    ;;
  *)
    echo "usage: scripts/ios.sh build|run|screenshot [simulator] [out.png]" >&2
    exit 1
    ;;
esac
