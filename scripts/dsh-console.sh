#!/usr/bin/env bash
#
# Launch the real DSH desktop app from a terminal, with its stdout attached.
#
# Why this is needed at all: the plugin's diagnostics go to plain stdout --
# `console.log('[mizar] ...')` in src/index.ts -- and the Electron shell pipes the
# host child's stdout straight through to its own stdout. That is this line in
# the shipped app (app.asar/lib/main.js, in the desktop-host supervisor):
#
#     child.stdout?.pipe(process.stdout)
#
# Double-clicked from Finder there is no stdout to pipe to, so every `[mizar]`
# line is written into nothing. Started from a terminal, the same lines land in
# that terminal. Nothing else about the app changes: same profile, same plugins,
# same `~/.dsh`, same sessions.
#
# Two consequences worth knowing before you run it:
#
#  1. The app claims a single-instance lock (`claimDesktopSingleInstance` in the
#     same file). A copy that is already running must be quit first, or the
#     second launch just focuses the existing window and exits with no output.
#     This script refuses rather than doing that silently.
#  2. The host's *stderr* is not piped anywhere -- it goes into a 64 KB ring
#     buffer in the shell process and is only surfaced when startup fails. Only
#     stdout is visible here, which is why the plugin logs on stdout.
#
# Usage:
#   scripts/dsh-console.sh [log-path]
#
# Env:
#   MIZAR_APP  override the app bundle location.
#
set -euo pipefail

APP="${MIZAR_APP:-/Applications/DeepSeek Harness.app}"
BIN="$APP/Contents/MacOS/DeepSeek Harness"
LOG="${1:-/tmp/dsh-console.log}"

if [ ! -x "$BIN" ]; then
  echo "dsh-console: no executable at \"$BIN\"" >&2
  echo "             Set MIZAR_APP to the app bundle if it is installed elsewhere." >&2
  exit 1
fi

# Detect a running instance by matching the app's own binary path as a literal
# *prefix* of the command line.
#
# `pgrep -f` is the obvious tool and it does not work here: against this app it
# returned only the `Contents/Frameworks/...` helpers and never the outer process
# or the host, so the guard silently passed and the launcher ran anyway. A
# substring `grep` is no better, because a probe whose own command line contains
# the path matches itself. A prefix test anchored at column 1 has neither
# problem: the helpers live under `Contents/Frameworks/`, this script's command
# line is `bash scripts/dsh-console.sh`, and only the real app binary and the
# host it forks begin with this exact string.
if ps -Ao command= | awk -v bin="$BIN" 'index($0, bin) == 1 { found = 1 } END { exit !found }'; then
  cat >&2 <<'EOF'
dsh-console: DeepSeek Harness is already running.

             The app holds a single-instance lock, so starting it again would
             only focus the window you already have and print nothing. Quit it
             (Cmd-Q), then run this again.
EOF
  exit 1
fi

echo "dsh-console: launching $APP"
echo "dsh-console: output is shown here and appended to $LOG"
echo "dsh-console: quit the app with Cmd-Q when you have what you need"
echo

# `tee` so the terminal stays live while the transcript is still available to
# send afterwards. `2>&1` because startup failures go to stderr before the
# supervisor's ring buffer takes over.
"$BIN" 2>&1 | tee "$LOG"
