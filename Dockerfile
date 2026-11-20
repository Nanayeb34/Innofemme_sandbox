# One container runs every team world. SQLite files live in /data (mount a persistent disk there).
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-slim
WORKDIR /app
# One server for every team: addresses teams type in (plug-in APIs, USSD applications, callbacks) must be out on
# the internet, never this machine or its private network.
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 SANDBOX_DATA_DIR=/data SANDBOX_PRIVATE_ADDRESSES=block
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
