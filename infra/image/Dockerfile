FROM debian:bookworm-slim

ARG TARGETARCH
ARG NODE_VERSION=22.18.0
ARG BUN_VERSION=1.4.2
ARG OMP_VERSION=18.8.4
ARG OMP_MODEL_ID=placeholder-model
ARG OMP_MODEL_API=openai-completions

ENV HOME=/home/app \
    DATABASE_PATH=/data/app.db \
    PATH=/home/app/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        curl \
        fonts-noto-cjk \
        git \
        tini \
        unzip \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    target_arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$target_arch" in \
        amd64) node_arch=x64; bun_arch=x64 ;; \
        arm64) node_arch=arm64; bun_arch=aarch64 ;; \
        *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1; \
    rm /tmp/node.tar.xz; \
    curl -fsSLo /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${bun_arch}.zip"; \
    unzip -q /tmp/bun.zip -d /tmp/bun; \
    install -m 0755 /tmp/bun/bun-linux-${bun_arch}/bun /usr/local/bin/bun; \
    rm -rf /tmp/bun /tmp/bun.zip /var/lib/apt/lists/*; \
    bun --version | grep -Fx "$BUN_VERSION"; \
    node --version | grep -Fx "v${NODE_VERSION}"

RUN PI_INSTALL_DIR=/usr/local/bin \
    sh -c 'curl -fsSL "https://raw.githubusercontent.com/can1357/oh-my-pi/v${OMP_VERSION}/scripts/install.sh" | sh -s -- --binary --ref "v${OMP_VERSION}"' \
    && omp --version

RUN groupadd --gid 1000 app \
    && useradd --uid 1000 --gid app --create-home --shell /bin/bash app \
    && mkdir -p /workspace /data /opt/template /home/app/.omp/agent \
    && chown -R app:app /workspace /data /home/app

COPY --chown=app:app templates/fullstack/ /opt/template/
RUN cd /opt/template \
    && bun install --frozen-lockfile \
    && chown -R app:app /opt/template /home/app

COPY infra/image/models.yml /home/app/.omp/agent/models.yml
COPY infra/image/config.yml /home/app/.omp/agent/config.yml
RUN set -eux; \
    case "$OMP_MODEL_API" in \
        openai-completions|openai-responses) gateway_path=/v1 ;; \
        anthropic-messages) gateway_path=/anthropic ;; \
        *) echo "Unsupported OMP_MODEL_API: $OMP_MODEL_API" >&2; exit 1 ;; \
    esac; \
    sed -i "s|__OMP_MODEL_ID__|${OMP_MODEL_ID}|g; s|__OMP_MODEL_API__|${OMP_MODEL_API}|g; s|__GATEWAY_PATH__|${gateway_path}|g" \
        /home/app/.omp/agent/models.yml /home/app/.omp/agent/config.yml; \
    chown -R app:app /home/app/.omp

COPY infra/image/ma-entry /usr/local/bin/ma-entry
RUN chmod 0755 /usr/local/bin/ma-entry

WORKDIR /workspace
USER app
EXPOSE 5173
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/ma-entry"]
