FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV SOURCE_WORKSPACE_DIR=/data/source-workspaces
ENV LOG_FILE=/data/logs/agent-turns.jsonl

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/agent-service/package.json apps/agent-service/package.json
COPY packages/agent-runtime/package.json packages/agent-runtime/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --prod --frozen-lockfile

COPY apps/agent-service apps/agent-service
COPY packages/agent-runtime packages/agent-runtime
COPY packages/contracts packages/contracts

RUN mkdir -p /data/source-workspaces /data/logs

EXPOSE 8787

CMD ["pnpm", "--filter", "@ui-agent/agent-service", "start"]
