# syntax=docker/dockerfile:1
FROM node:22.13-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.13-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY dashboard ./dashboard
COPY benchmarks/results/latest.json ./benchmarks/results/latest.json
COPY package.json LICENSE README.md ./
RUN ln -s /app/dist/cli/index.js /usr/local/bin/toolsmith-mcp && mkdir /work && chown node:node /work
USER node
# Mount a directory holding toolsmith.config.json (+ .env) at /work.
WORKDIR /work
EXPOSE 7420
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:7420/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["toolsmith-mcp"]
# Binding 0.0.0.0 inside the container requires server.mcpToken (init generates one).
CMD ["start", "--host", "0.0.0.0"]
