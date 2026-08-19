/* Baut aus mockup/ eine einzelne, in sich geschlossene HTML-Datei.
   Aufruf: node build.mjs  ->  dist/leitstand.html
   Die Datei enthält kein <html>/<head>/<body>, damit sie sowohl direkt
   im Browser als auch als eingebetteter Artifact funktioniert. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const read = p => readFileSync(new URL(p, import.meta.url), "utf8");
const html = read("./mockup/index.html");
const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>")).trim()
  .replace(/<script src="[^"]*"><\/script>\s*/g, "");

const out = `<title>Leitstand</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
${read("./mockup/assets/styles.css")}
</style>
${body}
<script>
${read("./mockup/assets/data.js")}
${read("./mockup/assets/app.js")}
</script>
`;

mkdirSync(new URL("./dist/", import.meta.url), { recursive: true });
writeFileSync(new URL("./dist/leitstand.html", import.meta.url), out);
console.log("dist/leitstand.html  " + (out.length / 1024).toFixed(1) + " kB");
