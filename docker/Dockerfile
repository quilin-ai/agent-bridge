# Multi-machine simulation image (§13). Zero runtime deps — Bun runs the TS
# directly and the broker/client only import src/backbone + Bun built-ins.
FROM oven/bun:1.3.11
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
COPY docker ./docker
