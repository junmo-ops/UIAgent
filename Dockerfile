FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV HOST=0.0.0.0
ENV PORT=8787
ENV SOURCE_WORKSPACE_DIR=/data/source-workspaces
ENV LOG_FILE=/data/logs/agent-turns.jsonl

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/agent-service/package.json apps/agent-service/package.json
COPY packages/agent-runtime/package.json packages/agent-runtime/package.json
COPY packages/ui-change-agent/package.json packages/ui-change-agent/package.json
COPY packages/ui-change-contracts/package.json packages/ui-change-contracts/package.json
COPY packages/ui-change-domain/package.json packages/ui-change-domain/package.json
RUN pnpm install --frozen-lockfile

COPY apps/agent-service apps/agent-service
COPY packages/agent-runtime packages/agent-runtime
COPY packages/ui-change-agent packages/ui-change-agent
COPY packages/ui-change-contracts packages/ui-change-contracts
COPY packages/ui-change-domain packages/ui-change-domain

RUN mkdir -p /data/source-workspaces /data/logs

EXPOSE 8787

CMD ["pnpm", "--filter", "@ui-agent/agent-service", "start"]
