FROM oven/bun:1.3-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
EXPOSE 3000
CMD ["sh", "-c", "bun run migration:up && bun src/main.ts"]
