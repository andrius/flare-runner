# Ephemeral GitHub Actions runner for Cloudflare Containers. linux/amd64 only.
# One container = one job: the entrypoint runs the agent in JIT mode, it claims a
# single job, then the process exits and Cloudflare reclaims the instance.
FROM --platform=linux/amd64 ubuntu:24.04

ARG RUNNER_VERSION=2.335.1
ENV DEBIAN_FRONTEND=noninteractive

# UTF-8 locale so Unicode-aware tooling behaves the same as on GitHub-hosted
# runners. Without it the C locale makes `grep -P \p{L}`, ripgrep, perl, etc.
# treat non-ASCII letters as non-letters, which silently breaks regexes over
# accented / non-Latin source and content. C.UTF-8 needs no locale package.
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

# Base tools + system python3 (some jobs use the runner's python3 because
# actions/setup-python has no prebuilt CPython for every runner OS). Go and Node
# are NOT baked in - setup-go / setup-node install them at job time, keeping this
# lean. Add or drop toolchains here to match your jobs.
# The agent's own native deps (libicu, etc.) come from installdependencies.sh below.
# buildah builds/pushes a container image with no Docker daemon (rootless,
# `--isolation chroot --storage-driver vfs`). Ubuntu 24.04 ships buildah >=1.33,
# which supports `--layers --cache-from/--cache-to <registry>` so image layers
# can be cached across these ephemeral runs (see the build-cache demo workflow).
# skopeo copies/retags images between registries without a daemon (cheap promote).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq unzip tar sudo \
      build-essential \
      python3 python3-venv python3-pip \
      buildah skopeo \
    && rm -rf /var/lib/apt/lists/*

# buildah resolves short image names (e.g. "alpine:3", "node:22") to Docker Hub,
# the way `docker build` does. Without this, `FROM alpine` fails with
# "short-name did not resolve to an alias and no unqualified-search registries".
RUN mkdir -p /etc/containers \
    && printf 'unqualified-search-registries = ["docker.io"]\n' > /etc/containers/registries.conf

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
