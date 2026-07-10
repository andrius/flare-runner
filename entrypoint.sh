#!/usr/bin/env bash
# Boot the runner in just-in-time mode: register, claim exactly one job, exit.
#
# Why this is not a bare `exec ./run.sh`: Cloudflare stops a container by sending
# SIGTERM to PID 1 and never escalates to SIGKILL. Under `exec` the shell is
# replaced by run.sh, which is itself bash - and bash neither forwards SIGTERM to
# its foreground child nor runs a trap until that child exits. A JIT runner that
# GitHub never assigned a job to long-polls forever, so the signal landed on a
# process that would not act on it and the container billed memory indefinitely.
#
# So: run the agent in the background, forward the signal ourselves, and escalate
# to SIGKILL if it does not leave within TERM_GRACE_SECONDS.
set -euo pipefail
cd /home/runner/actions-runner

: "${JIT_CONFIG:?JIT_CONFIG env var is required}"
TERM_GRACE_SECONDS="${TERM_GRACE_SECONDS:-30}"

./run.sh --jitconfig "$JIT_CONFIG" &
runner_pid=$!

terminate() {
  kill -TERM "$runner_pid" 2>/dev/null || true
  for _ in $(seq "$TERM_GRACE_SECONDS"); do
    kill -0 "$runner_pid" 2>/dev/null || return 0
    sleep 1
  done
  kill -KILL "$runner_pid" 2>/dev/null || true
}
trap terminate TERM INT

# `wait` reports the child's exit status, or 128+signo if a trapped signal
# interrupted it. Either way the trap above has already reaped the child.
set +e
wait "$runner_pid"
status=$?
set -e
exit "$status"
