# Leitstand — ein Abbild, das Dienst und Oberfläche enthält.
# Build-Kontext ist die Wurzel des Repositorys, weil ui/ dazugehört.

FROM node:22-alpine

# iputils: ohne ping überspringt der Prober ICMP und prüft nur noch TCP.
# tini: sauberes Beenden, damit ein Neustart in Portainer nicht hängt.
RUN apk add --no-cache iputils tini

WORKDIR /app

COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server/src ./src
COPY ui ./ui
# Werkzeuge für die Fehlersuche am laufenden Behälter. Sie werden nie
# selbst ausgeführt, sondern von Hand aufgerufen — und dort gebraucht,
# wo das Problem ist: im Netz des Behälters, nicht auf dem Entwicklungsrechner.
COPY server/tools ./tools
# Dient beim ersten Start als Vorlage für /data/inventory.yaml
COPY server/inventory.yaml ./inventory.yaml

# ---- Herkunft dieses Abbilds ------------------------------------------------
# Wird vom Arbeitsablauf gefüllt (.github/workflows/image.yml) und in der
# Oberfläche unten links angezeigt — die Antwort auf „läuft schon der neue
# Stand?" nach einem automatischen Redeploy. Fehlen die Angaben, läuft der
# Dienst genauso und nennt statt des Commits den Dateistand des Programms.
#
# Bewusst ganz unten und in einer eigenen Schicht: der Commit ändert sich bei
# jedem Push, alles darüber bleibt im Zwischenspeicher.
ARG LEITSTAND_COMMIT=
ARG LEITSTAND_BRANCH=
ARG LEITSTAND_COMMITTED=
ARG LEITSTAND_BUILT=
ARG LEITSTAND_VERSION=

ENV LEITSTAND_COMMIT=$LEITSTAND_COMMIT \
    LEITSTAND_BRANCH=$LEITSTAND_BRANCH \
    LEITSTAND_COMMITTED=$LEITSTAND_COMMITTED \
    LEITSTAND_BUILT=$LEITSTAND_BUILT \
    LEITSTAND_VERSION=$LEITSTAND_VERSION

LABEL org.opencontainers.image.revision=$LEITSTAND_COMMIT \
      org.opencontainers.image.created=$LEITSTAND_BUILT \
      org.opencontainers.image.version=$LEITSTAND_VERSION \
      org.opencontainers.image.title="Leitstand"

# Rechte setzen, BEVOR /data zum Volume erklärt wird — spätere Änderungen an
# einem Volume-Pfad verwirft der Bauvorgang, der Dienst könnte dann als
# unprivilegierter Benutzer nicht schreiben.
RUN mkdir -p /data && chown -R node:node /data /app

ENV LEITSTAND_INVENTORY=/data/inventory.yaml \
    LEITSTAND_UI=/app/ui \
    NODE_ENV=production \
    PORT=8080

VOLUME /data
EXPOSE 8080

# Der Leitstand liest nur — er braucht keine erhöhten Rechte
USER node

# Bewusst /api/version und nicht /api/state: der Healthcheck soll beantworten,
# ob der Dienst läuft — nicht, ob sich der gesamte Zustand fehlerfrei
# zusammenbauen lässt. Sonst brächte ein Anzeigefehler den Behälter in eine
# Neustartschleife, und ausgerechnet die Überwachung wäre weg.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
