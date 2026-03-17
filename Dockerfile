FROM oven/bun:1-alpine AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY . .

# Expose port (Railway injects PORT env var)
EXPOSE 3000

ENV KEYROUTER_NO_OPEN=1

CMD ["bun", "run", "bin/keyrouter.ts"]
