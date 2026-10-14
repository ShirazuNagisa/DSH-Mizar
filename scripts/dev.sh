#!/usr/bin/env bash
#
# DSH-Mizar development harness.
#
# Everything it touches lives inside this checkout: DSH is run with a
# workspace-local `DSH_HOME` (`.devhome/`) so the developer's real
# `~/.dsh` — profiles, sessions, credentials — is never read or written.
#
# Usage: scripts/dev.sh <command>
#
#   bootstrap   Create .devhome and initialize the mizar-dev profile.
#   install     Build dsh-mizar and install it into the dev profile.
#   boot        Boot the dev profile in the background; stream the log.
#   stop        Stop a background boot.
#   log         Follow the current boot log.
#   dump        Print the composed tree, filtered to Mizar-related rows.
#   shell       Run an arbitrary `dsh` command against the dev home.
#
# Environment overrides:
#   MIZAR_APP      Path to the DeepSeek Harness app bundle.
#   MIZAR_WEB_PORT      Port for the DSH web app the dev profile boots (default 19388).
#   MIZAR_LISTENER_PORT Fallback for the Mizar listener port (default 19390).
#   MIZAR_PROFILE  Dev profile name (default mizar-dev).
#
# The overrides are deliberately `MIZAR_*` rather than `DSH_*`: when this script
# is run from inside a DSH session, the ambient environment already carries
# DSH_PROFILE=desktop (and DSH_HOME, DSH_SESSION_ID, …), and shadowing that
# namespace silently retargeted the script at the reserved Desktop profile.

set -euo pipefail

MIZAR_APP="${MIZAR_APP:-/Applications/DeepSeek Harness.app}"
MIZAR_WEB_PORT="${MIZAR_WEB_PORT:-19388}"
# The Mizar listener port is the plugin's own config.port; it is read back from
# the plugin's startup line rather than assumed, because the plugin probes
# upward when the configured port is busy.
MIZAR_LISTENER_PORT="${MIZAR_LISTENER_PORT:-19390}"
MIZAR_PROFILE="${MIZAR_PROFILE:-mizar-dev}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_HOME="$ROOT/.devhome"
PLUGIN_DIR="$ROOT"
LOG_FILE="$ROOT/.devstate/dev.log"
PID_FILE="$ROOT/.devstate/dev.pid"

BIN="$MIZAR_APP/Contents/MacOS/DeepSeek Harness"
CLI="$MIZAR_APP/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"

die() { printf 'dev.sh: %s\n' "$1" >&2; exit 1; }

check_app() {
  [ -x "$BIN" ] || die "not found: $BIN (set MIZAR_APP)"
  # The CLI lives inside app.asar, which is an archive rather than a directory,
  # so `test -f` cannot stat it. Check the archive that contains it instead.
  [ -f "$MIZAR_APP/Contents/Resources/app.asar" ] || die "not found: app.asar under $MIZAR_APP (set MIZAR_APP)"
}

# Run the DSH launcher against the workspace-local home.
#
# `env -u` clears the DSH session markers inherited from an enclosing session:
# leaving them set would tell the child it is a nested session, and
# DSH_PROFILE would contradict the `--profile` flag we pass explicitly.
dsh() {
  env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID -u DSH_SHELL -u DSH_WEB_URL \
    ELECTRON_RUN_AS_NODE=1 DSH_HOME="$DEV_HOME" "$BIN" --expose-internals "$CLI" "$@"
}

# Kill a process and everything it spawned.
#
# The launcher is a thin Electron parent that forks the Node-mode host as a
# child, so killing only the recorded pid leaves the host holding the port. That
# is not theoretical: a leaked host made the next boot fail with EADDRINUSE
# while the stale server answered requests, which is a very confusing failure.
kill_tree() {
  local pid="$1" child
  [ -n "$pid" ] || return 0
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

kill_tree_force() {
  local pid="$1" child
  [ -n "$pid" ] || return 0
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree_force "$child"
  done
  kill -9 "$pid" 2>/dev/null || true
}

# The pid currently listening on the dev port, if any. This is the authority on
# "is a dev server running", because a leaked host has no usable pid file.
#
# `|| true` is load-bearing: with `set -e -o pipefail`, an lsof that finds no
# listener would fail the assignment and silently kill the whole script.
port_pid() {
  local pid
  pid="$(lsof -nP -iTCP:"$MIZAR_WEB_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  printf '%s' "$pid"
}

stop_everything() {
  local pid
  if [ -f "$PID_FILE" ]; then
    kill_tree "$(cat "$PID_FILE")"
  fi
  for pid in $(pgrep -f 'dsh-desktop-host/lib/cli.js' 2>/dev/null || true); do
    kill_tree "$pid"
  done
  sleep 1
  if [ -f "$PID_FILE" ]; then
    kill_tree_force "$(cat "$PID_FILE")"
  fi
  for pid in $(pgrep -f 'dsh-desktop-host/lib/cli.js' 2>/dev/null || true); do
    kill_tree_force "$pid"
  done
  rm -f "$PID_FILE"
}

# Boot the app in the background, wait for a log line, then stop it. Used for
# one-shot initialization and for the spike run.
#
# Argument order matters: `--profile` and `--from-default-profile` are launcher
# flags and must precede the app args (`--no-open`, `--port`), because the first
# token the launcher does not recognize starts the app's own argument list.
dsh_boot_once() {
  local marker="$1" timeout="${2:-120}"
  shift 2
  mkdir -p "$(dirname "$LOG_FILE")"
  rm -f "$LOG_FILE"
  dsh --profile "$MIZAR_PROFILE" "$@" --no-open --port "$MIZAR_WEB_PORT" >"$LOG_FILE" 2>&1 &
  local pid=$!
  for _ in $(seq 1 "$timeout"); do
    grep -qE "$marker" "$LOG_FILE" 2>/dev/null && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  kill_tree "$pid"
  sleep 1
  kill_tree_force "$pid"
  wait "$pid" 2>/dev/null || true
}

cmd_bootstrap() {
  check_app
  mkdir -p "$DEV_HOME" "$ROOT/.devstate"
  if [ -d "$DEV_HOME/profiles/$MIZAR_PROFILE" ]; then
    echo "dev.sh: profile '$MIZAR_PROFILE' already exists in .devhome"
  else
    echo "dev.sh: initializing profile '$MIZAR_PROFILE' from the shipped web template"
    dsh_boot_once 'dsh web:' 180 --from-default-profile web
    [ -d "$DEV_HOME/profiles/$MIZAR_PROFILE" ] || die "profile initialization failed; see $LOG_FILE"
  fi
  echo "dev.sh: dev home ready at $DEV_HOME"
}

cmd_build() {
  [ -d "$PLUGIN_DIR/node_modules" ] || {
    echo "dev.sh: installing plugin dependencies"
    (cd "$PLUGIN_DIR" && npm_config_cache="$ROOT/.devcache/npm" \
      npm install --no-audit --no-fund)
  }
  (cd "$PLUGIN_DIR" && ./node_modules/.bin/tsc -p tsconfig.json)
  echo "dev.sh: host half built to lib/"
}

cmd_install() {
  check_app
  cmd_build
  dsh plugin --profile "$MIZAR_PROFILE" add "$PLUGIN_DIR"
  echo "dev.sh: dsh-mizar installed into '$MIZAR_PROFILE'"
}

cmd_boot() {
  check_app
  mkdir -p "$(dirname "$LOG_FILE")"
  # A leaked host on the port makes the next boot fail with EADDRINUSE *and*
  # keeps serving stale bundles, so refuse rather than produce a mystery.
  local stale
  stale="$(port_pid)"
  if [ -n "$stale" ]; then
    die "port $MIZAR_WEB_PORT is already in use by pid $stale — run 'scripts/dev.sh stop' first"
  fi
  rm -f "$LOG_FILE"
  DSH_MIZAR_SPIKE_WORKSPACE="$ROOT" \
    dsh --profile "$MIZAR_PROFILE" --no-open --port "$MIZAR_WEB_PORT" >"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" >"$PID_FILE"
  echo "dev.sh: booting '$MIZAR_PROFILE' on 127.0.0.1:$MIZAR_WEB_PORT (pid $pid)"
  for _ in $(seq 1 90); do
    grep -qE 'dsh web:|startup failed' "$LOG_FILE" 2>/dev/null && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  # The Phase 0.1 spike reports well after readiness; give it its own window so
  # `boot` shows the probe results rather than stopping at the URL line.
  if grep -q '\[mizar\] Phase 0\.1 spike starting' "$LOG_FILE" 2>/dev/null; then
    for _ in $(seq 1 120); do
      grep -qE '\[mizar\] Phase 0\.1 spike (ALL PASS|ALL FAIL|HAS FAILURES)' "$LOG_FILE" 2>/dev/null && break
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
  fi
  grep -E 'dsh web:|\[mizar\]' "$LOG_FILE" || true
  if grep -q 'startup failed' "$LOG_FILE" 2>/dev/null; then
    echo "dev.sh: BOOT FAILED — see $LOG_FILE"
    return 1
  fi
  echo "dev.sh: log at $LOG_FILE; stop with 'scripts/dev.sh stop'"
}

cmd_stop() {
  stop_everything
  echo "dev.sh: stopped"
}

# Reboot, then drive the running listener over the real wire.
#
# A reboot is required rather than convenient: pairing codes are single-use, so
# a second run against the same instance has nothing left to redeem. Rebooting
# also re-runs the whole startup path, which is what we want to exercise.
cmd_smoke() {
  # A smoke run always starts from a fresh boot, so tear down whatever is there.
  stop_everything
  cmd_boot
  local code
  for _ in $(seq 1 30); do
    grep -qE 'pairing code: ' "$LOG_FILE" 2>/dev/null && break
    sleep 1
  done
  code="$(grep -oE 'pairing code: [0-9A-Z-]+' "$LOG_FILE" | head -1 | sed 's/pairing code: //')"
  [ -n "$code" ] || die "no pairing code in the log — enable mizar's pairing.issueOnStart in the profile patch"

  # Read the authority back from the plugin rather than assuming it: the plugin
  # probes upward when its configured port is taken.
  local authority
  authority="$(grep -oE 'listening on [^,]+' "$LOG_FILE" | head -1 | sed 's/listening on //')"
  [ -n "$authority" ] || authority="127.0.0.1:$MIZAR_LISTENER_PORT"

  # The panel routes live on DSH's own webserver, behind its browser cookie, so
  # the smoke test needs both the launch token and the web port to reach them.
  local webToken
  webToken="$(grep -oE 'token=[A-Za-z0-9_-]+' "$LOG_FILE" | head -1 | cut -d= -f2)"

  echo "dev.sh: smoke testing $authority with code $code"
  MIZAR_BASE="http://$authority" \
    MIZAR_CODE="$code" \
    MIZAR_WEB_BASE="http://127.0.0.1:$MIZAR_WEB_PORT" \
    MIZAR_WEB_TOKEN="$webToken" \
    MIZAR_WRITE_FIXTURES="${MIZAR_WRITE_FIXTURES:-0}" \
    node "$ROOT/scripts/smoke-listener.mjs"
}

cmd_log() { tail -n "${1:-80}" -f "$LOG_FILE"; }

cmd_dump() {
  check_app
  dsh --profile "$MIZAR_PROFILE" --dump-config 2>&1 | grep -n -B 2 -A 8 'mizar' || true
}

cmd_shell() {
  check_app
  dsh "$@"
}

case "${1:-}" in
  bootstrap) cmd_bootstrap ;;
  build)     cmd_build ;;
  install)   cmd_install ;;
  boot)      cmd_boot ;;
  smoke)     cmd_smoke ;;
  stop)      cmd_stop ;;
  log)       shift; cmd_log "$@" ;;
  dump)      cmd_dump ;;
  shell)     shift; cmd_shell "$@" ;;
  *)
    cat >&2 <<'USAGE'
dev.sh <command>

  bootstrap   Create .devhome and initialize the mizar-dev profile.
  build       Compile the host half to lib/.
  install     Build and install dsh-mizar into the dev profile.
  boot        Boot the dev profile in the background; print startup lines.
  smoke       Reboot, then run scripts/smoke-listener.mjs against it.
  stop        Stop a background boot.
  log [n]     Follow the current boot log.
  dump        Print the composed tree, filtered to Mizar rows.
  shell ...   Run an arbitrary dsh command against the dev home.
USAGE
    exit 1
    ;;
esac
