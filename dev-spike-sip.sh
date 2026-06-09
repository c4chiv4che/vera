#!/usr/bin/env bash
# dev-spike-sip.sh — Phase D / M1 spike runner.
#
# Single process: the SIP/RTP server (pjsua2) that drives a Strands
# BidiAgent against Nova Sonic. Spike-only, NOT for production.
# See docs/phase-d-m1-verdict.md for the question this is meant to settle
# and agent/app/vera/bidi/SIP_SPIKE_NOTES.md for how to use it.
#
# Commands:
#   ./dev-spike-sip.sh setup       — create spike venv, install pjsua2 + deps
#   ./dev-spike-sip.sh start       — start the SIP server in background
#   ./dev-spike-sip.sh stop        — stop the spike
#   ./dev-spike-sip.sh restart     — stop then start
#   ./dev-spike-sip.sh status      — is it running?
#   ./dev-spike-sip.sh logs        — tail -F the log
#   ./dev-spike-sip.sh foreground  — run in this terminal (Ctrl-C exits)
#   ./dev-spike-sip.sh fg          — alias for foreground
#
# Environment overrides:
#   VERA_SIP_PORT      — UDP port for SIP signaling (default 5060)
#   VERA_SIP_INDUSTRY  — default industry if URI has no ?industry= (default banking)
#   VERA_SIP_ECHO=1    — M1.2a echo loopback (no Nova Sonic)
#
# Companion: requires the BFF on :8787 alive for AGUI broadcast to reach
# the monitoring/trace views. Start it with `./dev.sh start bff`.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPIKE_DIR="$REPO_ROOT/agent/app/vera/bidi"
SPIKE_VENV="$REPO_ROOT/tmp/spike-sip-venv"
LOGS_DIR="$REPO_ROOT/tmp/logs"
PIDS_DIR="$REPO_ROOT/tmp/pids"
LOG_FILE="$LOGS_DIR/sip-spike.log"
PID_FILE="$PIDS_DIR/sip-spike.pid"

mkdir -p "$LOGS_DIR" "$PIDS_DIR"

c_reset='\033[0m'; c_red='\033[31m'; c_green='\033[32m'
c_yellow='\033[33m'; c_dim='\033[2m'
info() { printf "%b\n" "$1"; }
warn() { printf "${c_yellow}%b${c_reset}\n" "$1"; }
err()  { printf "${c_red}%b${c_reset}\n" "$1" >&2; }

setup_venv() {
  if [[ -d "$SPIKE_VENV" ]]; then
    warn "venv already exists at $SPIKE_VENV — delete it manually if you want a fresh install"
    return 0
  fi
  info "creating spike venv at $SPIKE_VENV"
  python3 -m venv "$SPIKE_VENV"
  # shellcheck disable=SC1091
  source "$SPIKE_VENV/bin/activate"
  pip install --upgrade pip wheel setuptools >/dev/null

  info "installing pjsua2 from PyPI (will fail if no wheel for this platform)..."
  if ! pip install pjsua2; then
    err "pjsua2 install failed."
    info "Fallback options (any of):"
    info "  1. Install OS deps + build from source. See SIP_SPIKE_NOTES.md."
    info "  2. apt install python3-pjsua2 then re-create the venv with --system-site-packages."
    info "  3. Switch lib (last resort — see verdict criteria for b2 path)."
    return 1
  fi

  info "installing main agent deps so sip_spike.py can import the same Strands stack..."
  pip install -e "$REPO_ROOT/agent/app/vera"

  info "${c_green}venv ready${c_reset} at $SPIKE_VENV"
}

start_bg() {
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    warn "already running (pid $(cat "$PID_FILE"))"
    return 0
  fi
  rm -f "$PID_FILE"

  if [[ ! -x "$SPIKE_VENV/bin/python" ]]; then
    err "spike venv missing — run './dev-spike-sip.sh setup' first"
    return 1
  fi

  ( cd "$SPIKE_DIR" && setsid nohup "$SPIKE_VENV/bin/python" sip_spike.py \
      >"$LOG_FILE" 2>&1 & echo $! >"$PID_FILE" )
  sleep 1.2
  local pid; pid=$(cat "$PID_FILE" 2>/dev/null || true)
  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    err "failed to start. Last 30 lines of $LOG_FILE:"
    tail -n 30 "$LOG_FILE" 2>/dev/null | sed 's/^/  /'
    rm -f "$PID_FILE"
    return 1
  fi
  info "${c_green}started${c_reset} (pid $pid, log $LOG_FILE)"
}

stop_bg() {
  if [[ ! -f "$PID_FILE" ]]; then
    info "${c_dim}not running${c_reset}"
    return 0
  fi
  local pid; pid=$(cat "$PID_FILE")
  if ! kill -0 "$pid" 2>/dev/null; then
    info "${c_dim}stale pidfile, cleaning${c_reset}"
    rm -f "$PID_FILE"
    return 0
  fi
  kill -TERM "$pid" 2>/dev/null
  local i=0
  while (( i < 25 )) && kill -0 "$pid" 2>/dev/null; do
    sleep 0.2; i=$((i + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null
    warn "SIGKILL (pid $pid did not respond to SIGTERM)"
  else
    info "${c_green}stopped${c_reset} (pid $pid)"
  fi
  rm -f "$PID_FILE"
}

status_bg() {
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    info "${c_green}running${c_reset} (pid $(cat "$PID_FILE"), log $LOG_FILE)"
  else
    info "${c_dim}stopped${c_reset}"
  fi
}

foreground() {
  if [[ ! -x "$SPIKE_VENV/bin/python" ]]; then
    err "spike venv missing — run './dev-spike-sip.sh setup' first"
    return 1
  fi
  cd "$SPIKE_DIR" || exit 1
  exec "$SPIKE_VENV/bin/python" sip_spike.py
}

usage() {
  sed -n '2,28p' "$0"
}

main() {
  local cmd=${1:-}
  case "$cmd" in
    setup)         setup_venv ;;
    start)         start_bg ;;
    stop)          stop_bg ;;
    restart)       stop_bg; start_bg ;;
    status)        status_bg ;;
    logs)          tail -F "$LOG_FILE" ;;
    foreground|fg) foreground ;;
    ""|-h|--help|help) usage ;;
    *) err "unknown command: $cmd"; usage; exit 2 ;;
  esac
}

main "$@"
