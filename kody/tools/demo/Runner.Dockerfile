FROM --platform=linux/arm64 node:26-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts && npm rebuild workerd
COPY host.mjs ./
COPY artifacts ./artifacts
USER node
EXPOSE 8080
CMD ["node", "host.mjs"]
