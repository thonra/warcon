FROM docker.io/oven/bun:1.4.4-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY bot/src ./bot/src
RUN mkdir -p /app/data && chown -R bun:bun /app
USER bun
ENV QQ_BOT_HOST=0.0.0.0 QQ_BOT_DB=/app/data/qq-bot.sqlite QQ_BOT_GROUPS=/app/config/groups.json
EXPOSE 3100
CMD ["bun", "bot/src/main.ts"]
