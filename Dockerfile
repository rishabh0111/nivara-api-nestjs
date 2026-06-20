# syntax=docker/dockerfile:1

# --- Build ------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json nest-cli.json ./
COPY src ./src

RUN npm run build

# --- Runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Run unprivileged. The database role split is enforced separately, in SQL.
USER node

EXPOSE 3000

CMD ["node", "dist/main"]
