# Production images of the Confera API (M4-BE-07; ADR-24, ADR-26, ADR-27).
#
#   docker build --target runtime -t confera-be .     the API and the worker: one image, two services
#   docker build --target jobs    -t confera-be-jobs .  the one-shot jobs: migrate, provision, seed
#
# - Every stage starts from the same base image, referenced by digest (ADR-01; `pnpm supply-chain`
#   checks every FROM line, so a stage never starts FROM another stage's name).
# - The runtime image holds the production build (dist/, which has no dev-tools module), the
#   production dependencies and nothing else: no source, no tests, no scripts, no development
#   dependency, no package manager (ST-02; deploy/checks/images.mjs proves it).
# - It runs as the user `node` (uid 1000), never as root, and works on a read-only root file
#   system: it writes only to the file volume and to /tmp, both mounted by deploy/compose.yml (ST-53).
# - Secrets are files under /run/secrets, never build arguments, never ENV lines (ADR-26).
#   deploy/image/entrypoint.sh reads the ones a service is given.

# ---------------------------------------------------------------------------------------------
# build: the full installation, the Prisma client, the production build
# ---------------------------------------------------------------------------------------------
# Node.js 22.23.3 on Debian 12 (bookworm), slim. The digest is the multi-platform index.
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/opt/corepack
# Prisma reads the OpenSSL version to choose the schema engine that `prisma migrate` runs.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts ./
COPY prisma/schema.prisma prisma/schema.prisma
# pnpm 11.28.2 comes from corepack, checked against the hash in package.json.
RUN corepack pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY scripts/build.mjs scripts/build.mjs
COPY scripts/lib/process.mjs scripts/lib/process.mjs
COPY src src
RUN corepack pnpm build

# ---------------------------------------------------------------------------------------------
# production-dependencies: what the running API needs from node_modules, and nothing else
# ---------------------------------------------------------------------------------------------
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS production-dependencies
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/opt/corepack
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# No install script runs: the only ones are Prisma's (the command line, a development
# dependency) and the client is already generated into dist/ by the build stage.
RUN corepack pnpm install --frozen-lockfile --prod --ignore-scripts

# ---------------------------------------------------------------------------------------------
# jobs: the one-shot jobs of a server (migrate, provision, the production seed, the first admin)
# ---------------------------------------------------------------------------------------------
# It needs the Prisma command line, a development dependency, so it carries the full
# installation. It never serves a request, is on the database network only, and runs only
# when the deploy script or the operator starts it. It holds no source, no build, no test,
# and no test tool of scripts/ (seed:e2e and the stubs are not copied).
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS jobs
ARG CONFERA_REVISION=unknown
LABEL org.opencontainers.image.title="confera-be-jobs" \
      org.opencontainers.image.description="Confera one-shot jobs: migrate, provision, production seed" \
      org.opencontainers.image.source="https://github.com/stojanivanisevic/confera_be" \
      org.opencontainers.image.revision="${CONFERA_REVISION}" \
      org.opencontainers.image.licenses="UNLICENSED"
ENV NODE_ENV=production \
    HOME=/tmp
RUN apt-get update \
 && apt-get install --yes --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
COPY --from=build --chown=root:root /build/node_modules ./node_modules
COPY --chown=root:root package.json prisma.config.ts ./
COPY --chown=root:root prisma prisma
COPY --chown=root:root scripts/db-provision.mjs scripts/seed-production.mjs scripts/first-admin.mjs scripts/
COPY --chown=root:root scripts/lib/process.mjs scripts/lib/stack.mjs scripts/lib/seed-data.mjs scripts/lib/stage.mjs scripts/lib/mail-address.mjs scripts/lib/scram.mjs scripts/lib/
COPY --chown=root:root --chmod=0555 deploy/image/entrypoint.sh /usr/local/bin/confera-entrypoint
USER node
ENTRYPOINT ["/usr/local/bin/confera-entrypoint"]
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

# ---------------------------------------------------------------------------------------------
# runtime: the API and the worker (the last stage, so the default target)
# ---------------------------------------------------------------------------------------------
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
ARG CONFERA_REVISION=unknown
LABEL org.opencontainers.image.title="confera-be" \
      org.opencontainers.image.description="Confera API and worker (UdEkoM Balkans)" \
      org.opencontainers.image.source="https://github.com/stojanivanisevic/confera_be" \
      org.opencontainers.image.revision="${CONFERA_REVISION}" \
      org.opencontainers.image.licenses="UNLICENSED"
ENV NODE_ENV=production
# The package managers of the base image are development tools: the runtime image has none.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && install -d -o node -g node -m 0700 /var/lib/confera/files
WORKDIR /app
COPY --from=production-dependencies --chown=root:root /build/node_modules ./node_modules
COPY --from=build --chown=root:root /build/dist ./dist
COPY --chown=root:root package.json ./
COPY --chown=root:root --chmod=0555 deploy/image/entrypoint.sh /usr/local/bin/confera-entrypoint
USER node
EXPOSE 3001
ENTRYPOINT ["/usr/local/bin/confera-entrypoint"]
CMD ["node", "dist/main.js"]
