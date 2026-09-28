FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/temporal-worker/package.json packages/temporal-worker/package.json
RUN npm ci --workspace @kody/temporal-worker --include-workspace-root=false
COPY packages/shared packages/shared
COPY packages/temporal-worker packages/temporal-worker
RUN npm run build --workspace @kody/temporal-worker

FROM node:26-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/temporal-worker ./packages/temporal-worker
EXPOSE 9464
USER node
CMD ["node", "packages/temporal-worker/src/worker.ts"]
