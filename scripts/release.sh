#!/usr/bin/env bash
#
# Build a TestFlight-ready build and upload it to App Store Connect.
#
# Usage:
#   scripts/release.sh archive   build the .xcarchive, upload nothing
#   scripts/release.sh export    make a local .ipa, upload nothing
#   scripts/release.sh upload    archive, export and upload
#   scripts/release.sh open      open the archive in Organizer, ready to upload
#   scripts/release.sh bump      show the current version and build number
#
# Artifacts land in ./release/ at the repository root:
#   release/DSH-Mizar.xcarchive   double-click, or `open` it, to reach Organizer
#   release/export/DSH-Mizar.ipa  the uploadable build
#
# Signing needs a paid Apple Developer account with an "Apple Distribution"
# certificate in the login keychain. If the certificate is missing, run
# `scripts/release.sh archive` under Xcode's own account handling first, or add
# the certificate through Xcode's Settings > Accounts.
#
# The first upload for a bundle id also needs an app record to exist in App
# Store Connect. Xcode cannot create one; see docs/testflight.md.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEAM_ID="${MIZAR_TEAM_ID:-5Q2A46685M}"
SCHEME="DSH-Mizar"
PROJECT="$ROOT/iOS/DSH-Mizar.xcodeproj"
# Deliberately NOT under .devcache: that is a hidden directory, Finder does not
# show it, and "open the archive in Organizer" is an instruction somebody has to
# be able to follow. DerivedData stays hidden because nobody opens it by hand.
BUILD_DIR="$ROOT/release"
ARCHIVE="$BUILD_DIR/DSH-Mizar.xcarchive"
EXPORT_DIR="$BUILD_DIR/export"
EXPORT_OPTIONS="$ROOT/iOS/ExportOptions.plist"

mkdir -p "$BUILD_DIR"

# Localised rejection messages are useless in a build log; force English so a
# failure can be grepped and understood the same way on any machine.
export LC_ALL=en_US.UTF-8

archive() {
  echo "release: archiving $SCHEME for the App Store"
  xcodebuild archive \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE" \
    -derivedDataPath "$ROOT/.devcache/DerivedData" \
    -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$TEAM_ID" \
    CODE_SIGN_STYLE=Automatic \
    | grep -E "error:|warning: .*(provision|sign|entitlement)|ARCHIVE (SUCCEEDED|FAILED)" || true
  test -d "$ARCHIVE" || { echo "release: archive failed"; exit 1; }
  echo "release: $ARCHIVE"
  /usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleShortVersionString' \
    "$ARCHIVE/Info.plist" | sed 's/^/release: version /'
  /usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleVersion' \
    "$ARCHIVE/Info.plist" | sed 's/^/release: build /'
}

export_ipa() {
  local destination="$1"
  # A copy, not the file itself: rewriting the committed plist would leave the
  # working tree dirty after every export, and the destination is a per-run
  # choice rather than a project setting.
  local options="$ROOT/.devcache/ExportOptions.$destination.plist"
  cp "$EXPORT_OPTIONS" "$options"
  /usr/libexec/PlistBuddy -c "Set :destination $destination" "$options"
  echo "release: exporting ($destination)"
  xcodebuild -exportArchive \
    -archivePath "$ARCHIVE" \
    -exportPath "$EXPORT_DIR" \
    -exportOptionsPlist "$options" \
    -allowProvisioningUpdates \
    | grep -E "error:|Upload succeeded|Exported|EXPORT (SUCCEEDED|FAILED)" || true
}

case "${1:-archive}" in
  archive) archive ;;
  open)
    # The instruction people actually need after this script runs.
    test -d "$ARCHIVE" || { echo "release: nothing to open yet — run 'scripts/release.sh archive'"; exit 1; }
    open "$ARCHIVE"
    echo "release: opened $ARCHIVE in Organizer — Distribute App > TestFlight & App Store"
    ;;
  export)  archive; export_ipa export ;;
  upload)  archive; export_ipa upload ;;
  bump)
    /usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleShortVersionString' \
      "$ARCHIVE/Info.plist" 2>/dev/null \
      || grep -m2 'MARKETING_VERSION\|CURRENT_PROJECT_VERSION' "$PROJECT/project.pbxproj" | sort -u
    ;;
  *) echo "usage: scripts/release.sh archive|export|upload|open|bump" >&2; exit 1 ;;
esac
