# Ephemeral GitHub Actions runner for Cloudflare Containers. linux/amd64 only.
# One container = one job: the entrypoint runs the agent in JIT mode, it claims a
# single job, then the process exits and Cloudflare reclaims the instance.
FROM --platform=linux/amd64 ubuntu:22.04

ARG RUNNER_VERSION=2.335.1
ENV DEBIAN_FRONTEND=noninteractive

# Base tools + system python3 (some jobs use the runner's python3 because
# actions/setup-python has no prebuilt CPython for every runner OS). Go and Node
# are NOT baked in - setup-go / setup-node install them at job time, keeping this
# lean. Add or drop toolchains here to match your jobs.
# The agent's own native deps (libicu, etc.) come from installdependencies.sh below.
# buildah lets a job build/push a container image with no Docker daemon
# (rootless, `--isolation chroot --storage-driver vfs`). See the demo workflow.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq unzip tar sudo \
      build-essential \
      python3 python3-venv python3-pip \
      buildah \
    && rm -rf /var/lib/apt/lists/*

# The agent refuses to run as root, so create an unprivileged user.
RUN useradd -m runner
WORKDIR /home/runner/actions-runner

RUN curl -fsSL -o runner.tar.gz \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
    && tar xzf runner.tar.gz \
    && rm runner.tar.gz \
    && ./bin/installdependencies.sh \
    && chown -R runner:runner /home/runner

COPY --chmod=0755 entrypoint.sh /home/runner/entrypoint.sh

USER runner
CMD ["/home/runner/entrypoint.sh"]
