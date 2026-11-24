// ===== Linea Italia — motore di simulazione (dati città, domanda, scelta modale, carichi) =====
'use strict';

const TIPI = {
  pesante: { nome: 'Metro pesante', cap: 800, vel: 36, costoOra: 650 },
  media:   { nome: 'Media capacità', cap: 450,  vel: 32, costoOra: 420 },
  leggera: { nome: 'Metro leggera',  cap: 200,  vel: 24, costoOra: 260 },
};
const PIANI = {
  sotterranea:  { nome: 'Sotterranea',  accesso: 2.0, costoGiorno: 1800, costoKm: 180 },
  sopraelevata: { nome: 'Sopraelevata', accesso: 1.2, costoGiorno: 1000, costoKm: 90 },
  raso:         { nome: 'A raso',       accesso: 0.4, costoGiorno: 500,  costoKm: 35 },
};
const BETA_T = 0.075;         // sensibilità al tempo (per minuto)
const ORE_PUNTA = 5, ORE_MORBIDA = 14;
const QUOTA_PUNTA = 0.45;     // quota dei viaggi giornalieri nelle fasce di punta
const MODI = ['piedi', 'bici', 'scooter', 'auto', 'bus'];
const MODI_NOME = { piedi: 'A piedi', bici: 'Bici', scooter: 'Scooter', auto: 'Auto', bus: 'Bus', metro: 'Metro' };

function distKm(a, b) {
  const la = (a.lat + b.lat) / 2 * Math.PI / 180;
  const dy = (b.lat - a.lat) * 111.32;
  const dx = (b.lon - a.lon) * 111.32 * Math.cos(la);
  return Math.sqrt(dx * dx + dy * dy);
}

// ---------- Dati OpenStreetMap: quartieri e poli di attrazione ----------
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

function raggioCitta(pop) { return Math.max(4, Math.min(17, 3 + Math.sqrt(pop / 1000) * 0.26)); }

async function scaricaDatiOSM(city) {
  const key = 'lineaitalia:osm:v1:' + city.id;
  try { const c = localStorage.getItem(key); if (c) return JSON.parse(c); } catch (e) {}
  const r = Math.round(raggioCitta(city.pop) * 1000);
  const q = `[out:json][timeout:40];(
node["place"~"^(suburb|quarter|neighbourhood|town|village|hamlet)$"](around:${r},${city.lat},${city.lon});
nwr["railway"="station"]["station"!="subway"](around:${r},${city.lat},${city.lon});
nwr["amenity"~"^(university|hospital)$"](around:${r},${city.lat},${city.lon});
);out center tags;`;
  let data = null;
  for (const url of OVERPASS) {
    try {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 45000);
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctrl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      clearTimeout(to);
      if (res.ok) { data = await res.json(); break; }
    } catch (e) { /* prova il server successivo */ }
  }
  if (!data) return null;
  const places = [], attr = [];
  for (const el of data.elements || []) {
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null) continue;
    const t = el.tags || {}; const name = t['name:it'] || t.name || '';
    if (t.place) places.push({ lat, lon, name, type: t.place });
    else if (t.railway === 'station') attr.push({ lat, lon, name: name ? (/stazione/i.test(name) ? name : 'Stazione ' + name) : '', type: 'stazione', w: 2.5 });
    else if (t.amenity === 'university') attr.push({ lat, lon, name: name || 'Università', type: 'università', w: 3 });
    else if (t.amenity === 'hospital') attr.push({ lat, lon, name: name || 'Ospedale', type: 'ospedale', w: 2 });
  }
  const out = { places, attr };
  try { localStorage.setItem(key, JSON.stringify(out)); } catch (e) {}
  return out;
}

// ---------- Zone, popolazione, posti di lavoro, matrice origine-destinazione ----------
function costruisciCitta(city, osm) {
  const R = raggioCitta(city.pop);
  const cell = Math.max(0.35, R / 13);
  const kLat = 1 / 111.32, kLon = 1 / (111.32 * Math.cos(city.lat * Math.PI / 180));
  const places = osm ? osm.places : [];
  const attr = osm ? osm.attr : [];
  const PW = { suburb: 5, quarter: 3, neighbourhood: 1.5, town: 6, village: 2.5, hamlet: 0.6 };
  const sig = Math.max(0.5, cell * 1.2);
  const raw = [];
  const n = Math.ceil(R / cell);
  // generatore pseudo-casuale deterministico per città
  let seed = 0; for (const ch of city.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let gy = -n; gy <= n; gy++) for (let gx = -n; gx <= n; gx++) {
    const x = gx * cell, y = gy * cell; const dc = Math.hypot(x, y);
    if (dc > R) continue;
    const z = { lat: city.lat + y * kLat, lon: city.lon + x * kLon, dc };
    const core = Math.exp(-dc / (R * 0.3));
    let land = 0;
    for (const p of places) {
      const s = p.type === 'suburb' || p.type === 'town' ? sig * 1.6 : sig;
      const d = distKm(z, p); if (d > s * 3.5) continue;
      land += (PW[p.type] || 1) * Math.exp(-d * d / (2 * s * s));
    }
    let a = 0;
    for (const p of attr) { const d = distKm(z, p); if (d < 2) a += p.w * Math.exp(-d * d / 0.5); }
    if (places.length) { z.pop = land * (0.35 + core); z.jobs = land * (0.12 + 2 * Math.pow(core, 1.6)); }
    else { z.pop = core * (0.7 + 0.6 * rnd()); z.jobs = Math.pow(core, 1.6) * (0.7 + 0.6 * rnd()); }
    z.attr = a;
    raw.push(z);
  }
  const maxPop = Math.max(...raw.map(z => z.pop + z.jobs));
  const zones = raw.filter(z => z.pop + z.jobs > maxPop * 0.004);
  const sP = zones.reduce((s, z) => s + z.pop, 0) || 1;
  const sJ = zones.reduce((s, z) => s + z.jobs, 0) || 1;
  const sA = zones.reduce((s, z) => s + z.attr, 0);
  const totJobs = city.pop * 0.5;
  for (const z of zones) {
    z.pop = z.pop / sP * city.pop;
    z.jobs = z.jobs / sJ * totJobs * (sA > 0 ? 0.8 : 1) + (sA > 0 ? z.attr / sA * totJobs * 0.2 : 0);
  }
  // gravitazionale casa->destinazione (con ritorno), distanze e utilità dei modi senza metro
  const N = zones.length;
  const od = new Float32Array(N * N);
  const base = new Float32Array(N * N);
  const beta = 1 / (R * 0.28);
  const att = zones.map(z => z.jobs + 0.3 * z.pop);
  const modeTot = { piedi: 0, bici: 0, scooter: 0, auto: 0, bus: 0 };
  let totTrips = 0;
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let j = 0; j < N; j++) { w[j] = att[j] * Math.exp(-beta * distKm(zones[i], zones[j])); s += w[j]; }
    const prod = zones[i].pop * 1.1;
    for (let j = 0; j < N; j++) if (j !== i) { const h = prod * w[j] / s; od[i * N + j] += h; od[j * N + i] += h; }
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (i === j) continue;
    const t = od[i * N + j]; if (t <= 0) continue;
    const u = utilitaBase(distKm(zones[i], zones[j]) * 1.3);
    let s = 0; for (const m of MODI) s += u[m];
    base[i * N + j] = s;
    for (const m of MODI) modeTot[m] += t * u[m] / s;
    totTrips += t;
  }
  return { R, cell, zones, N, od, base, modeTot, totTrips, places, attr };
}

function utilitaBase(dd) {
  const e = x => Math.exp(x);
  return {
    piedi: e(-BETA_T * (dd / 4.8 * 60) - 0.6 * Math.max(0, dd - 3)),
    bici: e(-BETA_T * (dd / 14 * 60 + 3) - 1.4 - 0.25 * Math.max(0, dd - 5)),
    scooter: e(-BETA_T * (dd / 24 * 60 + 4) - 2.6),
    auto: e(-BETA_T * (dd / 20 * 60 + 11) - 0.5 - 0.03 * dd),
    bus: e(-BETA_T * (dd / 12 * 60 + 10) - 0.6),
  };
}

// ---------- Costruzione: costi (milioni di €) e durata (giorni) ----------
const CANTIERE = {
  sotterranea:  { stazione: 60, giorniStazione: 30, giorniKm: 8 },
  sopraelevata: { stazione: 30, giorniStazione: 18, giorniKm: 5 },
  raso:         { stazione: 8,  giorniStazione: 8,  giorniKm: 2 },
};
function pianoTratta(a, b) {
  // la tratta è costruita come la più "pesante" delle due fermate
  const ord = ['raso', 'sopraelevata', 'sotterranea'];
  return ord[Math.max(ord.indexOf(a.platform), ord.indexOf(b.platform))];
}
function costoTratta(a, b) {
  const km = distKm(a, b) * 1.12; const p = pianoTratta(a, b);
  return { km, piano: p, costo: km * PIANI[p].costoKm, giorni: Math.max(3, Math.round(km * CANTIERE[p].giorniKm)) };
}
const chiaveTratta = (a, b) => a < b ? a + '|' + b : b + '|' + a;

// ---------- Tariffe ----------
const TARIFFE_BASE = { modo: 'zone', anelli: null, prezzi: [1.5, 2.0, 2.6] };
const PREZZO_RIF = 1.5;       // prezzo a cui è tarata la scelta modale
const BETA_EURO = 0.45;       // sensibilità al prezzo (per €)
function zonaDi(st, tar, centro) {
  if (!tar || tar.modo !== 'zone' || !centro) return 0;
  const d = distKm(st, centro); let z = 0;
  for (const r of tar.anelli || []) if (d > r) z++;
  return z;
}
function prezzoViaggio(za, zb, tar) {
  if (!tar) return PREZZO_RIF;
  if (tar.modo !== 'zone') return tar.prezzi[0];
  return tar.prezzi[Math.min(Math.abs(za - zb), tar.prezzi.length - 1)];
}

// ---------- Parametri di una linea intera (per treni automatici e schede) ----------
function parametriLinea(l, stations) {
  const T = TIPI[l.type];
  const st = l.stops.map(id => stations[id]).filter(Boolean);
  const seg = [], segKm = []; let run = 0, km = 0;
  for (let k = 0; k < st.length - 1; k++) {
    const { t, d } = tempoTratto(l, st[k], st[k + 1]);
    seg.push(t); segKm.push(d); run += t; km += d;
  }
  const cycle = 2 * run + 6;
  const nPeak = Math.max(1, l.trains);
  const nOff = Math.max(1, Math.round(l.trains * l.offpeak / 100));
  return { seg, segKm, run, km, cycle, nPeak, nOff, cap: T.cap,
    hwPeak: Math.max(1.5, cycle / nPeak), hwOff: Math.max(1.5, cycle / nOff), sprecati: cycle / nPeak < 1.5 };
}
function tempoTratto(l, a, b) {
  const T = TIPI[l.type];
  const d = distKm(a, b) * 1.12;
  let v = T.vel;
  if (a.platform === 'raso' || b.platform === 'raso') v *= l.type === 'pesante' ? 0.95 : 0.8;
  return { t: d / v * 60 + 0.6, d };
}

// ---------- Percorsi: linea normale + corse espresse e limitate, solo sui tratti aperti ----------
function costruisciPercorsi(stations, lines, opts = {}) {
  const aperta = opts.stazioneAperta || (() => true);
  const trattaOk = opts.trattaAperta || (() => true);
  const routes = [], pezzi = [];
  for (const l of lines) {
    const runs = []; let run = [];
    l.stops.forEach((sid, k) => {
      if (!stations[sid] || !aperta(sid)) { if (run.length) runs.push(run); run = []; return; }
      if (run.length && !trattaOk(l.stops[k - 1], sid)) { runs.push(run); run = []; }
      run.push(sid);
    });
    if (run.length) runs.push(run);
    runs.filter(r => r.length >= 2).forEach((stops, n) => {
      const pz = { id: l.id + '#' + n, line: l, stops, seg: [], segKm: [], routes: [] };
      for (let k = 0; k < stops.length - 1; k++) {
        const { t, d } = tempoTratto(l, stations[stops[k]], stations[stops[k + 1]]);
        pz.seg.push(t); pz.segKm.push(d);
      }
      pezzi.push(pz);
      const main = creaPercorso(pz, null, stops.map((_, i) => i), l.trains);
      routes.push(main); pz.routes.push(main);
      for (const sv of l.services || []) {
        const a = stops.indexOf(sv.from), b = stops.indexOf(sv.to);
        if (a < 0 || b < 0 || a === b) continue;
        const [i0, i1] = a < b ? [a, b] : [b, a];
        const skip = new Set(sv.tipo === 'espresso' ? sv.skip || [] : []);
        const idx = [];
        for (let i = i0; i <= i1; i++) if (i === i0 || i === i1 || !skip.has(stops[i])) idx.push(i);
        if (idx.length < 2) continue;
        const r = creaPercorso(pz, sv, idx, sv.trains);
        routes.push(r); pz.routes.push(r);
      }
    });
  }
  return { routes, pezzi };
}
function creaPercorso(pz, sv, idx, trains) {
  const l = pz.line; const hop = []; let run = 0;
  for (let p = 0; p < idx.length - 1; p++) {
    let t = 0; for (let k = idx[p]; k < idx[p + 1]; k++) t += pz.seg[k];
    t -= 0.9 * (idx[p + 1] - idx[p] - 1); // ogni fermata saltata fa risparmiare frenata, sosta e ripartenza
    hop.push(t); run += t;
  }
  const cycle = 2 * run + 6;
  const nPeak = Math.max(1, trains || 1), nOff = Math.max(1, Math.round((trains || 1) * l.offpeak / 100));
  let km = 0; for (let k = idx[0]; k < idx[idx.length - 1]; k++) km += pz.segKm[k];
  return { id: sv ? pz.id + ':' + sv.id : pz.id, pz, line: l, sv, idx, sids: idx.map(i => pz.stops[i]), hop, run, km, cycle,
    nPeak, nOff, cap: TIPI[l.type].cap, hwPeak: Math.max(1.5, cycle / nPeak), hwOff: Math.max(1.5, cycle / nOff), sprecati: cycle / nPeak < 1.5 };
}

// ---------- Calcolo completo della rete ----------
function calcolaRete(C, stations, lines, opts = {}) {
  const { routes, pezzi } = costruisciPercorsi(stations, lines, opts);
  const tar = opts.tariffe || null; const centro = opts.centro || null;

  const nodes = [], stNodes = {};
  for (const r of routes) {
    r.base = nodes.length;
    r.sids.forEach((sid, p) => { const id = nodes.length; nodes.push({ r, p, sid }); (stNodes[sid] = stNodes[sid] || []).push(id); });
  }
  const V = nodes.length;
  const sids = Object.keys(stNodes); const S = sids.length;
  const zonaSt = sids.map(s => zonaDi(stations[s], tar, centro));
  const adj = nodes.map(() => []);
  for (let v = 0; v < V; v++) {
    const { r, p, sid } = nodes[v];
    if (p > 0) adj[v].push({ to: v - 1, c: r.hop[p - 1], x: 0 });
    if (p < r.sids.length - 1) adj[v].push({ to: v + 1, c: r.hop[p], x: 0 });
    for (const u of stNodes[sid]) if (u !== v && nodes[u].r !== r) adj[v].push({ to: u, c: nodes[u].r.line === r.line ? 1 : 4, x: 1 });
  }

  const res = {
    routes, pezzi, S, sids, riders: 0, potenziale: 0, persi: 0, ricavi: 0, costi: 0, ratio: 0, qualita: 0,
    stazioni: {}, linee: {}, percorsi: {}, carichi: {}, LP: {}, attesa: 0, trasbordi: 0, affoll: 0, quotaPersi: 0, prezzoMedio: 0,
  };
  sids.forEach((s, i) => res.stazioni[s] = { ingressi: 0, trasbordi: 0, zona: zonaSt[i] });
  for (const l of lines) res.linee[l.id] = { saliti: 0, ricavi: 0, costo: 0, maxRatio: 0, maxRatioOff: 0, saturo: false, aperta: false };
  for (const r of routes) res.percorsi[r.id] = { saliti: 0, maxRatio: 0 };
  for (const pz of pezzi) {
    const ns = pz.stops.length - 1;
    res.carichi[pz.id] = { peak: [new Float64Array(ns), new Float64Array(ns)], off: [new Float64Array(ns), new Float64Array(ns)] };
    res.linee[pz.line.id].aperta = true;
  }
  // scheda di riepilogo della linea: il percorso principale del tratto aperto più lungo
  for (const l of lines) {
    const mains = routes.filter(r => r.line === l && !r.sv).sort((a, b) => b.km - a.km);
    if (mains.length) res.LP[l.id] = { ...mains[0], kmAperti: mains.reduce((s, r) => s + r.km, 0) };
  }

  // frequenza e capacità per tratto, sommando tutte le corse che ci passano
  const freq = (r, key) => 60 / (key === 'peak' ? r.hwPeak : r.hwOff);
  const capSeg = {};
  for (const pz of pezzi) {
    capSeg[pz.id] = {};
    for (const key of ['peak', 'off']) {
      const c = new Float64Array(pz.stops.length - 1), f = new Float64Array(pz.stops.length - 1);
      for (const r of pz.routes) for (let k = r.idx[0]; k < r.idx[r.idx.length - 1]; k++) { c[k] += freq(r, key) * r.cap; f[k] += freq(r, key); }
      capSeg[pz.id][key] = c;
      if (key === 'peak' && Math.max(...f) > 40) res.linee[pz.line.id].saturo = true;
    }
  }

  // costi di esercizio
  let costi = 0;
  for (const r of routes) {
    const c = (r.nPeak * ORE_PUNTA + r.nOff * ORE_MORBIDA) * TIPI[r.line.type].costoOra;
    res.linee[r.line.id].costo += c; costi += c;
  }
  for (const s of sids) costi += PIANI[stations[s].platform].costoGiorno;
  res.costi = costi;
  if (!S) { res.modi = quoteModali(C, 0); return res; }

  // attesa alla banchina: si prende la prima corsa utile della stessa linea che ferma anche alla fermata successiva
  const attese = key => {
    const w = new Float64Array(V);
    for (let v = 0; v < V; v++) {
      const { r, p } = nodes[v];
      const i = r.idx[p], j = p < r.idx.length - 1 ? r.idx[p + 1] : r.idx[p - 1];
      let f = 0;
      for (const r2 of r.pz.routes) if (r2.idx.includes(i) && r2.idx.includes(j)) f += freq(r2, key);
      w[v] = 30 / Math.max(f, 0.01);
    }
    return w;
  };
  const varianti = [
    { key: 'peak', peso: QUOTA_PUNTA, oraFatt: 0.12 / QUOTA_PUNTA },
    { key: 'off', peso: 1 - QUOTA_PUNTA, oraFatt: 0.06 / (1 - QUOTA_PUNTA) },
  ];
  for (const vr of varianti) {
    const wait = attese(vr.key);
    const T = new Float32Array(S * S).fill(Infinity), B = new Uint8Array(S * S), W = new Float32Array(S * S);
    const END = new Int32Array(S * S).fill(-1); const PREV = [];
    const dist = new Float64Array(V), brd = new Uint8Array(V), wt = new Float64Array(V), done = new Uint8Array(V);
    for (let si = 0; si < S; si++) {
      dist.fill(Infinity); done.fill(0); const prev = new Int32Array(V).fill(-1);
      for (const v of stNodes[sids[si]]) { dist[v] = wait[v]; wt[v] = wait[v]; brd[v] = 1; }
      for (let it = 0; it < V; it++) {
        let u = -1, best = Infinity;
        for (let v = 0; v < V; v++) if (!done[v] && dist[v] < best) { best = dist[v]; u = v; }
        if (u < 0) break; done[u] = 1;
        for (const e of adj[u]) {
          const add = e.x ? e.c + wait[e.to] : e.c;
          const nd = dist[u] + add;
          if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = u; brd[e.to] = brd[u] + e.x; wt[e.to] = wt[u] + (e.x ? wait[e.to] : 0); }
        }
      }
      for (let ti = 0; ti < S; ti++) {
        if (ti === si) continue;
        let bv = -1, bd = Infinity;
        for (const v of stNodes[sids[ti]]) if (dist[v] < bd) { bd = dist[v]; bv = v; }
        if (bv >= 0) { T[si * S + ti] = bd; B[si * S + ti] = brd[bv]; W[si * S + ti] = wt[bv]; END[si * S + ti] = bv; }
      }
      PREV.push(prev);
    }
    Object.assign(vr, { T, B, W, END, PREV, S, stOD: new Float64Array(S * S), stPot: 0 });
  }

  // accesso a piedi zona -> stazioni
  const N = C.N, Z = C.zones;
  const acc = new Array(N); const accZ = [];
  for (let i = 0; i < N; i++) {
    const list = [];
    for (let si = 0; si < S; si++) {
      const st = stations[sids[si]]; const d = distKm(Z[i], st);
      if (d <= 1.6) list.push({ si, t: d * 1.25 / 4.8 * 60 + PIANI[st.platform].accesso });
    }
    if (list.length) { list.sort((a, b) => a.t - b.t); acc[i] = list.slice(0, 4); accZ.push(i); }
  }
  const mat = sids.map(s => stations[s].maturita ?? 1);
  const prezzi = new Float32Array(S * S);
  for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) prezzi[a * S + b] = prezzoViaggio(zonaSt[a], zonaSt[b], tar);

  for (const vr of varianti) {
    const { T, B, stOD } = vr;
    for (const i of accZ) for (const j of accZ) {
      if (i === j) continue;
      const trips = C.od[i * N + j]; if (trips < 0.05) continue;
      // il viaggiatore sceglie la coppia di stazioni con il miglior compromesso tempo/prezzo
      let best = -Infinity, ba = -1, bb = -1;
      for (const a of acc[i]) for (const b of acc[j]) {
        if (a.si === b.si) continue;
        const t = T[a.si * S + b.si]; if (t === Infinity) continue;
        const u = -BETA_T * (a.t + t + b.t) - 0.35 * (B[a.si * S + b.si] - 1) - BETA_EURO * (prezzi[a.si * S + b.si] - PREZZO_RIF);
        if (u > best) { best = u; ba = a.si; bb = b.si; }
      }
      if (ba < 0) continue;
      const em = Math.exp(best + 1.3);
      const share = em / (em + C.base[i * N + j]);
      const pot = trips * vr.peso * share;
      vr.stPot += pot;
      stOD[ba * S + bb] += pot * Math.sqrt(mat[ba] * mat[bb]);
    }
  }

  // percorso a ritroso: chiama cb(nodo, nodoSuccessivo)
  const percorso = (vr, a, b, cb) => {
    let v = vr.END[a * vr.S + b]; const prev = vr.PREV[a]; let nx = -1;
    while (v >= 0) { cb(v, nx); nx = v; v = prev[v]; }
  };
  const tratti = (nv, nn) => {
    const i = nv.r.idx[nv.p], j = nn.r.idx[nn.p];
    return [Math.min(i, j), Math.max(i, j), j > i ? 0 : 1];
  };
  for (const vr of varianti) for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) {
    const f = vr.stOD[a * S + b]; if (!f) continue;
    const ora = f * vr.oraFatt;
    percorso(vr, a, b, (v, nx) => {
      if (nx < 0) return;
      const nv = nodes[v], nn = nodes[nx]; if (nv.r !== nn.r) return;
      const [k0, k1, dir] = tratti(nv, nn); const L = res.carichi[nv.r.pz.id][vr.key][dir];
      for (let k = k0; k < k1; k++) L[k] += ora;
    });
  }
  const ratioSeg = (pz, key, dir, k) => res.carichi[pz.id][key][dir][k] / Math.max(1, capSeg[pz.id][key][k]);
  for (const pz of pezzi) for (const key of ['peak', 'off']) for (let dir = 0; dir < 2; dir++)
    for (let k = 0; k < pz.stops.length - 1; k++) {
      const r = ratioSeg(pz, key, dir, k); const ll = res.linee[pz.line.id];
      if (key === 'peak') ll.maxRatio = Math.max(ll.maxRatio, r); else ll.maxRatioOff = Math.max(ll.maxRatioOff, r);
    }

  let riders = 0, persi = 0, pot = 0, affW = 0, sumW = 0, sumX = 0, ricavi = 0;
  for (const vr of varianti) {
    pot += vr.stPot;
    for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) {
      const f = vr.stOD[a * S + b]; if (!f) continue;
      let maxR = 0;
      percorso(vr, a, b, (v, nx) => {
        if (nx < 0) return;
        const nv = nodes[v], nn = nodes[nx]; if (nv.r !== nn.r) return;
        const [k0, k1, dir] = tratti(nv, nn);
        for (let k = k0; k < k1; k++) maxR = Math.max(maxR, ratioSeg(nv.r.pz, vr.key, dir, k));
      });
      const g = f * (maxR > 1 ? 1 / maxR : 1);
      const euro = g * prezzi[a * S + b];
      riders += g; persi += f - g; affW += g * Math.min(maxR, 1.5); ricavi += euro;
      res.stazioni[sids[a]].ingressi += g;
      const usate = new Set();
      percorso(vr, a, b, v => {
        const nv = nodes[v]; const pv = vr.PREV[a][v];
        if (pv < 0 || nodes[pv].r !== nv.r) {
          res.percorsi[nv.r.id].saliti += g; usate.add(nv.r.line.id);
          if (pv >= 0) res.stazioni[nv.sid].trasbordi += g;
          res.linee[nv.r.line.id].saliti += g;
        }
      });
      for (const lid of usate) res.linee[lid].ricavi += euro / usate.size;
      sumW += g * vr.W[a * S + b]; sumX += g * (vr.B[a * S + b] - 1);
    }
  }
  res.riders = riders; res.persi = persi; res.potenziale = pot; res.ricavi = ricavi;
  res.prezzoMedio = riders ? ricavi / riders : 0;
  res.ratio = costi ? ricavi / costi : 0;
  res.attesa = riders ? sumW / riders : 0;
  res.trasbordi = riders ? sumX / riders : 0;
  res.affoll = riders ? affW / riders : 0;
  res.quotaPersi = (riders + persi) ? persi / (riders + persi) : 0;
  const cl = x => Math.max(0, Math.min(100, x));
  res.q = {
    attesa: cl(100 - (res.attesa - 2) * 10),
    trasbordi: cl(100 - res.trasbordi * 70),
    affollamento: cl(100 - Math.max(0, res.affoll - 0.7) * 160),
    persi: cl(100 - res.quotaPersi * 400),
  };
  res.qualita = riders > 0 ? Math.round((res.q.attesa + res.q.trasbordi + res.q.affollamento + res.q.persi) / 4) : 0;
  res.modi = quoteModali(C, riders);
  return res;
}

function quoteModali(C, metro) {
  const k = Math.max(0, 1 - metro / C.totTrips);
  const out = {};
  for (const m of MODI) out[m] = C.modeTot[m] * k / C.totTrips;
  out.metro = metro / C.totTrips;
  return out;
}

if (typeof module !== 'undefined') module.exports = { TIPI, PIANI, distKm, costruisciCitta, calcolaRete, parametriLinea, raggioCitta };
