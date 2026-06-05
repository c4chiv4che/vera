#!/usr/bin/env bash
# dev.sh — start/stop/status of the four local processes a Vera demo needs.
#
# Replaces the four-terminal Phase A/B ritual: text agent (:8080), bidi
# voice server (:8081), BFF (:8787), frontend (:5173). Background mode
# with one log file per service under tmp/logs and one PID file under
# tmp/pids. Linux-only (uses lsof + ps); no tmux, no docker-compose.
#
# Status states (cross-references lsof per port with our PID file):
#   ok                — port held by our PID, process alive
#   stopped           — no PID file, port empty
#   zombie-port       — port held by a foreign PID (not started by us)
#   crashed           — PID file present, our process dead, port empty
#   orphan-listening  — port held by something, our PID file missing or dead
#
# If a process fails to start, the script prints the last 20 lines of its
# log inline. Project rule: no silent failure on user-initiated actions.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDS_DIR="$REPO_ROOT/tmp/pids"
LOGS_DIR="$REPO_ROOT/tmp/logs"
mkdir -p "$PIDS_DIR" "$LOGS_DIR"

# Service registry. Order matters for `start` (text first so /metrics is
# reachable when the BFF first talks to it; frontend last so it doesn't
# render before its dependencies bind their ports).
SERVICES=(text bidi bff frontend)
declare -A PORT=(
  [text]=8080  [bidi]=8081  [bff]=8787  [frontend]=5173
)
declare -A DIR=(
  [text]="$REPO_ROOT/agent/app/vera"
  [bidi]="$REPO_ROOT/agent/app/vera/bidi"
  [bff]="$REPO_ROOT/bff"
  [frontend]="$REPO_ROOT/frontend"
)
declare -A CMD=(
  [text]="uv run main.py"
  # Use the venv's python directly. `source ../.venv/bin/activate &&
  # python …` works but the `source` only affects the subshell, which
  # makes the resolved interpreter harder to reason about.
  [bidi]="../.venv/bin/python server.py"
  [bff]="npm start"
  [frontend]="npm run dev"
)

# --- helpers ----------------------------------------------------------------

c_reset='\033[0m'; c_dim='\033[2m'; c_red='\033[31m'; c_green='\033[32m'
c_yellow='\033[33m'; c_cyan='\033[36m'; c_bold='\033[1m'

info()  { printf "%b\n" "$1"; }
warn()  { printf "${c_yellow}%b${c_reset}\n" "$1" >&2; }
err()   { printf "${c_red}%b${c_reset}\n" "$1" >&2; }
label() { printf "${c_bold}%-9s${c_reset}" "$1"; }

pidfile_for() { echo "$PIDS_DIR/$1.pid"; }
logfile_for() { echo "$LOGS_DIR/$1.log"; }

# Echo the PID currently listening on the given port, or empty string.
# Single-result: a port can only have one listener; head -1 guards against
# IPv4+IPv6 dual-stack double-print on some lsof builds.
port_holder() {
  lsof -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1
}

pid_alive() {
  [[ -n "$1" ]] && kill -0 "$1" 2>/dev/null
}

# Block up to $1 seconds waiting for the given port to start listening.
# Polls every 200ms via lsof (cheap on Linux). Returns 0 if it became
# listening, 1 on timeout.
wait_for_port() {
  local port=$1 timeout=$2 elapsed=0
  while (( $(echo "$elapsed < $timeout" | bc -l 2>/dev/null || echo 0) )); do
    [[ -n "$(port_holder "$port")" ]] && return 0
    sleep 0.2
    elapsed=$(awk "BEGIN{print $elapsed + 0.2}")
  done
  return 1
}

# --- per-service operations -------------------------------------------------

start_one() {
  local svc=$1
  local port=${PORT[$svc]} dir=${DIR[$svc]} cmd=${CMD[$svc]}
  local pidfile log_file
  pidfile=$(pidfile_for "$svc")
  log_file=$(logfile_for "$svc")

  label "$svc"
  local existing_pid; existing_pid=$(cat "$pidfile" 2>/dev/null || true)
  if pid_alive "$existing_pid" && [[ "$(port_holder "$port")" == "$existing_pid" ]]; then
    printf "${c_dim}already running (pid %s, :%s)${c_reset}\n" "$existing_pid" "$port"
    return 0
  fi

  # Foreign holder on this port — don't touch it, but flag.
  local holder; holder=$(port_holder "$port")
  if [[ -n "$holder" && "$holder" != "$existing_pid" ]]; then
    printf "${c_yellow}port :%s held by foreign PID %s — not starting${c_reset}\n" "$port" "$holder"
    return 1
  fi

  if [[ ! -d "$dir" ]]; then
    printf "${c_red}directory missing: %s${c_reset}\n" "$dir"
    return 1
  fi

  # Launch detached. `setsid` makes the process its own session leader so
  # closing this shell doesn't SIGHUP it; nohup is added for portability.
  ( cd "$dir" && setsid nohup bash -c "$cmd" >"$log_file" 2>&1 & echo $! >"$pidfile" )

  # `setsid …` returns immediately; the PID we wrote belongs to `bash -c`
  # which spawns the real process. For start liveness all we care about is
  # the port binding, which both interpretations satisfy.
  if wait_for_port "$port" 5; then
    local actual_pid; actual_pid=$(port_holder "$port")
    # Update pidfile to the listening PID so stop/status tracks the real one.
    echo "$actual_pid" >"$pidfile"
    printf "${c_green}ok${c_reset} (pid %s, :%s)\n" "$actual_pid" "$port"
    return 0
  else
    printf "${c_red}failed to bind :%s within 5s${c_reset}\n" "$port"
    info "${c_dim}--- last 20 lines of $log_file ---${c_reset}"
    tail -n 20 "$log_file" 2>/dev/null | sed 's/^/  /'
    info "${c_dim}--- end ---${c_reset}"
    return 1
  fi
}

stop_one() {
  local svc=$1
  local port=${PORT[$svc]}
  local pidfile; pidfile=$(pidfile_for "$svc")
  label "$svc"

  local pid; pid=$(cat "$pidfile" 2>/dev/null || true)
  if [[ -z "$pid" ]]; then
    # No pidfile; check the port — maybe a session left an orphan.
    local holder; holder=$(port_holder "$port")
    if [[ -n "$holder" ]]; then
      printf "${c_yellow}no pidfile but :%s held by PID %s — not killing (use 'kill %s' manually)${c_reset}\n" "$port" "$holder" "$holder"
      return 1
    fi
    printf "${c_dim}not running${c_reset}\n"
    return 0
  fi

  if ! pid_alive "$pid"; then
    printf "${c_dim}pidfile stale (pid %s dead) — cleaning up${c_reset}\n" "$pid"
    rm -f "$pidfile"
    return 0
  fi

  kill -TERM "$pid" 2>/dev/null
  # Wait up to 3s for graceful shutdown.
  local i=0
  while (( i < 15 )) && pid_alive "$pid"; do
    sleep 0.2; i=$((i+1))
  done
  if pid_alive "$pid"; then
    kill -KILL "$pid" 2>/dev/null
    printf "${c_yellow}SIGKILL (pid %s did not respond to SIGTERM)${c_reset}\n" "$pid"
  else
    printf "${c_green}stopped${c_reset} (pid %s)\n" "$pid"
  fi
  rm -f "$pidfile"
}

status_one() {
  local svc=$1
  local port=${PORT[$svc]}
  local pidfile; pidfile=$(pidfile_for "$svc")
  local our_pid; our_pid=$(cat "$pidfile" 2>/dev/null || true)
  local port_pid; port_pid=$(port_holder "$port")
  local our_alive=0
  pid_alive "$our_pid" && our_alive=1

  label "$svc"
  printf ":%-5s  " "$port"

  if [[ -z "$port_pid" && -z "$our_pid" ]]; then
    printf "${c_dim}stopped${c_reset}\n"
  elif [[ -n "$port_pid" && "$port_pid" == "$our_pid" && $our_alive -eq 1 ]]; then
    printf "${c_green}ok${c_reset} (pid %s)\n" "$our_pid"
  elif [[ -n "$port_pid" && "$port_pid" != "$our_pid" ]]; then
    if [[ -z "$our_pid" ]] || ! pid_alive "$our_pid"; then
      printf "${c_yellow}orphan-listening${c_reset} (pid %s holds port, our pidfile %s)\n" \
        "$port_pid" "${our_pid:-missing}"
    else
      printf "${c_yellow}zombie-port${c_reset} (foreign pid %s holds :%s; ours is %s)\n" \
        "$port_pid" "$port" "$our_pid"
    fi
  elif [[ -n "$our_pid" && $our_alive -eq 0 && -z "$port_pid" ]]; then
    printf "${c_red}crashed${c_reset} (pidfile %s, process dead, port empty)\n" "$our_pid"
  else
    # Catch-all for the unexpected — keep loud per the project rule.
    printf "${c_red}unknown${c_reset} (pidfile=%s alive=%s port_holder=%s)\n" \
      "${our_pid:-none}" "$our_alive" "${port_pid:-none}"
  fi
}

# --- commands ---------------------------------------------------------------

cmd_start()   { for svc in "${@:-${SERVICES[@]}}"; do start_one  "$svc"; done; }
cmd_stop()    { for svc in "${@:-${SERVICES[@]}}"; do stop_one   "$svc"; done; }
cmd_status()  { for svc in "${@:-${SERVICES[@]}}"; do status_one "$svc"; done; }
cmd_restart() { cmd_stop "$@"; cmd_start "$@"; }

cmd_logs() {
  if [[ $# -eq 0 ]]; then
    local files=()
    for svc in "${SERVICES[@]}"; do files+=("$(logfile_for "$svc")"); done
    tail -F "${files[@]}"
  else
    local files=()
    for svc in "$@"; do files+=("$(logfile_for "$svc")"); done
    tail -F "${files[@]}"
  fi
}

usage() {
  cat <<EOF
Usage: ./dev.sh <command> [service…]

Commands:
  start [svc…]     start all four services (or the named ones)
  stop  [svc…]     stop all four (or named); cleans stale pidfiles
  restart [svc…]   stop then start
  status           one-line summary per service
  logs [svc…]      tail -F the chosen logs (all if none given)

Services: ${SERVICES[*]}
Ports:    text=${PORT[text]}, bidi=${PORT[bidi]}, bff=${PORT[bff]}, frontend=${PORT[frontend]}
Files:    pids in tmp/pids/, logs in tmp/logs/
EOF
}

# Validate any service args before dispatching so a typo doesn't silently
# fall through to "no-op for all services".
validate_args() {
  for svc in "$@"; do
    case " ${SERVICES[*]} " in
      *" $svc "*) ;;
      *) err "unknown service: $svc (valid: ${SERVICES[*]})"; exit 2 ;;
    esac
  done
}

main() {
  local cmd=${1:-}
  shift || true
  case "$cmd" in
    start)   validate_args "$@"; cmd_start "$@" ;;
    stop)    validate_args "$@"; cmd_stop "$@" ;;
    restart) validate_args "$@"; cmd_restart "$@" ;;
    status)  cmd_status ;;
    logs)    validate_args "$@"; cmd_logs "$@" ;;
    ""|-h|--help|help) usage ;;
    *) err "unknown command: $cmd"; usage; exit 2 ;;
  esac
}

main "$@"
