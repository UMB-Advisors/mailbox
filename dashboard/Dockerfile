# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json drizzle.config.ts ./
COPY backend ./backend
COPY public ./public
RUN npx tsc -p tsconfig.json

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DASHBOARD_PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY drizzle.config.ts ./
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=10s \
  CMD wget -qO- http://localhost:3000/api/health || exit 1
CMD ["node", "dist/backend/src/index.js"]
