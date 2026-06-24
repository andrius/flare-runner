#!/usr/bin/env bash
# Boot the runner in just-in-time mode: register, claim exactly one job, exit.
set -euo pipefail
cd /home/runner/actions-runner
exec ./run.sh --jitconfig "${JIT_CONFIG:?JIT_CONFIG env var is required}"
