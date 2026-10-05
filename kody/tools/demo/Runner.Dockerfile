FROM --platform=linux/arm64 node:26-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && curl --fail --location --retry 3 --output /tmp/deno.zip \
       https://github.com/denoland/deno/releases/download/v__DENO_VERSION__/deno-aarch64-unknown-linux-gnu.zip \
    && echo '__DENO_SHA256__  /tmp/deno.zip' | sha256sum --check \
    && unzip /tmp/deno.zip deno -d /usr/local/bin && chmod 755 /usr/local/bin/deno \
    && rm /tmp/deno.zip && apt-get purge -y curl unzip && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY host.mjs ./
COPY deno-bootstrap.mjs deno-worker.mjs ./
ENV KODY_DENO_EXECUTABLE=/usr/local/bin/deno
USER node
EXPOSE 8080
CMD ["node", "host.mjs"]
