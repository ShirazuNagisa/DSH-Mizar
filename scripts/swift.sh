#!/usr/bin/env bash
#
# Swift build/test wrapper for MizarKit.
#
# Two flags are not optional in this environment:
#
#   --disable-sandbox   SwiftPM runs manifest compilation and plugin execution
#                       under its own `sandbox-exec`, which cannot nest inside
#                       the DSH session's file sandbox: the build fails with
#                       "sandbox_apply: Operation not permitted". Disabling
#                       SwiftPM's sandbox leaves it running as an ordinary
#                       subprocess under the session's own policy.
#
#   --cache-path etc.   SwiftPM defaults to ~/Library/org.swift.swiftpm, which is
#                       outside the writable workspace. Redirecting all three
#                       paths keeps the whole build inside the checkout.
#
# Usage: scripts/swift.sh build|test [extra swift args...]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE="$ROOT/iOS/MizarKit"
CACHE="$ROOT/.devcache/swiftpm"

mkdir -p "$CACHE"

command="${1:-test}"
shift || true

cd "$PACKAGE"
exec swift "$command" \
  --disable-sandbox \
  --cache-path "$CACHE/cache" \
  --config-path "$CACHE/config" \
  --security-path "$CACHE/security" \
  "$@"
