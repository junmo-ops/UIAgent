FROM csbase.registry.cmbchina.cn/paas/cmb-nodejs-22.22:c86-kylin10-v1

USER root

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV SOURCE_WORKSPACE_DIR=/opt/deployments/data/source-workspaces
ENV LOG_FILE=/opt/deployments/data/logs/agent-turns.jsonl

WORKDIR /opt/deployments

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/agent-service/package.json apps/agent-service/package.json
COPY packages/agent-runtime/package.json packages/agent-runtime/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm install --global pnpm@10.33.0 \
      --registry=http://central.jaf.cmbchina.cn/artifactory/api/npm/group-npm/ \
  && pnpm install --prod --frozen-lockfile \
  && mkdir -p /opt/.config \
  && chmod -R 755 /opt/.config

COPY apps/agent-service apps/agent-service
COPY packages/agent-runtime packages/agent-runtime
COPY packages/contracts packages/contracts

RUN chmod -R 777 /opt/deployments \
  && mkdir -p /opt/deployments/data/source-workspaces /opt/deployments/data/logs

EXPOSE 8787

CMD ["pnpm", "--filter", "@ui-agent/agent-service", "start"]
