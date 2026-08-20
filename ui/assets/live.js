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

  /* Erstabruf.

     Zwei Dinge waren hier falsch und haben zusammen dafür gesorgt, dass die
     Seite gelegentlich leer blieb, bis man sie mehrfach neu lud:

     Erstens brach der Abruf schon nach 2,5 s ab. Das ist keine Zeitspanne
     für einen Seitenaufbau — ein Browser hält je Gegenstelle nur sechs
     Verbindungen offen, und jeder offene Reiter belegt eine davon dauerhaft
     mit dem Ereignisstrom. Sind sie belegt, wartet der Abruf in der
     Schlange, statt langsam zu sein. Genau deshalb half ein privates
     Fenster: das hat einen eigenen Vorrat an Verbindungen.

     Zweitens war ein Fehlschlag endgültig. Es gab keinen weiteren Versuch,
     und der Ereignisstrom wurde gar nicht erst geöffnet — die Seite blieb
     leer, bis jemand von Hand neu lud.

     Jetzt: großzügiges Zeitlimit, Wiederholung in wachsenden Abständen, und
     der Strom wird auch nach einem Fehlschlag geöffnet. Dessen erste
     Nachricht ist der vollständige Zustand; er kann die Seite also allein
     wieder füllen. */
  const ERSTABRUF_MS = 10000;
  let anlauf = 0, geplant = null;

  function connect() {
    clearTimeout(geplant); geplant = null;

    const ctrl = new AbortController();
    const bail = setTimeout(() => ctrl.abort(), ERSTABRUF_MS);

    return fetch("api/state", { signal: ctrl.signal, cache: "no-store" })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .then(st => {
        clearTimeout(bail);
        anlauf = 0;
        L.pending = false; L.live = true; L.error = null; L.stale = false;
        accept(st);
        subscribe();
      })
      .catch(err => {
        clearTimeout(bail);
        L.pending = false; L.live = false;
        L.error = err.name === "AbortError" ? "Zeitüberschreitung — keine Antwort auf /api/state" : err.message;
        fire("fail", L.error);

        anlauf = Math.min(anlauf + 1, 5);
        geplant = setTimeout(connect, 1000 * 2 ** anlauf);   /* 2 s, 4 s, … höchstens 32 s */
        subscribe();
      });
  }
  connect();

  /* Wer zurück auf den Reiter wechselt, will nicht auf den nächsten
     Versuch warten — und ein Rechner, der aus dem Schlaf kommt, hat
     ohnehin gerade alle Verbindungen verloren. */
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !L.live) L.retry(); });
  window.addEventListener("online", () => { if (!L.live) L.retry(); });

  /* Von Hand ausgelöster neuer Versuch (Schaltfläche „Erneut verbinden"). */
  L.retry = () => { if (es) { es.close(); es = null; } retry = 0; anlauf = 0; return connect(); };

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
    if (es) return;                       /* nie zwei Ströme nebeneinander */
    es = new EventSource("api/stream");
    es.onmessage = ev => {
      retry = 0;
      anlauf = 0;
      /* Der Strom trägt den vollständigen Zustand. Kam er an, ist der
         Erstabruf gegenstandslos — die geplante Wiederholung entfällt. */
      clearTimeout(geplant); geplant = null;
      L.pending = false; L.live = true; L.stale = false; L.error = null;
      try { accept(JSON.parse(ev.data)); } catch {}
      fire("stale", false);
    };
    es.onerror = () => {
      es.close();
      es = null;
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
