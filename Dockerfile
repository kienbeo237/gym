# syntax=docker/dockerfile:1.7
#
# Một Dockerfile, ba image (chọn bằng --target):
#
#   api    NestJS, chỉ dependency production (pnpm deploy)
#   web    Next.js standalone
#   tools  chạy migration / seed: `tsx db/migrate.ts up`
#
# Build từ GỐC repo: cả ba cùng cần lockfile và gói workspace @pt/contracts.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo

# ---- dependency: chỉ chép manifest để layer này cache được tới khi lockfile đổi
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile

# ---- build
FROM deps AS build
COPY . .
# Nhúng vào bundle trình duyệt LÚC BUILD. Tương đối để cùng một image chạy
# được dưới bất kỳ tên miền nào: nginx chuyển /api/* sang API.
ARG NEXT_PUBLIC_API_URL=/api
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @pt/api deploy --prod /out/api

# ---- tools: migration + seed (cần tsx, pg, dotenv ở gốc workspace)
FROM deps AS tools
COPY db ./db
CMD ["./node_modules/.bin/tsx", "db/migrate.ts", "up"]

# ---- api
FROM node:22-alpine AS api
ENV NODE_ENV=production TZ=Asia/Ho_Chi_Minh
RUN apk add --no-cache tzdata
WORKDIR /app
COPY --from=build --chown=node:node /out/api/package.json ./
COPY --from=build --chown=node:node /out/api/node_modules ./node_modules
COPY --from=build --chown=node:node /out/api/dist ./dist
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/api/health | grep -q '"status":"ok"' || exit 1
CMD ["node", "dist/main.js"]

# ---- web
FROM node:22-alpine AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1 TZ=Asia/Ho_Chi_Minh
RUN apk add --no-cache tzdata
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:3000/login || exit 1
CMD ["node", "apps/web/server.js"]
