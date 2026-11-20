#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Set this machine's LAN IPv4 address and allowed subnet after :- once.
# Environment variables take priority over the values configured here.
lan_host="${REORSG_LAN_HOST:-}"
lan_network="${REORSG_LAN_NETWORK:-}"

if [ -z "$lan_host" ]; then
    printf 'Development PC LAN IPv4 address: '
    IFS= read -r lan_host || exit 1
fi
if [ -z "$lan_network" ]; then
    printf 'Allowed LAN subnet (CIDR): '
    IFS= read -r lan_network || exit 1
fi
if [ -z "$lan_host" ] || [ -z "$lan_network" ]; then
    printf '%s\n' 'LAN IPv4 address and subnet are required.' >&2
    exit 1
fi
# Prefer an installed Python 3 over the Windows Store python3 alias in Git Bash.
if command -v python >/dev/null 2>&1 && python -c 'import sys; sys.exit(sys.version_info.major != 3)' >/dev/null 2>&1; then
    python_command=python
else
    python_command=python3
fi
exec "$python_command" "$script_dir/../tools/serve_https.py" --mode lan --host "$lan_host" --lan-network "$lan_network" "$@"
