#!/usr/bin/env bash
# Run the Python unit tests with the same interpreter major the loader bundles (3.14) via uv.
set -euo pipefail
cd "$(dirname "$0")/.."
exec uv run -q --python 3.14 --with aiohttp --with pytest python -I -m pytest -q tests "$@"
