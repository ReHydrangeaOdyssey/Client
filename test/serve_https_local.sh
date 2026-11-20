#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Prefer an installed Python 3 over the Windows Store python3 alias in Git Bash.
if command -v python >/dev/null 2>&1 && python -c 'import sys; sys.exit(sys.version_info.major != 3)' >/dev/null 2>&1; then
    python_command=python
else
    python_command=python3
fi
exec "$python_command" "$script_dir/../tools/serve_https.py" --mode local "$@"
