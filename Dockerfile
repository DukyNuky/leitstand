# Leitstand — ein Abbild, das Dienst und Oberfläche enthält.
# Build-Kontext ist die Wurzel des Repositorys, weil mockup/ dazugehört.

FROM node:22-alpine

# iputils: ohne ping überspringt der Prober ICMP und prüft nur noch TCP.
# tini: sauberes Beenden, damit ein Neustart in Portainer nicht hängt.
RUN apk add --no-cache iputils tini

WORKDIR /app

COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server/src ./src
COPY mockup ./mockup
# Dient beim ersten Start als Vorlage für /data/inventory.yaml
COPY server/inventory.yaml ./inventory.yaml

# Rechte setzen, BEVOR /data zum Volume erklärt wird — spätere Änderungen an
# einem Volume-Pfad verwirft der Bauvorgang, der Dienst könnte dann als
# unprivilegierter Benutzer nicht schreiben.
RUN mkdir -p /data && chown -R node:node /data /app

ENV LEITSTAND_INVENTORY=/data/inventory.yaml \
    LEITSTAND_UI=/app/mockup \
    NODE_ENV=production \
    PORT=8080

VOLUME /data
EXPOSE 8080

# Der Leitstand liest nur — er braucht keine erhöhten Rechte
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
