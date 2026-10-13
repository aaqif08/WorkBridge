# Production image for the WorkBridge platform (API + served frontend).
FROM node:22-alpine

WORKDIR /app

# Install production dependencies first so Docker can cache this layer.
COPY package*.json ./
RUN npm ci --omit=dev

# Application code. .dockerignore keeps node_modules, data and uploads out.
COPY . .

ENV NODE_ENV=production
ENV PORT=5000

# Writable locations for the JSON datastore and uploaded documents. Mount a
# volume on these in any real deployment: a container filesystem is ephemeral,
# so without a volume every account, application and uploaded file is lost on
# redeploy. See README "Database and persistence".
ENV DATA_DIR=/data/db
ENV UPLOAD_DIR=/data/uploads
RUN mkdir -p /data/db /data/uploads && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 5000

# Fails the container's health status when the datastore is unusable, instead of
# reporting healthy while the service cannot actually serve requests.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node scripts/health-check.js http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "server.js"]
