# drawio-sql-er в Docker: draw.io + плагин + чтение схемы PostgreSQL на одном адресе.
#
#   docker compose up -d      →  http://localhost:8080/

# draw.io — статические файлы из официального образа (версия зафиксирована).
FROM jgraph/drawio:31.4.6 AS drawio

FROM node:22-alpine
WORKDIR /app

# draw.io меняется редко — отдельным слоем; служебные папки Java-приложения не нужны.
COPY --from=drawio /usr/local/tomcat/webapps/draw /opt/drawio
RUN rm -rf /opt/drawio/WEB-INF /opt/drawio/META-INF

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY bridge ./bridge
COPY scripts/build.js scripts/server.js ./scripts/
RUN node scripts/build.js

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DRAWIO_DIR=/opt/drawio \
    SQL_ER_IN_DOCKER=1

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "scripts/server.js"]
