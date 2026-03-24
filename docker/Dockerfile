# ClawGuard — Multi-stage Docker build
# Stage 1: Build TypeScript
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --prefer-offline

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ──────────────────────────────────────────────────────────────────
# Stage 2: Production image
FROM node:20-alpine AS runner

LABEL org.opencontainers.image.title="ClawGuard"
LABEL org.opencontainers.image.description="Staging layer & budget control for OpenClaw agents"
LABEL org.opencontainers.image.version="0.1.0"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Install only production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --prefer-offline && npm cache clean --force

# Copy compiled output and web assets
COPY --from=builder /app/dist ./dist
COPY web/ ./web/
COPY config.example.json5 ./

# Create necessary directories
RUN mkdir -p /root/.clawguard /tmp/clawguard/staging

# Default environment variables
ENV NODE_ENV=production \
    CLAWGUARD_CONFIG=/app/config.json5

EXPOSE 3847

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3847/api/status || exit 1

# Run the application
CMD ["node", "dist/index.js"]
