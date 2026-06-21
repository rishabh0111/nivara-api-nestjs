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

COPY prisma.config.ts tsconfig.json nest-cli.json ./
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
# The generated client is copied from the build stage, so the `postinstall`
# generate has nothing to do here — and the Prisma CLI it needs is a dev
# dependency that deliberately does not exist in this image.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The generated Prisma client lives under `src/`, so it is already compiled
# into `dist/` — one artifact, no second copy to keep in step.
COPY --from=build /app/dist ./dist

# Run unprivileged. The database role split is enforced separately, in SQL.
USER node

EXPOSE 3000

CMD ["node", "dist/main"]
