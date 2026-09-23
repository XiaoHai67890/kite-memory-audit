FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 AUDIT_MODE=paid
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node config ./config
USER node
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
