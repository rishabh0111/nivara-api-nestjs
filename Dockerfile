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
# The generated client is copied from the build stage below, so the
# `postinstall` generate has nothing to do here — and the Prisma CLI it needs is
# a dev dependency that deliberately does not exist in this image. Nothing in
# this image migrates: the release step runs in CI, from a checkout of the same
# commit, so the migrations and the CLI have no reason to ship to production.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The generated Prisma client lives under `src/`, so it is already compiled
# into `dist/` — one artifact, no second copy to keep in step.
COPY --from=build /app/dist ./dist

# Run unprivileged. The database role split is enforced separately, in SQL.
USER node

EXPOSE 3000

# The owner credential is removed from the environment before the application
# process begins, so `node` is `exec`d with an environment that never contained
# it and no code path, child process, or crash dump can reach a credential that
# bypasses row-level security.
#
# Belt and braces rather than the primary mechanism, and worth being clear about
# which it is. What actually keeps the credential out is that the release step
# runs in CI and the deployed service is never given one — this line is what
# holds if somebody adds it to the dashboard, and the production check in
# `env.schema.ts` is what holds if somebody changes this line. Each of the three
# is cheap; the failure they guard against is silent and total.
CMD ["sh", "-c", "exec env -u MIGRATE_DATABASE_URL node dist/main"]
