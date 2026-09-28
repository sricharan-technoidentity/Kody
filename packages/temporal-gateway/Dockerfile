FROM node:26-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/temporal-gateway/package.json packages/temporal-gateway/package.json
RUN npm ci --omit=dev --workspace @kody/temporal-gateway --include-workspace-root=false
COPY packages/shared packages/shared
COPY packages/temporal-gateway packages/temporal-gateway
USER node
CMD ["node", "packages/temporal-gateway/src/server.ts"]
