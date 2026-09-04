# =============================================================================
# STAGE 1: Dependencies - Install and cache workspace dependencies
# =============================================================================
FROM oven/bun:1.2.8 AS deps

WORKDIR /app

# Copy workspace configuration
COPY package.json bun.lock ./

# Copy package.json files for all packages (exclude local db; use published @trycompai/db)
COPY packages/kv/package.json ./packages/kv/
COPY packages/ui/package.json ./packages/ui/
COPY packages/email/package.json ./packages/email/
COPY packages/integration-platform/package.json ./packages/integration-platform/
COPY packages/integrations/package.json ./packages/integrations/
COPY packages/utils/package.json ./packages/utils/
COPY packages/tsconfig/package.json ./packages/tsconfig/
COPY packages/analytics/package.json ./packages/analytics/

# Copy app package.json files
COPY apps/app/package.json ./apps/app/
COPY apps/portal/package.json ./apps/portal/

# Install all dependencies
RUN PRISMA_SKIP_POSTINSTALL_GENERATE=true bun install --ignore-scripts

# =============================================================================
# STAGE 2: Migrator/Seeder — built from the workspace's own packages/db (Prisma 7.6.0)
# =============================================================================
# Operative: previously installed a synthetic package.json pinned to Prisma 6 and the stale
# published @trycompai/db@1.x, and ran `seed.js` — but this repo is on Prisma 7.6.0 /
# @trycompai/db 2.3.0 and the current seed is TypeScript (prisma/seed/seed.ts), which imports
# @prisma/adapter-pg (and transitively pg) and a local sibling module
# (./frameworkEditorSchemas). None of that resolved from the old image, so the seeder could
# never run. Rebuilt to install the workspace's actual packages/db package (workspace-filtered,
# so this stays minimal — packages/db itself has no workspace:* dependencies on any other
# package in this monorepo, only @prisma/adapter-pg, @prisma/client, dotenv and zod) and use its
# own prisma.config.ts, instead of faking the published-package layout.
FROM oven/bun:1.2.8 AS migrator

WORKDIR /app

# Root workspace files — required for `bun install --filter` to resolve the workspace graph,
# even though only packages/db is actually copied in below (bun matches the `workspaces` globs
# in package.json against what's on disk; globs that match nothing, e.g. apps/* here, are fine).
COPY package.json bun.lock bunfig.toml ./

# The db package itself: schema + migrations + seed data/script (prisma/), its own build/codegen
# scripts (scripts/), the Prisma config the CLI auto-discovers (prisma.config.ts), src/ (needed:
# prisma/seed/seed.ts dynamically imports src/scripts/backfill-framework-versions.ts) and
# tsconfig.json.
COPY packages/db/package.json ./packages/db/
COPY packages/db/prisma ./packages/db/prisma
COPY packages/db/prisma.config.ts ./packages/db/
COPY packages/db/scripts ./packages/db/scripts
COPY packages/db/src ./packages/db/src
COPY packages/db/tsconfig.json ./packages/db/

# Workspace-filtered install: only @trycompai/db's own dependencies (prisma, @prisma/client,
# @prisma/adapter-pg — which brings in pg transitively — zod, dotenv). Its own "postinstall"
# script (scripts/generate-prisma-client-js.js) generates the Prisma client automatically, but
# tolerates failure (`|| true`) — don't rely on that alone; see the explicit RUN below.
RUN bun install --filter @trycompai/db

# Fail the build loudly if client generation didn't happen, instead of silently shipping an
# image where `@prisma/client` can't be imported (which is exactly the old bug this replaces).
RUN cd packages/db && node scripts/generate-prisma-client-js.js

# prisma.config.ts (schema: "prisma/schema", migrations.path: "prisma/migrations",
# migrations.seed: "bun prisma/seed/seed.ts") is auto-discovered by the Prisma CLI when run from
# packages/db — no --schema flag and no dist/ combine step needed; that step
# (scripts/combine-schemas.js) exists only to mimic the *published* @trycompai/db package layout
# for external consumers (see the app-builder stage above), which this image doesn't need: it
# imports @prisma/client and @prisma/adapter-pg directly, the same way prisma/seed/seed.ts does.
WORKDIR /app/packages/db

# Default command runs migrations. The seeder runs from this same image by overriding the
# command at deploy time, e.g.: `docker run <this-image> bun prisma/seed/seed.ts` (relative to
# this WORKDIR, matching the package's own "db:seed" script).
CMD ["bunx", "prisma", "migrate", "deploy"]

# =============================================================================
# STAGE 3: App Builder
# =============================================================================
FROM deps AS app-builder

WORKDIR /app

# Copy all source code needed for build
COPY packages ./packages
COPY apps/app ./apps/app

# Bring in node_modules for build and prisma prebuild
COPY --from=deps /app/node_modules ./node_modules

# Pre-combine schemas and generate the Prisma client into
# node_modules/@prisma/client. The deps stage ran `bun install` with
# `--ignore-scripts` so packages/db's postinstall was skipped; we run
# it explicitly here so `next build` can resolve the generated runtime
# + types when it imports @prisma/client.
RUN cd packages/db && node scripts/combine-schemas.js \
                   && node scripts/generate-prisma-client-js.js

# Ensure Next build has required public env at build-time
ARG NEXT_PUBLIC_BETTER_AUTH_URL
ARG NEXT_PUBLIC_PORTAL_URL
ARG NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_POSTHOG_HOST
ARG NEXT_PUBLIC_IS_DUB_ENABLED
ARG NEXT_PUBLIC_API_URL
# Operative: self-host build-time config (paywall bypass, env label, absolute links, error/notification wiring)
ARG NEXT_PUBLIC_SELF_HOSTED
ARG NEXT_PUBLIC_APP_ENV
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_SENTRY_DISABLED
ARG NEXT_PUBLIC_NOVU_APPLICATION_IDENTIFIER
ENV NEXT_PUBLIC_BETTER_AUTH_URL=$NEXT_PUBLIC_BETTER_AUTH_URL \
    NEXT_PUBLIC_PORTAL_URL=$NEXT_PUBLIC_PORTAL_URL \
    NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY \
    NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST \
    NEXT_PUBLIC_IS_DUB_ENABLED=$NEXT_PUBLIC_IS_DUB_ENABLED \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_SELF_HOSTED=$NEXT_PUBLIC_SELF_HOSTED \
    NEXT_PUBLIC_APP_ENV=$NEXT_PUBLIC_APP_ENV \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_SENTRY_DISABLED=$NEXT_PUBLIC_SENTRY_DISABLED \
    NEXT_PUBLIC_NOVU_APPLICATION_IDENTIFIER=$NEXT_PUBLIC_NOVU_APPLICATION_IDENTIFIER \
    NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production \
    NEXT_OUTPUT_STANDALONE=true \
    NODE_OPTIONS=--max_old_space_size=6144

# Build the app
RUN cd apps/app && SKIP_ENV_VALIDATION=true bun run build:docker

# =============================================================================
# STAGE 4: App Production
# =============================================================================
FROM node:22-alpine AS app

WORKDIR /app

# Copy Next standalone output
COPY --from=app-builder /app/apps/app/.next/standalone ./
COPY --from=app-builder /app/apps/app/.next/static ./apps/app/.next/static
COPY --from=app-builder /app/apps/app/public ./apps/app/public

EXPOSE 3000
CMD ["node", "apps/app/server.js"]

# =============================================================================
# STAGE 5: Portal Builder
# =============================================================================
FROM deps AS portal-builder

WORKDIR /app

# Copy all source code needed for build
COPY packages ./packages
COPY apps/portal ./apps/portal

# Bring in node_modules for build and prisma prebuild
COPY --from=deps /app/node_modules ./node_modules

# Pre-combine schemas for portal build
RUN cd packages/db && node scripts/combine-schemas.js
RUN cp packages/db/dist/schema.prisma apps/portal/prisma/schema.prisma

# Ensure Next build has required public env at build-time
ARG NEXT_PUBLIC_BETTER_AUTH_URL
ENV NEXT_PUBLIC_BETTER_AUTH_URL=$NEXT_PUBLIC_BETTER_AUTH_URL \
    NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production \
    NEXT_OUTPUT_STANDALONE=true \
    NODE_OPTIONS=--max_old_space_size=6144

# Build the portal
RUN cd apps/portal && SKIP_ENV_VALIDATION=true bun run build:docker

# =============================================================================
# STAGE 6: Portal Production
# =============================================================================
FROM node:22-alpine AS portal

WORKDIR /app

# Copy Next standalone output for portal
COPY --from=portal-builder /app/apps/portal/.next/standalone ./
COPY --from=portal-builder /app/apps/portal/.next/static ./apps/portal/.next/static
COPY --from=portal-builder /app/apps/portal/public ./apps/portal/public

EXPOSE 3000
CMD ["node", "apps/portal/server.js"]

# (Trigger.dev hosted; no local runner stage)
