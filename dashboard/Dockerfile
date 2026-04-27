# Multi-stage build for Next.js 14 standalone output.
# Builds natively on whatever arch you build on — on the Jetson (ARM64) this
# produces an ARM64 image. node:20-alpine has multi-arch manifests.

# ---- Stage 1: deps ----------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- Stage 2: builder -------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Bake the production base path into the build (Next.js reads basePath at build).
ENV BASE_PATH=/dashboard
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ---- Stage 3: runner --------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup -S -g 1001 nodejs \
 && adduser -S -u 1001 -G nodejs nextjs

# Public assets (favicon etc.) — present even if .gitkeep-only.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Standalone output — bundles a minimal node_modules and server.js.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3001

CMD ["node", "server.js"]
