# syntax=docker/dockerfile:1

# --- Build ------------------------------------------------------------------
# Also the image the compose `migrate` step runs: it keeps the dev dependencies,
# so the Prisma CLI and the TypeScript seed are available there and absent from
# the runtime image.
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
# `--ignore-scripts` because the `postinstall` generate needs the schema, which
# is copied on the next line — generation happens explicitly below instead.
RUN npm ci --ignore-scripts

# `tsconfig.build.json` belongs here as much as the other three: `nest build`
# reads it, and without it the CLI falls back to the root config — which
# includes `prisma/**/*.ts`, widening the inferred root from `src` to the
# repository root and emitting `dist/src/main.js` instead of `dist/main.js`.
# The build succeeds either way; only the entrypoint below stops resolving.
COPY prisma.config.ts tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma

# The generated client is a build artifact, not source — it is gitignored and
# produced here from the schema.
RUN npx prisma generate

COPY src ./src

RUN npm run build

# --- Runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
# `--ignore-scripts` because the generated client is copied from the build stage
# below, so this image's own `postinstall` generate has nothing to do here.
#
# The rebuild that follows is narrow and load-bearing: skipping scripts also
# skips the step that downloads Prisma's schema engine, and the CLI would then
# try to fetch it on first use — as an unprivileged user, into a root-owned
# directory, during the release step of a deploy. Fetching it now makes the
# image self-contained: the release step needs no network but the database's.
RUN npm ci --omit=dev --ignore-scripts \
  && npm rebuild @prisma/engines \
  && npm cache clean --force

# The generated Prisma client lives under `src/`, so it is already compiled
# into `dist/` — one artifact, no second copy to keep in step.
COPY --from=build /app/dist ./dist

# The migration schedule, and the config that points the CLI at the owner
# credential. They are here because *this* image runs the release step: the
# platform's pre-deploy hook runs a command inside the service's own image, so
# an image that cannot migrate would need a second image built from the same
# commit — and "the artifact that was tested is the artifact that migrated"
# would stop being true. That is also why `prisma` is a runtime dependency
# rather than a dev one.
#
# Nothing here is read by the running application: `prisma.config.ts` names
# MIGRATE_DATABASE_URL, which the entrypoint below strips before the process
# starts. The files are inert once the release step has exited.
COPY prisma.config.ts ./
COPY prisma ./prisma

# Run unprivileged. The database role split is enforced separately, in SQL.
USER node

EXPOSE 3000

# The owner credential is removed from the environment before the application
# process begins, and this is the mechanism that makes "absent from the running
# process" true rather than merely intended.
#
# It has to be done here because the release step and the web process share one
# environment on every platform that runs pre-deploy hooks in the service's own
# container — supply MIGRATE_DATABASE_URL to the service and the long-running
# process inherits it too. Stripping it in the entrypoint means `node` is
# `exec`d with an environment that never contained it, so no code path, child
# process, or crash dump in the application can reach a credential that bypasses
# row-level security. The production check in `env.schema.ts` is the second belt:
# it refuses to boot if this one is ever bypassed.
CMD ["sh", "-c", "exec env -u MIGRATE_DATABASE_URL node dist/main"]
