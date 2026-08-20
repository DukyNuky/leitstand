/* Brücke zum Server.

   Wird als erstes Skript geladen und holt sofort /api/state. Antwortet
   niemand, bleibt die Oberfläche leer und sagt das — es gibt keinen
   Beispielbestand mehr, auf den sie zurückfallen könnte. Eine Überwachung,
   die im Zweifel etwas anzeigt, ist schlimmer als eine, die schweigt.

   Danach hält eine SSE-Verbindung die Anzeige aktuell; fällt sie aus, wird
   in wachsenden Abständen erneut versucht. */

(() => {
  const L = {
    pending: true,
    live: false,
    lastRun: null,
    interval: null,
    error: null,
    stale: false,
    handlers: { state: [], fail: [], stale: [] }
  };
  window.LEITSTAND = L;
  L.onState = fn => L.handlers.state.push(fn);
  L.onFail = fn => L.handlers.fail.push(fn);
  L.onStale = fn => L.handlers.stale.push(fn);

  const fire = (kind, arg) => { for (const fn of L.handlers[kind]) { try { fn(arg); } catch (e) { console.error(e); } } };

  /* Erstabruf: kurz, damit ein toter Server die Oberfläche nicht aufhält. */
  function connect() {
    const ctrl = new AbortController();
    const bail = setTimeout(() => ctrl.abort(), 2500);

    return fetch("api/state", { signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .then(st => {
        clearTimeout(bail);
        L.pending = false; L.live = true; L.error = null; L.stale = false;
        accept(st);
        subscribe();
      })
      .catch(err => {
        clearTimeout(bail);
        L.pending = false; L.live = false;
        L.error = err.name === "AbortError" ? "Zeitüberschreitung — keine Antwort auf /api/state" : err.message;
        fire("fail", L.error);
      });
  }
  connect();

  /* Von Hand ausgelöster neuer Versuch (Schaltfläche „Erneut verbinden"). */
  L.retry = () => { if (es) { es.close(); es = null; } retry = 0; return connect(); };

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
      L.live = true; L.stale = false; L.error = null;
      try { accept(JSON.parse(ev.data)); } catch {}
      fire("stale", false);
    };
    es.onerror = () => {
      es.close();
      retry = Math.min(retry + 1, 6);
      /* Ein abgerissener Strom ist erst einmal nur veraltet — die Werte von
         vorhin bleiben stehen, aber sichtbar gekennzeichnet. Erst wenn
         mehrere Versuche scheitern, gilt der Dienst als weg und die
         Oberfläche zeigt gar nichts mehr: alte Werte, die wie aktuelle
         aussehen, sind in einer Überwachung das eigentliche Risiko. */
      L.stale = true;
      L.error = "Verbindung zum Dienst abgerissen";
      if (retry >= 3) { L.live = false; fire("fail", L.error); }
      else fire("stale", true);
      setTimeout(subscribe, 1000 * 2 ** retry);      /* 2 s, 4 s, … höchstens gut eine Minute */
    };
  }
  function poll() {
    setInterval(() => fetch("api/state")
      .then(r => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .then(st => { L.live = true; accept(st); })
      .catch(e => { L.live = false; L.error = e.message; fire("fail", L.error); }), 15000);
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
