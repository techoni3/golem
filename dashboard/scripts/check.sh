#!/usr/bin/env bash
# Quick end-to-end smoke check against a running dashboard.
# Usage:
#   scripts/check.sh                 # against http://127.0.0.1:7420
#   PORT=5000 scripts/check.sh       # against http://127.0.0.1:5000

set -u

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-7420}"
BASE="http://${HOST}:${PORT}"

red() { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
dim() { printf "\033[2m%s\033[0m\n" "$*"; }

fail=0
check() {
  local label="$1" url="$2"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}${url}" || echo "000")
  if [[ "$code" == "200" ]]; then
    green "  ✓ ${label}  ${url} → 200"
  else
    red "  ✗ ${label}  ${url} → ${code}"
    fail=$((fail + 1))
  fi
}

echo "Dashboard smoke check → ${BASE}"
check "health endpoint    " "/api/health"
check "snapshot endpoint  " "/api/snapshot"
check "projects endpoint  " "/api/projects"
check "workspaces endpoint" "/api/workspaces"
check "orchestrator       " "/api/orchestrator"
check "meta endpoint      " "/api/meta"
check "static index       " "/"
check "styles.css         " "/styles.css"
check "store.js           " "/src/store.js"
check "app.jsx            " "/src/app.jsx"
check "orchestrator.jsx   " "/src/orchestrator.jsx"

dim ""
dim "Project summary:"
curl -sf "${BASE}/api/projects" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if not data:
        print('  (no projects discovered — set GOLEM_PROJECTS_ROOT or bootstrap one)')
    for p in data:
        print(f\"  • {p['id']:24s} agents={p['live_agents']}/{p['total_agents']:<3} tickets={p['total_tickets']:<3} progress={int(p['progress']*100):>3d}%\")
except Exception as e:
    print(f'  (could not parse projects response: {e})')
" 2>/dev/null

if [[ $fail -gt 0 ]]; then
  echo
  red "$fail check(s) failed"
  exit 1
fi
echo
green "all checks passed"
