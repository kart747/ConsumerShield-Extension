#!/usr/bin/env bash
# Runs the automated checks. From the repo root:
#   pip install -r backend/requirements.txt -r tests/requirements.txt
#   playwright install chromium
#   bash tests/run_test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# End-to-end: starts its own backend and test page, loads the real extension.
python tests/test_extension_e2e.py
