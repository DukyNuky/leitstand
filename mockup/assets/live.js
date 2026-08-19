/* Brücke zum Server.

   Wird als erstes Skript geladen und holt sofort /api/state, damit die
   Oberfläche gar nicht erst mit Beispieldaten aufblitzt. Antwortet niemand
   — etwa weil index.html direkt aus dem Dateisystem geöffnet wurde —
   bleibt es beim Beispielbestand aus data.js.

   Danach hält eine SSE-Verbindung die Anzeige aktuell; fällt sie aus,
   wird in wachsenden Abständen erneut versucht. */

(() => {
  const L = {
    pending: true,
    live: false,
    lastRun: null,
    interval: null,
    error: null,
    handlers: { state: [], fail: [] }
  };
  window.LEITSTAND = L;
  L.onState = fn => L.handlers.state.push(fn);
  L.onFail = fn => L.handlers.fail.push(fn);

  const fire = (kind, arg) => { for (const fn of L.handlers[kind]) { try { fn(arg); } catch (e) { console.error(e); } } };

  /* Erstabruf: kurz, damit ein toter Server die Oberfläche nicht aufhält. */
  const ctrl = new AbortController();
  const bail = setTimeout(() => ctrl.abort(), 2500);

  fetch("api/state", { signal: ctrl.signal })
    .then(r => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
    .then(st => {
      clearTimeout(bail);
      L.pending = false; L.live = true;
      accept(st);
      subscribe();
    })
    .catch(err => {
      clearTimeout(bail);
      L.pending = false; L.live = false;
      L.error = err.name === "AbortError" ? "Kein Server erreichbar" : err.message;
      fire("fail", L.error);
    });

  function accept(st) {
    L.lastRun = st.meta?.lastRun || null;
    L.interval = st.meta?.interval || null;
    L.counts = st.meta?.counts || null;
    fire("state", st);
  }

  /* Laufende Aktualisierung */
  let es = null, retry = 0;
  function subscribe() {
    if (!("EventSource" in window)) return poll();
    es = new EventSource("api/stream");
    es.onmessage = ev => {
      retry = 0;
      try { accept(JSON.parse(ev.data)); } catch {}
    };
    es.onerror = () => {
      es.close();
      retry = Math.min(retry + 1, 6);
      setTimeout(subscribe, 1000 * 2 ** retry);      /* 2 s, 4 s, … höchstens gut eine Minute */
    };
  }
  function poll() {
    setInterval(() => fetch("api/state").then(r => r.json()).then(accept).catch(() => {}), 15000);
  }

  /* Schreibende Aufrufe für Oberfläche und Verwaltung. */
  L.call = async (method, path, body) => {
    const res = await fetch(path.replace(/^\//, ""), {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  };
})();
