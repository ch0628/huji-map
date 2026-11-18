# HujiMap Production Container for Google Cloud Run (Next.js standalone)

# 1. Dependencies stage
FROM node:24-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# 2. Builder stage
FROM node:24-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Ensure public directory exists even when repository has no static files in public/
RUN mkdir -p public

# Build-time PUBLIC client environment variables ONLY.
# NEVER pass server secrets (SUPABASE_SECRET_KEY, TOSS_TEST_SECRET_KEY, PIN_ENCRYPTION_KEY_BASE64) here.
ARG NEXT_PUBLIC_APP_URL=""
ARG NEXT_PUBLIC_SUPABASE_URL=""
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=""
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=""
ARG NEXT_PUBLIC_KAKAO_MAP_JS_KEY=""
ARG NEXT_PUBLIC_TOSS_TEST_CLIENT_KEY=""
ARG NEXT_PUBLIC_ANALYTICS_ENABLED="false"

ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_KAKAO_MAP_JS_KEY=$NEXT_PUBLIC_KAKAO_MAP_JS_KEY
ENV NEXT_PUBLIC_TOSS_TEST_CLIENT_KEY=$NEXT_PUBLIC_TOSS_TEST_CLIENT_KEY
ENV NEXT_PUBLIC_ANALYTICS_ENABLED=$NEXT_PUBLIC_ANALYTICS_ENABLED

RUN npm run build

# 3. Production runner stage (minimal files only)
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 8080

CMD ["node", "server.js"]
