FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e AS runtime-base

RUN rm -f /etc/apt/sources.list.d/debian.sources && \
    printf '%s\n' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260826T000000Z/ bookworm main' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260826T000000Z/ bookworm-updates main' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20260826T000000Z/ bookworm-security main' \
      > /etc/apt/sources.list && \
    apt-get -o Acquire::Retries=3 update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium=151.0.7922.173-1~deb12u1 \
      util-linux=2.38.1-5+deb12u3 \
      openssl && \
    rm -rf /var/lib/apt/lists/*

FROM runtime-base AS build

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /workspace

COPY . .
RUN --mount=type=cache,id=global-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile
RUN pnpm --filter @global/db generate
RUN pnpm --filter @global/contracts build
RUN pnpm --filter @global/api build
RUN node scripts/verify-runtime-artifact.mjs apps/api/dist
RUN node scripts/prepare-site-renderer-runtime.mjs apps/site-renderer /tmp/site-renderer-runtime && \
    node scripts/verify-runtime-artifact.mjs /tmp/site-renderer-runtime

# Materialize two self-contained production dependency closures. The final image never
# receives the workspace root store, so test/dev workspaces cannot hitchhike into OCI.
RUN --mount=type=cache,id=global-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm --filter @global/api deploy --prod --frozen-lockfile /tmp/api-runtime-deploy && \
    pnpm --filter @global/site-renderer deploy --prod --frozen-lockfile /tmp/renderer-runtime-deploy && \
    rm -f \
      /tmp/api-runtime-deploy/node_modules/.pnpm/node_modules/@global/api \
      /tmp/renderer-runtime-deploy/node_modules/.pnpm/node_modules/@global/site-renderer && \
    for deployment in /tmp/api-runtime-deploy /tmp/renderer-runtime-deploy; do \
      set -- $(find "$deployment/node_modules/.pnpm" -type d -path '*/node_modules/@global/contracts' -print); \
      test "$#" -eq 1; \
      rm -f "$1/README.md"; \
    done && \
    node scripts/prune-runtime-dependency-tests.mjs \
      /tmp/api-runtime-deploy/node_modules \
      /tmp/renderer-runtime-deploy/node_modules

# `pnpm deploy` runs @prisma/client's default postinstall without this repository's
# schema. Copy the already generated client into the deployed API closure, requiring
# exactly one source and one target to avoid a version-glob guess.
RUN set -eu; \
    set -- $(find /workspace/node_modules/.pnpm -type d -path '*/node_modules/.prisma/client' -print); \
    test "$#" -eq 1; \
    prisma_source="$1"; \
    set -- $(find /tmp/api-runtime-deploy/node_modules/.pnpm -type d -path '*/node_modules/@prisma/client' -print); \
    test "$#" -eq 1; \
    prisma_package="$1"; \
    prisma_modules="$(dirname "$(dirname "$prisma_package")")"; \
    rm -rf "${prisma_modules}/.prisma"; \
    mkdir -p "${prisma_modules}/.prisma"; \
    cp -a "$(dirname "$prisma_source")/." "${prisma_modules}/.prisma/"

ARG BUILD_SHA
ARG BUILT_AT
RUN test -n "$BUILD_SHA" && test -n "$BUILT_AT" && \
    dpkg-query -W -f='${binary:Package}\t${Version}\t${Architecture}\n' \
      > /tmp/runtime-os-packages.tsv && \
    pnpm --filter @global/api --filter @global/site-renderer list --prod --depth Infinity --json \
      > /tmp/runtime-production-dependencies.json && \
    node scripts/generate-runtime-sbom.mjs \
      /tmp/runtime-production-dependencies.json "$BUILD_SHA" "$BUILT_AT" \
      apps/api/dist/runtime-sbom.cdx.json \
      --dpkg-inventory /tmp/runtime-os-packages.tsv \
      @global/contracts@0.0.1 && \
    node scripts/generate-runtime-artifact-manifest.mjs \
      --build-sha "$BUILD_SHA" \
      --built-at "$BUILT_AT" \
      --api apps/api/dist \
      --contracts packages/contracts/dist \
      --renderer /tmp/site-renderer-runtime \
      --sbom apps/api/dist/runtime-sbom.cdx.json \
      --source api-source=apps/api/src \
      --source contracts-source=packages/contracts/src \
      --source database-contract=packages/db/prisma \
      --source renderer-source=/tmp/site-renderer-runtime \
      --output apps/api/dist/artifact-manifest.json && \
    node scripts/verify-runtime-artifact.mjs apps/api/dist && \
    BUILD_SHA="$BUILD_SHA" BUILT_AT="$BUILT_AT" \
    pnpm exec tsx apps/api/scripts/generate-build-attestation.mts

FROM runtime-base AS runtime

ARG BUILD_SHA
ARG BUILT_AT
LABEL org.opencontainers.image.revision=$BUILD_SHA \
      org.opencontainers.image.created=$BUILT_AT
ENV NODE_ENV=production
ENV APP_ENVIRONMENT=production
ENV CHROME_PATH=/usr/bin/chromium
WORKDIR /app

RUN groupadd --gid 10001 global && \
    useradd --uid 10001 --gid global --system --create-home --home-dir /home/global global

COPY --from=build --chown=global:global /tmp/api-runtime-deploy/node_modules ./apps/api/node_modules
COPY --from=build --chown=global:global /tmp/renderer-runtime-deploy/node_modules ./apps/site-renderer/node_modules
COPY --from=build --chown=global:global /workspace/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=global:global /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=global:global /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=global:global /workspace/apps/api/dist ./apps/api/dist
COPY --from=build --chown=global:global /tmp/site-renderer-runtime ./apps/site-renderer
COPY --from=build --chown=global:global /workspace/package.json ./package.json
COPY --chown=global:global runtime-entrypoint.mjs ./runtime-entrypoint.mjs
COPY --chown=global:global scripts/verify-runtime-image.mjs ./runtime-image-verifier.mjs

RUN node /app/runtime-image-verifier.mjs /app && \
    openssl version && \
    prlimit --version && \
    chromium --version

USER global
EXPOSE 3000
ENTRYPOINT ["node", "/app/runtime-entrypoint.mjs"]
CMD ["api"]
