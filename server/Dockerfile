# Leitstand — Stufe 1
# Bewusst schlank: eine Abhängigkeit (yaml), kein Build-Schritt.
FROM node:22-alpine

# ping für die ICMP-Prüfung; ohne das Paket überspringt der Prober ICMP
RUN apk add --no-cache iputils tini

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# Bestand, Zugangsdaten und Störungsstand liegen im Datenverzeichnis
ENV LEITSTAND_INVENTORY=/data/inventory.yaml
VOLUME /data
EXPOSE 8080

# Nicht als root: der Leitstand liest nur, er braucht keine Rechte
USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
