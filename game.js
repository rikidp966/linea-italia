// ===== Linea Italia — mappa, interfaccia e ciclo di gioco =====
'use strict';

const COLORI = ['#e2231a', '#00843d', '#f2b400', '#0067b1', '#8b4ba8', '#f07f1a', '#00a3a6', '#a0522d', '#e75ca8', '#5b6770', '#7cb518', '#1d3557'];
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TEMI = { chiaro: [TILE_URL, 'Chiaro'], colori: [TILE_URL, 'A colori'], scuro: [TILE_URL, 'Notte'] };
const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const G = {
  city: null, C: null, res: null,
  stations: {}, lines: [], tratte: {}, nextId: 1,
  modo: 'cantieri', cassa: 0, tariffe: null, prestiti: [],
  day: 1, minute: 6 * 60, speed: 1, history: [], achievements: {},
  sel: { line: null, station: null, end: 'end' },
  undo: [], overlays: { densita: false, copertura: false, zone: false }, tema: 'chiaro', tab: 'costruisci',
};

// ---------- Mappa ----------
const map = L.map('map', { zoomControl: false, doubleClickZoom: false }).setView([42.5, 12.5], 6);
L.control.zoom({ position: 'bottomright' }).addTo(map);
let tiles = L.tileLayer(TEMI.chiaro[0], { attribution: ATTRIB, maxZoom: 19 }).addTo(map);
const canvasR = L.canvas({ padding: 0.3 });
const layerDens = L.layerGroup().addTo(map);
const layerZone = L.layerGroup().addTo(map);
const layerCop = L.layerGroup().addTo(map);
const layerLines = L.layerGroup().addTo(map);
const layerTrains = L.layerGroup().addTo(map);
const layerSt = L.layerGroup().addTo(map);
map.createPane('trainsPane').style.zIndex = 450;
map.on('zoomend', () => map.getContainer().classList.toggle('zoom-lo', map.getZoom() < 13));
map.getContainer().classList.add('zoom-lo');

// ---------- Utilità ----------
const $ = s => document.querySelector(s);
const fmt = n => Math.round(n).toLocaleString('it-IT');
const fmtK = n => n >= 1e6 ? (n / 1e6).toLocaleString('it-IT', { maximumFractionDigits: 2 }) + ' mln' : n >= 1e4 ? Math.round(n / 1000).toLocaleString('it-IT') + 'k' : fmt(n);
const mln = m => '€ ' + (Math.abs(m) >= 1000 ? (m / 1000).toLocaleString('it-IT', { maximumFractionDigits: 2 }) + ' mld' : m.toLocaleString('it-IT', { maximumFractionDigits: m < 10 ? 1 : 0 }) + ' mln');
const euro = x => '€ ' + x.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = x => Math.round(x * 100) + '%';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, ms = 2800) {
  const t = $('#toast'); t.innerHTML = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms);
}
function loading(txt) { $('#loadingTxt').textContent = txt || ''; $('#loading').classList.toggle('on', !!txt); }
const conCantieri = () => G.modo === 'cantieri';
const finanziamentoGiorno = () => G.city.pop * 10 / 1e6;   // milioni di € al giorno dallo Stato e dalla Regione
const cassaIniziale = () => Math.round(G.city.pop * 0.003); // milioni di €
function tariffeDefault() { const R = G.C.R; return { modo: 'zone', anelli: [+(R * 0.3).toFixed(1), +(R * 0.6).toFixed(1)], prezzi: [1.5, 2.0, 2.6] }; }

// ---------- Salvataggio ----------
const saveKey = () => 'lineaitalia:save:v1:' + G.city.id;
function salva() {
  if (!G.city) return;
  try {
    localStorage.setItem(saveKey(), JSON.stringify({
      stations: G.stations, lines: G.lines, tratte: G.tratte, nextId: G.nextId, day: G.day, minute: G.minute,
      history: G.history, achievements: G.achievements, modo: G.modo, cassa: G.cassa, tariffe: G.tariffe, prestiti: G.prestiti,
    }));
  } catch (e) {}
}
function carica() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(saveKey()) || 'null'); } catch (e) {}
  G.stations = d?.stations || {}; G.lines = d?.lines || []; G.tratte = d?.tratte || {}; G.nextId = d?.nextId || 1;
  G.day = d?.day || 1; G.minute = d?.minute ?? 6 * 60; G.history = d?.history || []; G.achievements = d?.achievements || {};
  G.modo = d ? (d.modo || 'libero') : 'cantieri';   // le vecchie partite restano in modalità libera
  G.cassa = d?.cassa ?? cassaIniziale();
  G.tariffe = d?.tariffe || tariffeDefault();
  G.prestiti = d?.prestiti || [];
  for (const l of G.lines) l.services = l.services || [];
  G.sel = { line: null, station: null, end: 'end' }; G.undo = [];
}
function snapshot() {
  G.undo.push(JSON.stringify({ stations: G.stations, lines: G.lines, nextId: G.nextId, tratte: G.tratte, cassa: G.cassa }));
  if (G.undo.length > 40) G.undo.shift();
}
function ripristina(s) {
  const d = JSON.parse(s); G.stations = d.stations; G.lines = d.lines; G.nextId = d.nextId; G.tratte = d.tratte; G.cassa = d.cassa;
  if (!G.lines.find(l => l.id === G.sel.line)) G.sel.line = null;
  if (!G.stations[G.sel.station]) G.sel.station = null;
}
function annulla() {
  const s = G.undo.pop(); if (!s) return toast('Niente da annullare');
  ripristina(s); cambiato();
}

// ---------- Scelta della città ----------
function cittaRecenti() { try { return JSON.parse(localStorage.getItem('lineaitalia:altre') || '[]'); } catch (e) { return []; } }
function haSalvataggio(id) { try { return !!localStorage.getItem('lineaitalia:save:v1:' + id); } catch (e) { return false; } }

function mostraCitta(filtro = '') {
  const f = filtro.trim().toLowerCase();
  const tutte = [...cittaRecenti(), ...CITTA];
  const list = tutte.filter(c => !f || c.nome.toLowerCase().includes(f) || (c.regione || '').toLowerCase().includes(f));
  $('#cityList').innerHTML = list.map(c => `<button class="cityItem" data-id="${esc(c.id)}">
      <b>${esc(c.nome)}</b><small>${esc(c.regione || '')} · ${fmtK(c.pop)} ab.</small>
      ${haSalvataggio(c.id) ? '<span class="badge">In corso</span>' : ''}</button>`).join('')
    || `<p class="muted">Nessuna città in elenco: premi <b>Cerca su OpenStreetMap</b> per trovare qualsiasi comune italiano.</p>`;
  $('#cityList').querySelectorAll('.cityItem').forEach(b => b.onclick = () => {
    const c = tutte.find(x => x.id === b.dataset.id); if (c) avviaCitta(c);
  });
}
$('#citySearch').addEventListener('input', e => mostraCitta(e.target.value));
$('#citySearch').addEventListener('keydown', e => { if (e.key === 'Enter') cercaOnline(); });
$('#cityOnline').onclick = cercaOnline;
$('#btnCity').onclick = () => { $('#cityModal').classList.add('on'); mostraCitta($('#citySearch').value); };

async function cercaOnline() {
  const q = $('#citySearch').value.trim(); if (q.length < 2) return toast('Scrivi il nome di un comune');
  $('#cityList').innerHTML = '<p class="muted">Cerco su OpenStreetMap…</p>';
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=it&addressdetails=1&extratags=1&limit=10&featureType=city&q=' + encodeURIComponent(q);
    const data = await (await fetch(url, { headers: { 'Accept-Language': 'it' } })).json();
    const out = data.map(d => ({
      id: 'osm-' + d.osm_type + d.osm_id,
      nome: d.name || d.display_name.split(',')[0],
      regione: d.address?.state || d.address?.county || '',
      lat: +d.lat, lon: +d.lon,
      pop: Math.max(5000, parseInt((d.extratags?.population || '').replace(/\D/g, '')) || 30000),
    }));
    if (!out.length) { $('#cityList').innerHTML = '<p class="muted">Nessun risultato. Prova a scrivere il nome in un altro modo.</p>'; return; }
    $('#cityList').innerHTML = out.map((c, i) => `<button class="cityItem" data-i="${i}"><b>${esc(c.nome)}</b><small>${esc(c.regione)} · ${fmtK(c.pop)} ab.</small></button>`).join('');
    $('#cityList').querySelectorAll('.cityItem').forEach(b => b.onclick = () => {
      const c = out[+b.dataset.i];
      const rec = cittaRecenti().filter(x => x.id !== c.id); rec.unshift(c);
      try { localStorage.setItem('lineaitalia:altre', JSON.stringify(rec.slice(0, 12))); } catch (e) {}
      avviaCitta(c);
    });
  } catch (e) {
    $('#cityList').innerHTML = '<p class="muted">Ricerca non riuscita: controlla la connessione e riprova.</p>';
  }
}

async function avviaCitta(city) {
  $('#cityModal').classList.remove('on');
  loading(`Scarico quartieri, stazioni, ospedali e università di ${city.nome} da OpenStreetMap…`);
  const osm = await scaricaDatiOSM(city);
  loading(`Calcolo dove vivono e dove vanno gli abitanti di ${city.nome}…`);
  await new Promise(r => setTimeout(r, 30));
  G.city = city; G.C = costruisciCitta(city, osm);
  carica();
  loading('');
  $('#cityLbl').textContent = city.nome;
  map.setView([city.lat, city.lon], G.C.R > 10 ? 12 : 13);
  if (!osm) toast('Dati dei quartieri non disponibili ora: uso un modello semplificato della città.', 5000);
  else if (!G.lines.length) toast(conCantieri()
    ? `Hai ${mln(G.cassa)} per costruire. Tocca la mappa per aprire il primo cantiere.`
    : 'Tocca la mappa per piazzare la prima stazione della tua linea.', 5000);
  disegnaDensita(); disegnaZone(); aggiornaCassa(); cambiato(true);
  try { localStorage.setItem('lineaitalia:ultima', JSON.stringify(city)); } catch (e) {}
}

// ---------- Cantieri e budget ----------
function tratteRichieste() {
  const m = new Map();
  for (const l of G.lines) for (const seq of sequenze(l)) for (let k = 0; k < seq.length - 1; k++) m.set(chiaveTratta(seq[k], seq[k + 1]), [seq[k], seq[k + 1]]);
  return m;
}
function preventivo() {
  let spesa = 0; const nuoveSt = [], nuoveTr = [];
  for (const s of Object.values(G.stations)) if (!s.pagata) { spesa += CANTIERE[s.platform].stazione; nuoveSt.push(s); }
  const req = tratteRichieste();
  for (const [k, [a, b]] of req) if (!G.tratte[k]) {
    const ct = costoTratta(G.stations[a], G.stations[b]); spesa += ct.costo; nuoveTr.push([k, ct]);
  }
  return { spesa, nuoveSt, nuoveTr, req };
}
// Paga e apre i cantieri della modifica appena fatta. false = fondi insufficienti.
function applicaCantieri() {
  if (!conCantieri()) return true;
  const p = preventivo();
  if (p.spesa > G.cassa + 1e-6) { applicaCantieri.mancano = p.spesa; return false; }
  G.cassa -= p.spesa;
  for (const s of p.nuoveSt) {
    const c = CANTIERE[s.platform];
    s.pagata = true; s.cantiere = { giorni: c.giorniStazione, totale: c.giorniStazione, costo: c.stazione };
  }
  for (const [k, ct] of p.nuoveTr) G.tratte[k] = { giorni: ct.giorni, totale: ct.giorni, costo: ct.costo, km: ct.km, piano: ct.piano };
  for (const k of Object.keys(G.tratte)) if (!p.req.has(k)) delete G.tratte[k];
  if (p.spesa > 0.01) toast(`Cantiere aperto: ${mln(p.spesa)}. In cassa restano ${mln(G.cassa)}.`, 2200);
  return true;
}
// ---------- Prestiti ----------
const DURATE = [
  { giorni: 365, nome: '1 anno', tasso: 3.0 },
  { giorni: 730, nome: '2 anni', tasso: 3.8 },
  { giorni: 1825, nome: '5 anni', tasso: 5.0 },
];
const debitoMax = () => Math.round(cassaIniziale() * 1.5);
const debito = () => G.prestiti.reduce((s, p) => s + p.residuo, 0);
const rateGiorno = () => G.prestiti.reduce((s, p) => s + p.rata, 0);
// più sei indebitato, più la banca chiede interessi
function tassoOfferto(d, importo) { return +(d.tasso + 3 * (debito() + importo) / debitoMax()).toFixed(2); }
function importiPrestito() {
  const b = cassaIniziale();
  return [0.1, 0.25, 0.5, 1].map(f => { const x = b * f; const p = Math.pow(10, Math.floor(Math.log10(x))); return Math.max(1, Math.round(x / p * 2) / 2 * p); });
}
function rataPrestito(capitale, tassoAnnuo, giorni) {
  const i = tassoAnnuo / 100 / 365;
  return capitale * i / (1 - Math.pow(1 + i, -giorni));
}
function chiediPrestito(importo, d) {
  if (debito() + importo > debitoMax() + 1e-6) return toast(`La banca non presta oltre ${mln(debitoMax())} in tutto: hai già ${mln(debito())} di debiti.`, 3500);
  const tasso = tassoOfferto(d, importo);
  const rata = rataPrestito(importo, tasso, d.giorni);
  if (!confirm(`Prestito di ${mln(importo)} in ${d.nome} al ${tasso.toLocaleString('it-IT')}% annuo.\nRata: ${mln(rata)} al giorno per ${d.giorni} giorni, in tutto ${mln(rata * d.giorni)}.\nConfermi?`)) return;
  G.prestiti.push({ id: nuovoId('p'), capitale: importo, residuo: importo, tasso, rata, giorni: d.giorni, giorniRimasti: d.giorni, dal: G.day });
  G.cassa += importo;
  G.undo = []; // i soldi presi in prestito non si possono "annullare"
  aggiornaCassa(); pannelloCantieri(); salva();
  toast(`🏦 Ricevuti ${mln(importo)}. Rata: ${mln(rata)} al giorno.`, 3500);
}
function estinguiPrestito(id) {
  const p = G.prestiti.find(x => x.id === id); if (!p) return;
  const penale = p.residuo * 0.01;
  const tot = p.residuo + penale;
  if (tot > G.cassa) return toast(`Per chiuderlo servono ${mln(tot)}: in cassa hai ${mln(G.cassa)}.`);
  if (!confirm(`Chiudere subito il prestito pagando ${mln(p.residuo)} più l'1% di penale (${mln(penale)})?`)) return;
  G.cassa -= tot; G.prestiti = G.prestiti.filter(x => x !== p); G.undo = [];
  aggiornaCassa(); pannelloCantieri(); salva(); toast('Prestito estinto.');
}
function pagaRate() {
  let finiti = 0;
  for (const p of G.prestiti) {
    const interessi = p.residuo * p.tasso / 100 / 365;
    const quota = Math.min(p.rata, p.residuo + interessi);
    G.cassa -= quota;
    p.residuo = Math.max(0, p.residuo + interessi - quota);
    p.giorniRimasti--;
    if (p.giorniRimasti <= 0 || p.residuo < 0.001) { p.finito = true; finiti++; }
  }
  if (finiti) { G.prestiti = G.prestiti.filter(p => !p.finito); toast(`🏦 Hai finito di pagare ${finiti > 1 ? finiti + ' prestiti' : 'un prestito'}.`, 3000); }
  if (G.cassa < 0 && !pagaRate.avvisato) { pagaRate.avvisato = true; toast('⚠️ Sei in rosso: finché la cassa è negativa non puoi aprire cantieri.', 4500); }
  if (G.cassa >= 0) pagaRate.avvisato = false;
}

const stazioneAperta = sid => !G.stations[sid]?.cantiere;
const trattaAperta = (a, b) => !conCantieri() || (G.tratte[chiaveTratta(a, b)]?.giorni ?? 1) <= 0;
function trattaCostruita(sid) {
  return Object.entries(G.tratte).some(([k, t]) => t.giorni <= 0 && k.split('|').includes(sid));
}
function avanzaCantieri() {
  const aperte = [];
  for (const s of Object.values(G.stations)) if (s.cantiere) {
    s.cantiere.giorni--;
    if (s.cantiere.giorni <= 0) { s.cantiere = null; s.maturita = 0.3; s.nata = G.day; aperte.push(s.name); }
  }
  let tratte = 0;
  for (const t of Object.values(G.tratte)) if (t.giorni > 0) { t.giorni--; if (t.giorni <= 0) tratte++; }
  if (aperte.length) toast(`✂️ Inaugurata ${aperte.length > 1 ? 'le stazioni' : 'la stazione'} <b>${esc(aperte.slice(0, 3).join(', '))}</b>${aperte.length > 3 ? ' e altre' : ''}`, 4000);
  else if (tratte) toast(`Completati ${tratte} ${tratte > 1 ? 'tratti' : 'tratto'} di galleria o viadotto`, 2500);
}
function accelera(tipo, id) {
  const c = tipo === 's' ? G.stations[id]?.cantiere : G.tratte[id];
  if (!c || c.accel || c.giorni <= 1) return;
  const prezzo = c.costo * 0.5;
  if (prezzo > G.cassa) return toast(`Servono ${mln(prezzo)}: in cassa hai ${mln(G.cassa)}.`);
  G.cassa -= prezzo; c.giorni = Math.ceil(c.giorni / 2); c.accel = true;
  G.undo = []; aggiornaCassa(); pannelloCantieri(); ridisegna(); salva();
  toast(`Turni doppi in cantiere: ${mln(prezzo)}, tempi dimezzati.`);
}
function cambiaModo(m) {
  if (m === G.modo) return;
  if (m === 'cantieri') {
    // tutto ciò che esiste già si considera costruito
    for (const s of Object.values(G.stations)) { s.pagata = true; s.cantiere = null; }
    G.tratte = {};
    for (const [k, [a, b]] of tratteRichieste()) { const ct = costoTratta(G.stations[a], G.stations[b]); G.tratte[k] = { giorni: 0, totale: ct.giorni, costo: ct.costo, km: ct.km, piano: ct.piano }; }
    G.cassa = cassaIniziale(); G.prestiti = [];
  } else {
    for (const s of Object.values(G.stations)) { if (s.cantiere) s.maturita = 0.3; s.cantiere = null; s.pagata = true; }
    for (const t of Object.values(G.tratte)) t.giorni = 0;
  }
  G.modo = m; G.undo = []; aggiornaCassa(); cambiato(true);
}

// ---------- Modifica della rete ----------
function nuovoId(p = 's') { return p + (G.nextId++); }
function linea(id) { return G.lines.find(l => l.id === id); }
// Le fermate di una linea: il tronco più una sequenza per ogni diramazione (che parte dalla stazione di innesto)
function sequenze(l) { return [l.stops, ...(l.rami || []).map(r => [r.da, ...r.stops])]; }
function fermateLinea(l) { return new Set(sequenze(l).flat()); }
function ramo(l, id) { return (l?.rami || []).find(r => r.id === id); }
function lineeDi(sid) { return G.lines.filter(l => fermateLinea(l).has(sid)); }
// Per il motore ogni diramazione è una linea "virtuale": dal capolinea scelto lungo il tronco fino all'innesto, poi sul ramo
function lineaRamo(l, r) {
  const j = l.stops.indexOf(r.da); if (j < 0 || !r.stops.length) return null;
  const tronco = r.verso === 'start' ? l.stops.slice(0, j + 1) : l.stops.slice(j).reverse();
  return { id: l.id + '~' + r.id, famiglia: l.id, name: l.name, color: l.color, type: l.type, offpeak: l.offpeak, trains: r.trains, stops: [...tronco, ...r.stops], services: [] };
}
function lineeSim() {
  const out = [];
  for (const l of G.lines) { out.push(l); for (const r of l.rami || []) { const v = lineaRamo(l, r); if (v) out.push(v); } }
  return out;
}
// toglie diramazioni rimaste senza innesto o senza fermate, e le stazioni non più usate da nessuna linea
function pulisciRami() {
  for (const l of G.lines) l.rami = (l.rami || []).filter(r => l.stops.includes(r.da) && r.stops.length);
  G.lines = G.lines.filter(l => l.stops.length);
  const usate = new Set(G.lines.flatMap(l => [...fermateLinea(l)]));
  for (const sid of Object.keys(G.stations)) if (!usate.has(sid)) delete G.stations[sid];
  if (!linea(G.sel.line)) { G.sel.line = null; G.sel.ramo = null; }
  if (G.sel.ramo && !ramo(linea(G.sel.line), G.sel.ramo)) G.sel.ramo = null;
  if (!G.stations[G.sel.station]) G.sel.station = null;
}
function creaRamo(l, sid) {
  const j = l.stops.indexOf(sid); if (j <= 0 || j >= l.stops.length - 1) return;
  snapshot();
  const r = { id: nuovoId('r'), da: sid, stops: [], verso: j >= l.stops.length - 1 - j ? 'start' : 'end', trains: 4 };
  l.rami = l.rami || []; l.rami.push(r);
  G.sel.ramo = r.id; G.sel.station = sid;
  ridisegna(); pannelloCostruisci();
  toast(`Diramazione da ${esc(G.stations[sid].name)}: tocca la mappa per tracciarla.`, 3500);
}

function nomeStazione(lat, lon) {
  const usati = new Set(Object.values(G.stations).map(s => s.name));
  const cand = [...G.C.places, ...G.C.attr].filter(p => p.name)
    .map(p => ({ name: p.name, d: distKm({ lat, lon }, p) })).filter(p => p.d < 1.5).sort((a, b) => a.d - b.d);
  for (const c of cand) if (!usati.has(c.name)) return c.name;
  if (cand.length) for (const suf of ['Nord', 'Sud', 'Est', 'Ovest', '2', '3', '4']) { const n = cand[0].name + ' ' + suf; if (!usati.has(n)) return n; }
  let k = 1; while (usati.has('Stazione ' + k)) k++; return 'Stazione ' + k;
}

function creaLinea() {
  const usati = new Set(G.lines.map(l => l.color));
  const color = COLORI.find(c => !usati.has(c)) || COLORI[G.lines.length % COLORI.length];
  let n = 1; while (G.lines.find(l => l.name === 'M' + n)) n++;
  const l = { id: nuovoId('l'), name: 'M' + n, color, type: G.city.pop < 250000 ? 'leggera' : 'pesante', trains: 4, offpeak: 60, stops: [], services: [] };
  G.lines.push(l); G.sel.line = l.id; G.sel.end = 'end';
  return l;
}
function aggiungiFermata(l, sid) {
  if (l.stops.includes(sid)) return false;
  if (G.sel.end === 'start') l.stops.unshift(sid); else l.stops.push(sid);
  return true;
}
function nuovaStazione(lat, lon, platform) {
  const sid = nuovoId();
  G.stations[sid] = { id: sid, lat, lon, name: nomeStazione(lat, lon), platform, maturita: 0.3, nata: G.day, pagata: !conCantieri() };
  nomeDaVia(sid);
  return sid;
}

// ---------- Nomi delle stazioni dalla via più vicina (OpenStreetMap / Nominatim) ----------
// Il nome del quartiere arriva subito; appena risponde il servizio lo sostituisce la via o la piazza più vicina.
// Le stazioni rinominate a mano non vengono mai toccate. Una richiesta al secondo, come chiede Nominatim.
const nomiDaVie = () => { try { return localStorage.getItem('lineaitalia:nomi') !== 'quartiere'; } catch (e) { return true; } };
const codaNomi = []; let codaAttiva = false;
function nomeDaVia(sid) {
  if (!nomiDaVie() || codaNomi.includes(sid)) return;
  codaNomi.push(sid);
  if (!codaAttiva) processaCodaNomi();
}
function nomeUnico(n, sid) {
  const usati = new Set(Object.values(G.stations).filter(s => s.id !== sid).map(s => s.name));
  if (!usati.has(n)) return n;
  for (let k = 2; k < 20; k++) if (!usati.has(n + ' ' + k)) return n + ' ' + k;
  return n;
}
async function processaCodaNomi() {
  codaAttiva = true;
  while (codaNomi.length) {
    const sid = codaNomi.shift(); const s = G.stations[sid];
    if (!s || s.nomeManuale) continue;
    const lat = s.lat, lon = s.lon;
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&addressdetails=1&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`;
      const d = await (await fetch(url, { headers: { 'Accept-Language': 'it' } })).json();
      const a = d.address || {};
      const via = a.square || a.road || a.pedestrian || a.footway || a.cycleway || a.path;
      const st = G.stations[sid];
      // se nel frattempo è stata spostata, rinominata o cancellata, la risposta non vale più
      if (via && st && !st.nomeManuale && st.lat === lat && st.lon === lon) {
        st.name = nomeUnico(via, sid); st.nomeVia = true;
        ridisegna(); pannelloCostruisci(); salva();
      }
    } catch (e) { /* senza rete resta il nome del quartiere */ }
    await new Promise(r => setTimeout(r, 1100));
  }
  codaAttiva = false;
}

map.on('click', e => {
  if (!G.city) return;
  snapshot();
  let l = linea(G.sel.line);
  if (!l) l = creaLinea();
  const sid = nuovaStazione(e.latlng.lat, e.latlng.lng, l.type === 'leggera' ? 'raso' : 'sotterranea');
  const r = ramo(l, G.sel.ramo);
  if (r) r.stops.push(sid); else aggiungiFermata(l, sid);
  G.sel.station = sid;
  cambiato();
});

function clickStazione(sid) {
  const l = linea(G.sel.line);
  const r = ramo(l, G.sel.ramo);
  if (r && sid !== r.da && !r.stops.includes(sid) && !l.stops.includes(sid) && G.sel.station !== sid) {
    snapshot(); r.stops.push(sid); G.sel.station = sid; cambiato(); return;
  }
  if (!r && l && !fermateLinea(l).has(sid) && G.sel.station !== sid) {
    snapshot(); aggiungiFermata(l, sid); G.sel.station = sid; cambiato(); return;
  }
  // toccando l'ultima fermata di una diramazione la si riprende per allungarla
  if (l && !r) { const rr = (l.rami || []).find(x => x.stops[x.stops.length - 1] === sid); if (rr) { G.sel.ramo = rr.id; G.sel.station = sid; ridisegna(); pannelloCostruisci(); return; } }
  if (l && l.stops.length > 1) {
    if (l.stops[0] === sid) G.sel.end = 'start';
    else if (l.stops[l.stops.length - 1] === sid) G.sel.end = 'end';
  }
  G.sel.station = sid;
  if (!l) { const ls = lineeDi(sid); if (ls.length === 1) G.sel.line = ls[0].id; }
  ridisegna(); pannelloCostruisci(); vaiTab('costruisci');
}
function rinominaStazione(sid) {
  const s = G.stations[sid]; if (!s) return;
  const n = prompt('Nuovo nome della stazione', s.name);
  if (n && n.trim()) { s.name = n.trim().slice(0, 40); s.nomeManuale = true; cambiato(); }
}

function inserisciSuTratto(l, latlng) {
  // cerca il tratto più vicino sul tronco o sulle diramazioni
  const p = map.latLngToLayerPoint(latlng);
  let best = null, bd = Infinity;
  sequenze(l).forEach((seq, si) => {
    for (let k = 0; k < seq.length - 1; k++) {
      const a = G.stations[seq[k]], b = G.stations[seq[k + 1]];
      const d = L.LineUtil.pointToSegmentDistance(p, map.latLngToLayerPoint([a.lat, a.lon]), map.latLngToLayerPoint([b.lat, b.lon]));
      if (d < bd) { bd = d; best = { si, k, a: seq[k], b: seq[k + 1] }; }
    }
  });
  if (!best) return;
  snapshot();
  const { a, b } = best;
  const sid = nuovaStazione(latlng.lat, latlng.lng, G.stations[a].platform);
  // se la galleria esiste già, i due nuovi tratti la riusano: si paga solo la stazione
  const vecchia = G.tratte[chiaveTratta(a, b)];
  const usanoTratta = G.lines.flatMap(sequenze).filter(seq => seq.some((s, k) => k && chiaveTratta(seq[k - 1], s) === chiaveTratta(a, b))).length;
  if (conCantieri() && vecchia && usanoTratta === 1) {
    G.tratte[chiaveTratta(a, sid)] = { ...vecchia, costo: vecchia.costo / 2 };
    G.tratte[chiaveTratta(sid, b)] = { ...vecchia, costo: vecchia.costo / 2 };
  }
  if (best.si === 0) l.stops.splice(best.k + 1, 0, sid);
  else l.rami[best.si - 1].stops.splice(best.k, 0, sid); // nella sequenza del ramo la posizione 0 è l'innesto
  G.sel.station = sid;
  cambiato();
}
function rimuoviDaLinea(l, sid) {
  snapshot();
  l.stops = l.stops.filter(s => s !== sid);
  for (const r of l.rami || []) r.stops = r.stops.filter(s => s !== sid);
  pulisciRami();
  cambiato();
}
function eliminaStazione(sid) {
  snapshot();
  for (const l of G.lines) { l.stops = l.stops.filter(s => s !== sid); for (const r of l.rami || []) r.stops = r.stops.filter(s => s !== sid); }
  delete G.stations[sid];
  pulisciRami();
  cambiato();
}
function eliminaLinea(l) {
  snapshot();
  G.lines = G.lines.filter(x => x !== l);
  G.sel.line = null; G.sel.ramo = null;
  pulisciRami();
  cambiato();
}
function eliminaRamo(l, r) {
  snapshot();
  l.rami = l.rami.filter(x => x !== r);
  if (G.sel.ramo === r.id) G.sel.ramo = null;
  pulisciRami();
  cambiato();
}

// ---------- Ricalcolo ----------
let ricalcoloT = null;
function cambiato(subito) {
  if (!applicaCantieri()) {
    const s = G.undo.pop(); if (s) ripristina(s);
    toast(`Fondi insufficienti: servono ${mln(applicaCantieri.mancano)}, in cassa hai ${mln(G.cassa)}.`, 3500);
  }
  aggiornaCassa(); ridisegna(); pannelloCostruisci(); if (G.tab === 'cantieri') pannelloCantieri();
  clearTimeout(ricalcoloT);
  ricalcoloT = setTimeout(() => { ricalcola(); salva(); }, subito ? 0 : 200);
}
function ricalcola() {
  if (!G.C) return;
  // finché il giocatore non tocca i treni, la linea ne riceve abbastanza per passare ogni ~5 minuti
  for (const l of G.lines) if (l.autoTreni !== false && l.stops.length > 1) {
    const lp = parametriLinea(l, G.stations); l.trains = Math.max(2, Math.ceil(lp.cycle / 5));
  }
  // diramazioni: in automatico un treno ogni ~10 minuti, così sul tronco comune si sommano ai treni della linea
  for (const l of G.lines) for (const r of l.rami || []) if (r.autoTreni !== false) {
    const v = lineaRamo(l, r); if (v) r.trains = Math.max(2, Math.ceil(parametriLinea(v, G.stations).cycle / 10));
  }
  G.res = calcolaRete(G.C, G.stations, lineeSim(), {
    tariffe: G.tariffe, centro: G.city, stazioneAperta, trattaAperta,
  });
  // i risultati delle diramazioni si sommano alla linea madre
  G.res.rami = {};
  for (const l of G.lines) for (const r of l.rami || []) {
    const v = G.res.linee[l.id + '~' + r.id], m = G.res.linee[l.id]; if (!v || !m) continue;
    G.res.rami[r.id] = { ...v, LP: G.res.LP[l.id + '~' + r.id] };
    m.saliti += v.saliti; m.ricavi += v.ricavi; m.costo += v.costo; m.aperta = m.aperta || v.aperta;
    m.maxRatio = Math.max(m.maxRatio, v.maxRatio); m.maxRatioOff = Math.max(m.maxRatioOff, v.maxRatioOff); m.saturo = m.saturo || v.saturo;
  }
  aggiornaKpi(); ridisegna(); pannelloCostruisci(); controllaSfide();
  if (G.tab === 'statistiche') pannelloStatistiche();
  if (G.tab === 'tariffe') risultatiTariffe();
  if (G.tab === 'cantieri') pannelloCantieri();
}

// ---------- Disegno ----------
function disegnaDensita() {
  layerDens.clearLayers();
  if (!G.overlays.densita || !G.C) return;
  const max = Math.max(...G.C.zones.map(z => z.pop));
  const maxJ = Math.max(...G.C.zones.map(z => z.jobs));
  const dLat = G.C.cell / 222.6;
  for (const z of G.C.zones) {
    const a = Math.min(1, z.pop / max), b = Math.min(1, z.jobs / maxJ);
    if (a < 0.03 && b < 0.03) continue;
    const dLon = G.C.cell / (222.6 * Math.cos(z.lat * Math.PI / 180));
    L.rectangle([[z.lat - dLat, z.lon - dLon], [z.lat + dLat, z.lon + dLon]], {
      renderer: canvasR, stroke: false, interactive: false,
      fillColor: b > a ? '#2a6fdb' : '#e85d3a', fillOpacity: 0.08 + 0.42 * Math.max(a, b),
    }).addTo(layerDens);
  }
}
function disegnaZone() {
  layerZone.clearLayers();
  if (!G.city || !G.tariffe || G.tariffe.modo !== 'zone' || !(G.overlays.zone || G.tab === 'tariffe')) return;
  const col = ['#7a4fd0', '#c0392b'];
  G.tariffe.anelli.forEach((r, i) => {
    L.circle([G.city.lat, G.city.lon], { radius: r * 1000, interactive: false, color: col[i % 2], weight: 2, dashArray: '8 6', fill: false }).addTo(layerZone);
    L.marker([G.city.lat + r / 111.32, G.city.lon], { interactive: false, icon: L.divIcon({ className: 'zonaLbl', html: `Zona ${i + 1} | Zona ${i + 2}`, iconSize: [110, 18], iconAnchor: [55, 9] }) }).addTo(layerZone);
  });
}
function disegnaCopertura() {
  layerCop.clearLayers();
  if (!G.overlays.copertura) return;
  for (const s of Object.values(G.stations)) {
    if (s.cantiere || !lineeDi(s.id).some(l => l.stops.length > 1)) continue;
    L.circle([s.lat, s.lon], { radius: 800, renderer: canvasR, interactive: false, color: '#0a7', weight: 1, fillColor: '#0a7', fillOpacity: 0.08 }).addTo(layerCop);
  }
}

function ridisegna() {
  layerLines.clearLayers(); layerSt.clearLayers();
  const selL = G.sel.line;
  for (const l of G.lines) {
    const isSel = l.id === selL;
    const r = G.res?.linee[l.id];
    const crowd = r ? Math.max(r.maxRatio, r.maxRatioOff) : 0;
    sequenze(l).forEach((seq, si) => {
      const pts = seq.map(id => [G.stations[id].lat, G.stations[id].lon]);
      if (pts.length < 2) return;
      const ramoId = si ? l.rami[si - 1].id : null;
      const ramoSel = isSel && G.sel.ramo && G.sel.ramo === ramoId;
      L.polyline(pts, { color: '#fff', weight: isSel ? 13 : 10, opacity: 0.9, interactive: false }).addTo(layerLines);
      const pl = L.polyline(pts, { color: l.color, weight: ramoSel ? 10 : isSel ? 8 : 6, opacity: selL && !isSel ? 0.45 : 1, bubblingMouseEvents: false, lineCap: 'round', lineJoin: 'round', className: crowd > 1 ? 'overload' : '' }).addTo(layerLines);
      pl.on('click', e => {
        L.DomEvent.stop(e);
        if (G.sel.line === l.id) inserisciSuTratto(l, e.latlng);
        else { G.sel.line = l.id; G.sel.ramo = null; G.sel.station = null; ridisegna(); pannelloCostruisci(); vaiTab('costruisci'); toast(`Linea ${esc(l.name)} selezionata. Tocca un tratto per inserire una fermata, o la mappa per allungarla.`); }
      });
      // tratti ancora in cantiere: tratteggio bianco sopra la linea
      if (conCantieri()) for (let k = 0; k < seq.length - 1; k++) {
        if (trattaAperta(seq[k], seq[k + 1])) continue;
        L.polyline([pts[k], pts[k + 1]], { color: '#fff', weight: isSel ? 5 : 3.5, dashArray: '6 8', interactive: false, opacity: 0.95 }).addTo(layerLines);
      }
    });
  }
  const l = linea(G.sel.line);
  const rs = ramo(l, G.sel.ramo);
  for (const s of Object.values(G.stations)) {
    const ls = lineeDi(s.id);
    const inter = ls.length > 1;
    const ing = G.res?.stazioni[s.id]?.ingressi || 0;
    const d = Math.round((inter ? 16 : 12) + Math.min(12, Math.sqrt(ing) / 12));
    const isSel = s.id === G.sel.station;
    const isEnd = rs ? (rs.stops.length ? rs.stops[rs.stops.length - 1] : rs.da) === s.id
      : l && l.stops.length > 1 && ((G.sel.end === 'end' && l.stops[l.stops.length - 1] === s.id) || (G.sel.end === 'start' && l.stops[0] === s.id));
    const html = `<div class="st ${inter ? 'inter' : ''} ${isSel ? 'sel' : ''} ${isEnd ? 'end' : ''} ${s.cantiere ? 'cant' : ''} p-${s.platform}" style="--c:${ls[0]?.color || '#333'}"></div>`;
    const spostabile = !conCantieri() || (s.cantiere && !trattaCostruita(s.id));
    const m = L.marker([s.lat, s.lon], {
      icon: L.divIcon({ className: 'stIcon', html, iconSize: [d, d], iconAnchor: [d / 2, d / 2] }),
      draggable: spostabile, autoPan: true, riseOnHover: true, zIndexOffset: isSel ? 1000 : inter ? 500 : 0,
    }).addTo(layerSt);
    const lbl = esc(s.name) + (s.cantiere ? ` <span class="cantLbl">🚧 ${s.cantiere.giorni} gg</span>` : '');
    m.bindTooltip(lbl, { permanent: true, direction: 'right', offset: [d / 2, 0], className: 'stLabel' + (isSel ? ' sel' : '') });
    m.on('click', e => { L.DomEvent.stop(e); clickStazione(s.id); });
    m.on('dblclick', e => { L.DomEvent.stop(e); rinominaStazione(s.id); });
    m.on('dragstart', () => snapshot());
    m.on('dragend', e => {
      const p = e.target.getLatLng(); s.lat = p.lat; s.lon = p.lng; G.sel.station = s.id;
      if (!s.nomeManuale) nomeDaVia(s.id);
      if (conCantieri()) {
        // la galleria verso una stazione spostata va riprogettata: si recupera quanto speso e si riparte
        for (const k of Object.keys(G.tratte)) if (k.split('|').includes(s.id) && G.tratte[k].giorni > 0) { G.cassa += G.tratte[k].costo; delete G.tratte[k]; }
      }
      cambiato();
    });
  }
  disegnaCopertura();
}

// ---------- Treni animati ----------
const treni = {};
function posizioneTreno(r, t) {
  // ciclo: andata, sosta 3 min, ritorno, sosta 3 min
  let tt;
  if (t < r.run) tt = t; else if (t < r.run + 3) tt = r.run; else if (t < 2 * r.run + 3) tt = r.run - (t - r.run - 3); else tt = 0;
  let acc = 0;
  for (let p = 0; p < r.hop.length; p++) {
    if (tt <= acc + r.hop[p] || p === r.hop.length - 1) {
      const f = Math.max(0, Math.min(1, (tt - acc - 0.3) / Math.max(0.01, r.hop[p] - 0.6)));
      // dentro il salto (che per un espresso attraversa più fermate) si avanza tratto per tratto
      const i0 = r.idx[p], i1 = r.idx[p + 1], pz = r.pz;
      let tot = 0; for (let k = i0; k < i1; k++) tot += pz.seg[k];
      let x = f * tot;
      for (let k = i0; k < i1; k++) {
        if (x <= pz.seg[k] || k === i1 - 1) {
          const a = G.stations[pz.stops[k]], b = G.stations[pz.stops[k + 1]]; if (!a || !b) return null;
          const g = Math.max(0, Math.min(1, x / pz.seg[k]));
          return [a.lat + (b.lat - a.lat) * g, a.lon + (b.lon - a.lon) * g];
        }
        x -= pz.seg[k];
      }
    }
    acc += r.hop[p];
  }
  return null;
}
function fascia(min) {
  const h = (min % 1440) / 60;
  if (h >= 1 && h < 5) return { nome: 'Servizio chiuso', k: 'chiuso' };
  if ((h >= 7 && h < 9.5) || (h >= 17 && h < 19.5)) return { nome: h < 12 ? 'Punta del mattino' : 'Punta della sera', k: 'punta' };
  return { nome: 'Fascia di morbida', k: 'morbida' };
}
function disegnaTreni() {
  if (!G.res) return;
  const fx = fascia(G.minute);
  const vivi = new Set();
  for (const r of G.res.routes) {
    if (r.pz.stops.some(id => !G.stations[id])) continue;
    const n = fx.k === 'chiuso' ? 0 : fx.k === 'punta' ? r.nPeak : r.nOff;
    const tipo = r.sv?.tipo;
    for (let i = 0; i < n; i++) {
      const key = r.id + ':' + i; vivi.add(key);
      const t = ((G.minute + i * r.cycle / n + (r.sv ? r.cycle / (2 * n) : 0)) % r.cycle + r.cycle) % r.cycle;
      const p = posizioneTreno(r, t); if (!p) continue;
      let m = treni[key];
      if (!m) m = treni[key] = L.circleMarker(p, {
        pane: 'trainsPane', radius: tipo === 'espresso' ? 5.5 : 4.5, weight: tipo === 'espresso' ? 3 : 2,
        color: tipo === 'espresso' ? '#111' : '#fff', dashArray: tipo === 'limitato' ? '2 2' : null,
        fillColor: r.line.color, fillOpacity: 1, interactive: false,
      }).addTo(layerTrains);
      m.setLatLng(p);
    }
  }
  for (const k of Object.keys(treni)) if (!vivi.has(k)) { layerTrains.removeLayer(treni[k]); delete treni[k]; }
}

// ---------- Orologio e giornate ----------
let ultimo = performance.now(), accDisegno = 0;
function ciclo(now) {
  const dt = Math.min(0.25, (now - ultimo) / 1000); ultimo = now;
  if (G.city && G.speed > 0) {
    const prima = G.minute;
    G.minute += dt * G.speed;
    if (Math.floor(G.minute / 1440) > Math.floor(prima / 1440)) nuovoGiorno();
  }
  accDisegno += dt;
  if (accDisegno > 1 / 30) { accDisegno = 0; disegnaTreni(); aggiornaOrologio(); }
  requestAnimationFrame(ciclo);
}
function aggiornaOrologio() {
  const m = Math.floor(G.minute % 1440);
  $('#timeLbl').textContent = String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  $('#dayLbl').textContent = 'Giorno ' + G.day;
  $('#phaseLbl').textContent = fascia(G.minute).nome;
}
function nuovoGiorno() {
  G.day++;
  const prima = G.res;
  for (const s of Object.values(G.stations)) if (!s.cantiere) s.maturita = Math.min(1, (s.maturita ?? 1) + (1 - (s.maturita ?? 1)) * 0.22);
  if (conCantieri()) {
    G.cassa += finanziamentoGiorno() + (prima ? (prima.ricavi - prima.costi) / 1e6 : 0);
    pagaRate();
    avanzaCantieri();
    G.undo = []; // dopo una giornata di lavori non si torna indietro
  }
  if (prima && prima.riders > 0) G.history.push({ day: G.day - 1, riders: Math.round(prima.riders), ratio: +prima.ratio.toFixed(3), q: prima.qualita });
  if (G.history.length > 120) G.history.shift();
  aggiornaCassa(); ricalcola(); salva();
}
document.querySelectorAll('#speeds button').forEach(b => b.onclick = () => { G.speed = +b.dataset.speed; aggiornaVelocita(); });
function aggiornaVelocita() { document.querySelectorAll('#speeds button').forEach(b => b.classList.toggle('on', +b.dataset.speed === G.speed)); }
aggiornaVelocita();

// ---------- Indicatori ----------
function aggiornaKpi() {
  const r = G.res; const ok = r && r.riders > 0;
  $('#kRiders').textContent = r ? fmtK(r.riders) : '0';
  $('#kRatio').textContent = ok ? pct(r.ratio) : '—';
  $('#kRatio').className = ok ? (r.ratio >= 0.7 ? 'good' : r.ratio >= 0.4 ? 'mid' : 'bad') : '';
  $('#kQual').textContent = ok ? r.qualita : '—';
  $('#kQual').className = ok ? (r.qualita >= 75 ? 'good' : r.qualita >= 50 ? 'mid' : 'bad') : '';
}
function aggiornaCassa() {
  const on = G.city && conCantieri();
  $('#kCassaBox').style.display = on ? '' : 'none';
  document.querySelector('[data-tab=cantieri]').style.display = on ? '' : 'none';
  if (on) { $('#kCassa').textContent = mln(G.cassa); $('#kCassa').className = G.cassa < 0 ? 'bad' : ''; }
}

// ---------- Pannello: costruisci ----------
function pannelloCostruisci() {
  const el = $('#tab-costruisci');
  if (!G.city) { el.innerHTML = '<p class="muted">Scegli una città per iniziare.</p>'; return; }
  const l = linea(G.sel.line);
  const s = G.stations[G.sel.station];
  let h = '';
  if (!G.lines.length) {
    h += `<div class="hint"><b>Come si gioca</b><ol>
      <li>Tocca la mappa: nasce la prima stazione di una nuova linea.</li>
      <li>Continua a toccare per aggiungere fermate in fila.</li>
      <li>Tocca una stazione di un'altra linea per creare un interscambio.</li>
      <li>Tocca un tratto della linea selezionata per inserire una fermata in mezzo; trascina le stazioni per spostarle.</li>
      <li>Le stazioni prendono il nome della via più vicina; doppio clic per rinominarle.</li>
      <li>Scegli quanti treni far girare: pochi lasciano la gente a terra, troppi fanno salire i costi.</li></ol>
      ${conCantieri() ? `<p>Stai giocando <b>con i cantieri</b>: ogni stazione e ogni galleria costa e richiede giorni di lavori. Hai ${mln(G.cassa)}; ogni giorno arrivano ${mln(finanziamentoGiorno())} di finanziamenti più i ricavi dei biglietti.</p>` : ''}
      <p>Attiva <b>Mappa → Densità</b> per vedere dove vivono (rosso) e dove lavorano (blu) gli abitanti.</p></div>`;
  }
  h += '<div class="lines">';
  for (const x of G.lines) {
    const r = G.res?.linee[x.id];
    const cant = conCantieri() && sequenze(x).some(q => q.some((sid, k) => G.stations[sid]?.cantiere || (k && !trattaAperta(q[k - 1], sid))));
    h += `<button class="lineRow ${x.id === G.sel.line ? 'on' : ''}" data-l="${x.id}">
      <span class="bullet" style="background:${x.color}">${esc(x.name)}</span>
      <span class="grow"><b>${fermateLinea(x).size} fermate${x.rami?.length ? ` · ${x.rami.length + 1} rami` : ''}${x.services?.length ? ` · ${x.services.length} corse extra` : ''}</b><small>${TIPI[x.type].nome}${r?.aperta ? ' · ' + fmtK(r.saliti) + ' saliti' : ''}${cant ? ' · 🚧 lavori in corso' : ''}</small></span>
      ${r && Math.max(r.maxRatio, r.maxRatioOff) > 1 ? '<span class="warn" title="Treni sovraffollati">!</span>' : ''}</button>`;
  }
  h += `</div><div class="row"><button id="bNew" class="primary">+ Nuova linea</button>
    <button id="bDesel" ${l || s ? '' : 'disabled'}>Deseleziona</button><button id="bUndo" ${G.undo.length ? '' : 'disabled'} title="Ctrl+Z">↶ Annulla</button></div>`;

  if (l) h += schedaLinea(l);
  if (s) h += schedaStazione(s, l);
  el.innerHTML = h;
  collegaCostruisci(l, s);
}

function schedaLinea(l) {
  const lp = G.res?.LP[l.id]; const r = G.res?.linee[l.id];
  const tutta = parametriLinea(l, G.stations);
  const capi = l.stops.length > 1 ? [G.stations[l.stops[0]].name, G.stations[l.stops[l.stops.length - 1]].name] : null;
  let h = `<div class="card" style="--c:${l.color}">
    <div class="cardHead"><input id="lName" value="${esc(l.name)}" maxlength="14" aria-label="Nome della linea"><div class="swatches">${COLORI.map(c => `<button class="sw ${c === l.color ? 'on' : ''}" data-c="${c}" style="background:${c}" aria-label="Colore"></button>`).join('')}</div></div>
    ${capi ? `<p class="small">Le nuove fermate si aggiungono dopo <b>${esc(G.sel.end === 'end' ? capi[1] : capi[0])}</b>. <button id="lSwap" class="link">Allunga dall'altro capolinea</button></p>` : '<p class="small">Tocca la mappa per piazzare la seconda fermata.</p>'}
    <label>Tipo di linea<select id="lType">${Object.entries(TIPI).map(([k, t]) => `<option value="${k}" ${k === l.type ? 'selected' : ''}>${t.nome} · ${t.cap} posti/treno</option>`).join('')}</select></label>
    <label>Treni in servizio nelle ore di punta
      <span class="stepper"><button id="tMinus">−</button><b>${l.trains}</b><button id="tPlus">+</button>
      ${l.autoTreni === false ? '<button id="tAuto" class="link">automatico</button>' : '<small>automatico: un treno ogni ~5 min</small>'}</span></label>
    <label>Treni nelle ore di morbida: <b>${l.offpeak}%</b><input id="lOff" type="range" min="20" max="100" step="5" value="${l.offpeak}"></label>`;
  if (lp && r) {
    h += `<div class="facts">
      <div><small>Lunghezza</small><b>${tutta.km.toFixed(1)} km</b>${conCantieri() && lp.kmAperti < tutta.km - 0.05 ? `<small>${lp.kmAperti.toFixed(1)} km aperti</small>` : ''}</div>
      <div><small>Capolinea–capolinea</small><b>${Math.round(lp.run)} min</b></div>
      <div><small>Un treno ogni</small><b>${lp.hwPeak.toFixed(1)} min</b><small>punta</small></div>
      <div><small>Un treno ogni</small><b>${lp.hwOff.toFixed(1)} min</b><small>morbida</small></div>
      <div><small>Saliti/giorno</small><b>${fmtK(r.saliti)}</b></div>
      <div><small>Riempimento max</small><b class="${r.maxRatio > 1 ? 'bad' : r.maxRatio > 0.8 ? 'mid' : 'good'}">${pct(r.maxRatio)}</b><small>punta</small></div>
      <div><small>Ricavi/giorno</small><b>€ ${fmtK(r.ricavi)}</b></div>
      <div><small>Costo/giorno</small><b>€ ${fmtK(r.costo)}</b></div>
    </div>
    ${lp.sprecati ? '<p class="small bad">Hai più treni di quanti la linea possa farne passare (minimo 1,5 minuti tra un treno e l\'altro): quelli in più costano e basta.</p>' : ''}
    ${r.saturo ? '<p class="small bad">Sui binari in comune passano più di 40 treni l\'ora sommando le corse: oltre non si va.</p>' : ''}
    ${r.maxRatio > 1 ? `<p class="small bad">Nell'ora di punta i treni sono pieni al ${pct(r.maxRatio)}: parte della gente resta a terra. Aggiungi treni o corse limitate, o scegli un tipo di linea più capiente.</p>` : ''}
    ${r.maxRatioOff > 1 ? '<p class="small bad">Anche nelle ore di morbida i treni non bastano: alza la percentuale.</p>' : ''}`;
  } else if (l.stops.length > 1 && conCantieri()) {
    h += `<p class="small">🚧 La linea apre quando almeno due stazioni vicine e il tratto tra loro sono finiti. Segui i lavori nella scheda <b>Cantieri</b>.</p>`;
  }
  // corse aggiuntive
  h += `<h4>Corse aggiuntive</h4>`;
  if (l.stops.length < 3) h += '<p class="small muted">Servono almeno 3 fermate per aggiungere corse espresse o limitate.</p>';
  else {
    h += '<p class="small muted">Le <b>espresse</b> saltano le fermate che scegli e arrivano prima. Le <b>limitate</b> fanno solo una parte della linea, dove c\'è più gente. Usano gli stessi binari.</p>';
    for (const sv of l.services) h += schedaServizio(l, sv);
    h += `<div class="row"><button id="svExp">+ Espressa</button><button id="svLim">+ Limitata</button></div>`;
  }
  // diramazioni
  h += `<h4>Diramazioni</h4>`;
  if (!(l.rami || []).length) h += `<p class="small muted">Una linea può dividersi in due rami, come una Y. Seleziona una stazione in mezzo alla linea e premi <b>Crea diramazione da qui</b>, poi tocca la mappa per tracciare il nuovo ramo.</p>`;
  for (const r of l.rami || []) h += schedaRamo(l, r);
  h += `<div class="row"><button id="lDel" class="danger">Elimina linea</button></div></div>`;
  return h;
}

function schedaRamo(l, r) {
  const j = l.stops.indexOf(r.da); const rr = G.res?.rami?.[r.id];
  const fine = r.stops.length ? G.stations[r.stops[r.stops.length - 1]].name : '…';
  const capoA = G.stations[l.stops[0]].name, capoB = G.stations[l.stops[l.stops.length - 1]].name;
  const sel = G.sel.ramo === r.id;
  return `<div class="svc ramo ${sel ? 'on' : ''}" data-ramo="${r.id}">
    <div class="svcHead"><span class="tag" style="--c:${l.color};background:${l.color}">Ramo</span>
      <span class="grow small"><b>${esc(G.stations[r.da].name)} → ${esc(fine)}</b> · ${r.stops.length} fermate${rr?.saliti ? ` · ${fmtK(rr.saliti)} saliti` : ''}</span>
      <button class="link rDel">Elimina</button></div>
    ${sel ? `<p class="small"><b>Stai allungando questo ramo:</b> tocca la mappa o una stazione.</p>` : `<button class="link rSel">Allunga questo ramo</button>`}
    <label>I treni del ramo proseguono sul tronco fino a<select class="rVerso">
      <option value="start" ${r.verso === 'start' ? 'selected' : ''}>${esc(capoA)}</option>
      <option value="end" ${r.verso === 'end' ? 'selected' : ''}>${esc(capoB)}</option></select></label>
    <label>Treni sul ramo<span class="stepper sm"><button class="rMinus">−</button><b>${r.trains}</b><button class="rPlus">+</button>
      ${r.autoTreni === false ? '<button class="link rAuto">automatico</button>' : '<small>automatico: ogni ~10 min</small>'}</span></label>
    ${rr?.LP ? `<p class="small muted">Un treno del ramo ogni ${rr.LP.hwPeak.toFixed(1)} min in punta. Sul tronco tra ${esc(r.verso === 'start' ? capoA : capoB)} e ${esc(G.stations[r.da].name)} passano sia i treni della linea sia quelli del ramo.</p>` : ''}
    ${j < 0 ? '<p class="small bad">La stazione di innesto non è più sulla linea.</p>' : ''}
  </div>`;
}

function schedaServizio(l, sv) {
  const a = l.stops.indexOf(sv.from), b = l.stops.indexOf(sv.to);
  const valido = a >= 0 && b >= 0 && a !== b;
  const opt = sel => l.stops.map(sid => `<option value="${sid}" ${sid === sel ? 'selected' : ''}>${esc(G.stations[sid].name)}</option>`).join('');
  const saliti = G.res ? Object.entries(G.res.percorsi).filter(([k]) => k.endsWith(':' + sv.id)).reduce((s, [, v]) => s + v.saliti, 0) : 0;
  const route = G.res?.routes.find(r => r.sv === sv || r.sv?.id === sv.id);
  let h = `<div class="svc" data-sv="${sv.id}">
    <div class="svcHead"><span class="tag ${sv.tipo}">${sv.tipo === 'espresso' ? 'Espressa' : 'Limitata'}</span>
      <span class="grow small">${saliti ? fmtK(saliti) + ' saliti/giorno' : ''}${route ? ` · ogni ${route.hwPeak.toFixed(1)} min` : ''}${route && sv.tipo === 'espresso' ? ` · ${Math.round(route.run)} min` : ''}</span>
      <button class="link svDel">Elimina</button></div>
    <div class="svcRange"><label>Da<select class="svFrom">${opt(sv.from)}</select></label><label>A<select class="svTo">${opt(sv.to)}</select></label></div>
    <label>Treni<span class="stepper sm"><button class="svMinus">−</button><b>${sv.trains}</b><button class="svPlus">+</button></span></label>`;
  if (!valido) h += '<p class="small bad">Una delle due fermate non è più sulla linea: scegline altre.</p>';
  if (sv.tipo === 'espresso' && valido) {
    const [i0, i1] = a < b ? [a, b] : [b, a];
    h += '<p class="small muted">Tocca le fermate per decidere dove si ferma:</p><div class="chips">';
    for (let i = i0; i <= i1; i++) {
      const sid = l.stops[i]; const capo = i === i0 || i === i1; const salta = (sv.skip || []).includes(sid);
      h += `<button class="chip ${salta ? 'off' : 'on'}" data-sid="${sid}" ${capo ? 'disabled' : ''}>${esc(G.stations[sid].name)}</button>`;
    }
    h += '</div>';
  }
  return h + '</div>';
}

function schedaStazione(s, l) {
  const ls = lineeDi(s.id); const r = G.res?.stazioni[s.id];
  const zona = zonaDi(s, G.tariffe, G.city);
  let h = `<div class="card">
    <label class="lblTop">Nome della stazione</label>
    <div class="cardHead rename"><input id="sName" value="${esc(s.name)}" maxlength="40" aria-label="Nome della stazione"><button id="sRen" title="Rinomina">✎</button></div>
    <p class="small">${ls.map(x => `<span class="bullet sm" style="background:${x.color}">${esc(x.name)}</span>`).join(' ')} ${ls.length > 1 ? '· interscambio' : ''}
      ${G.tariffe?.modo === 'zone' ? ` · <b>Zona ${zona + 1}</b>` : ''}</p>`;
  if (s.cantiere) {
    const pr = 1 - s.cantiere.giorni / s.cantiere.totale;
    h += `<div class="prog"><i style="width:${pr * 100}%"></i></div><p class="small">🚧 In costruzione: mancano <b>${s.cantiere.giorni} giorni</b>.
      ${!s.cantiere.accel && s.cantiere.giorni > 1 ? `<button class="link" id="sAcc">Turni doppi: ${mln(s.cantiere.costo * 0.5)}, tempi dimezzati</button>` : ''}</p>`;
  }
  h += `<label>Tipo di fermata<select id="sPlat">${Object.entries(PIANI).map(([k, p]) => `<option value="${k}" ${k === s.platform ? 'selected' : ''}>${p.nome}${conCantieri() ? ' · costruzione ' + mln(CANTIERE[k].stazione) + ', ' + CANTIERE[k].giorniStazione + ' gg' : ''} · € ${fmt(p.costoGiorno)}/giorno</option>`).join('')}</select></label>`;
  if (conCantieri() && s.pagata && !s.cantiere) h += '<p class="small muted">Cambiare tipo a una stazione finita vuol dire ricostruirla: si paga di nuovo e chiude per i lavori.</p>';
  if (r) h += `<div class="facts"><div><small>Ingressi/giorno</small><b>${fmtK(r.ingressi)}</b></div><div><small>Trasbordi/giorno</small><b>${fmtK(r.trasbordi)}</b></div>
    <div><small>Abitudine</small><b>${pct(s.maturita ?? 1)}</b><small>cresce ogni giorno</small></div></div>`;
  const j = l ? l.stops.indexOf(s.id) : -1;
  if (l && j > 0 && j < l.stops.length - 1 && !G.sel.ramo) h += `<div class="row"><button id="sRamo" class="primary">⑂ Crea diramazione da qui</button></div>`;
  h += `<div class="row">${l && fermateLinea(l).has(s.id) && (ls.length > 1 || sequenze(l).some((q, i) => i && q.includes(s.id) && q[0] !== s.id)) ? `<button id="sOut">Togli da ${esc(l.name)}</button>` : ''}<button id="sDel" class="danger">Elimina stazione</button></div>`;
  if ((l?.rami || []).some(r => r.da === s.id)) h += '<p class="small muted">Da qui parte una diramazione: eliminando la stazione si elimina anche il ramo.</p>';
  if (conCantieri()) h += '<p class="small muted">Demolire non restituisce i soldi spesi (ma «Annulla» sì, finché non passa la giornata).</p>';
  return h + '</div>';
}

function collegaCostruisci(l, s) {
  const el = $('#tab-costruisci');
  el.querySelectorAll('.lineRow').forEach(b => b.onclick = () => {
    G.sel.line = b.dataset.l === G.sel.line ? null : b.dataset.l; G.sel.station = null; G.sel.end = 'end'; G.sel.ramo = null;
    const x = linea(G.sel.line);
    if (x && x.stops.length > 1) map.fitBounds(L.latLngBounds(x.stops.map(id => [G.stations[id].lat, G.stations[id].lon])), { padding: [60, 60], maxZoom: 14 });
    ridisegna(); pannelloCostruisci();
  });
  $('#bNew').onclick = () => { snapshot(); creaLinea(); G.sel.station = null; ridisegna(); pannelloCostruisci(); toast('Nuova linea: tocca la mappa o una stazione esistente per iniziarla.'); };
  $('#bDesel').onclick = () => { G.sel.line = null; G.sel.station = null; G.sel.ramo = null; ridisegna(); pannelloCostruisci(); };
  el.querySelectorAll('.ramo').forEach(box => {
    const r = ramo(l, box.dataset.ramo); if (!r) return;
    box.querySelector('.rDel').onclick = () => { if (confirm('Eliminare questa diramazione e le sue fermate?')) eliminaRamo(l, r); };
    const rs = box.querySelector('.rSel'); if (rs) rs.onclick = () => { G.sel.ramo = r.id; G.sel.station = r.stops[r.stops.length - 1] || r.da; ridisegna(); pannelloCostruisci(); };
    box.querySelector('.rVerso').onchange = e => { snapshot(); r.verso = e.target.value; cambiato(); };
    box.querySelector('.rMinus').onclick = () => { if (r.trains > 1) { r.autoTreni = false; r.trains--; cambiato(); } };
    box.querySelector('.rPlus').onclick = () => { if (r.trains < 60) { r.autoTreni = false; r.trains++; cambiato(); } };
    const ra = box.querySelector('.rAuto'); if (ra) ra.onclick = () => { r.autoTreni = true; cambiato(); };
  });
  const sr = $('#sRamo'); if (sr) sr.onclick = () => creaRamo(l, s.id);
  $('#bUndo').onclick = annulla;
  if (l) {
    $('#lName').onchange = e => { l.name = e.target.value.trim() || l.name; cambiato(); };
    el.querySelectorAll('.sw').forEach(b => b.onclick = () => { l.color = b.dataset.c; cambiato(); });
    const sw = $('#lSwap'); if (sw) sw.onclick = () => { G.sel.end = G.sel.end === 'end' ? 'start' : 'end'; ridisegna(); pannelloCostruisci(); };
    $('#lType').onchange = e => { snapshot(); l.type = e.target.value; cambiato(); };
    $('#tMinus').onclick = () => { if (l.trains > 1) { l.autoTreni = false; l.trains--; cambiato(); } };
    $('#tPlus').onclick = () => { if (l.trains < 80) { l.autoTreni = false; l.trains++; cambiato(); } };
    const ta = $('#tAuto'); if (ta) ta.onclick = () => { l.autoTreni = true; cambiato(); };
    $('#lOff').oninput = e => { e.target.parentElement.querySelector('b').textContent = e.target.value + '%'; };
    $('#lOff').onchange = e => { snapshot(); l.offpeak = +e.target.value; cambiato(); };
    $('#lDel').onclick = () => { if (confirm(`Eliminare la linea ${l.name}?`)) eliminaLinea(l); };
    const n = l.stops.length;
    const ex = $('#svExp'); if (ex) ex.onclick = () => {
      snapshot();
      // di base ferma ai capolinea, agli interscambi e circa ogni tre fermate
      const skip = l.stops.filter((sid, i) => i > 0 && i < n - 1 && lineeDi(sid).length < 2 && i % 3 !== 0);
      l.services.push({ id: nuovoId('v'), tipo: 'espresso', from: l.stops[0], to: l.stops[n - 1], skip, trains: Math.max(2, Math.round(l.trains / 3)) });
      cambiato();
    };
    const li = $('#svLim'); if (li) li.onclick = () => {
      snapshot();
      l.services.push({ id: nuovoId('v'), tipo: 'limitato', from: l.stops[Math.floor(n * 0.25)], to: l.stops[Math.min(n - 1, Math.ceil(n * 0.75))], trains: Math.max(2, Math.round(l.trains / 3)) });
      cambiato();
    };
    el.querySelectorAll('.svc').forEach(box => {
      const sv = l.services.find(x => x.id === box.dataset.sv); if (!sv) return;
      box.querySelector('.svDel').onclick = () => { snapshot(); l.services = l.services.filter(x => x !== sv); cambiato(); };
      box.querySelector('.svFrom').onchange = e => { snapshot(); sv.from = e.target.value; cambiato(); };
      box.querySelector('.svTo').onchange = e => { snapshot(); sv.to = e.target.value; cambiato(); };
      box.querySelector('.svMinus').onclick = () => { if (sv.trains > 1) { sv.trains--; cambiato(); } };
      box.querySelector('.svPlus').onclick = () => { if (sv.trains < 60) { sv.trains++; cambiato(); } };
      box.querySelectorAll('.chip').forEach(c => c.onclick = () => {
        sv.skip = sv.skip || [];
        const sid = c.dataset.sid;
        sv.skip = sv.skip.includes(sid) ? sv.skip.filter(x => x !== sid) : [...sv.skip, sid];
        cambiato();
      });
    });
  }
  if (s) {
    $('#sName').onchange = e => { const n = e.target.value.trim().slice(0, 40); if (n) { s.name = n; s.nomeManuale = true; } cambiato(); };
    $('#sName').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };
    $('#sRen').onclick = () => { const i = $('#sName'); i.focus(); i.select(); };
    $('#sPlat').onchange = e => {
      snapshot();
      if (conCantieri() && s.pagata) { s.pagata = false; s.cantiere = null; }
      s.platform = e.target.value; cambiato();
    };
    const acc = $('#sAcc'); if (acc) acc.onclick = () => accelera('s', s.id);
    const so = $('#sOut'); if (so) so.onclick = () => rimuoviDaLinea(l, s.id);
    $('#sDel').onclick = () => eliminaStazione(s.id);
  }
}

// ---------- Pannello: cantieri ----------
function pannelloCantieri() {
  const el = $('#tab-cantieri');
  if (!G.city || !conCantieri()) { el.innerHTML = ''; return; }
  const r = G.res; const fin = finanziamentoGiorno();
  const saldo = fin + (r ? (r.ricavi - r.costi) / 1e6 : 0) - rateGiorno();
  const lav = [];
  for (const s of Object.values(G.stations)) if (s.cantiere) lav.push({ tipo: 's', id: s.id, nome: 'Stazione ' + s.name, piano: PIANI[s.platform].nome, c: s.cantiere });
  for (const [k, t] of Object.entries(G.tratte)) if (t.giorni > 0) {
    const [a, b] = k.split('|').map(x => G.stations[x]?.name || '?');
    lav.push({ tipo: 't', id: k, nome: `${a} – ${b}`, piano: (t.piano === 'sotterranea' ? 'Galleria' : t.piano === 'sopraelevata' ? 'Viadotto' : 'Binari a raso') + ` · ${t.km.toFixed(1)} km`, c: t });
  }
  lav.sort((x, y) => x.c.giorni - y.c.giorni);
  let h = `<div class="facts big">
    <div><small>In cassa</small><b class="${G.cassa < 0 ? 'bad' : ''}">${mln(G.cassa)}</b></div>
    <div><small>Saldo di ogni giorno</small><b class="${saldo >= 0 ? 'good' : 'bad'}">${saldo >= 0 ? '+' : '−'}${mln(Math.abs(saldo)).slice(2)}</b></div>
    <div><small>Finanziamenti/giorno</small><b>${mln(fin)}</b></div>
    <div><small>Biglietti − esercizio</small><b>${r ? (r.ricavi - r.costi >= 0 ? '+' : '−') + mln(Math.abs(r.ricavi - r.costi) / 1e6).slice(2) : '—'}</b></div>
    ${G.prestiti.length ? `<div><small>Debiti da restituire</small><b class="bad">${mln(debito())}</b></div>
    <div><small>Rate/giorno</small><b>−${mln(rateGiorno()).slice(2)}</b></div>` : ''}
  </div>
  <h3>Prestiti</h3>
  <p class="small muted">La banca presta fino a ${mln(debitoMax())} in tutto (ora ne hai usati ${mln(debito())}). Le rate si pagano ogni giorno, prima di tutto il resto; più debiti hai, più alto è il tasso.</p>
  <div class="prestito">
    <label class="lbl">Importo<select id="pImp">${importiPrestito().map(x => `<option value="${x}">${mln(x)}</option>`).join('')}</select></label>
    <label class="lbl">Durata<select id="pDur">${DURATE.map((d, i) => `<option value="${i}" ${i === 1 ? 'selected' : ''}>${d.nome}</option>`).join('')}</select></label>
  </div>
  <p class="small" id="pPrev"></p>
  <div class="row"><button id="pChiedi" class="primary">Chiedi il prestito</button></div>
  ${G.prestiti.map(p => `<div class="cant"><div class="cantHead"><b>🏦 ${mln(p.capitale)} al ${p.tasso.toLocaleString('it-IT')}%</b><small>${p.giorniRimasti} gg alla fine</small></div>
    <div class="prog debito"><i style="width:${Math.max(2, (1 - p.residuo / p.capitale) * 100)}%"></i></div>
    <small>Restano ${mln(p.residuo)} · rata ${mln(p.rata)}/giorno</small> <button class="link est" data-id="${p.id}">Estingui ora</button></div>`).join('')}
  <h3>Listino</h3>
  <table class="listino"><tr><th></th><th>Stazione</th><th>Al km</th></tr>
    ${Object.entries(CANTIERE).map(([k, c]) => `<tr><td>${PIANI[k].nome}</td><td>${mln(c.stazione)} · ${c.giorniStazione} gg</td><td>${mln(PIANI[k].costoKm)} · ${c.giorniKm} gg</td></tr>`).join('')}
  </table>
  <h3>Lavori in corso (${lav.length})</h3>`;
  if (!lav.length) h += '<p class="muted small">Nessun cantiere aperto. Tocca la mappa per costruire.</p>';
  for (const x of lav) {
    const pr = 1 - x.c.giorni / x.c.totale;
    h += `<div class="cant"><div class="cantHead"><b>${esc(x.nome)}</b><small>${x.piano} · ${x.c.giorni} gg</small></div>
      <div class="prog"><i style="width:${Math.max(3, pr * 100)}%"></i></div>
      ${!x.c.accel && x.c.giorni > 1 ? `<button class="link acc" data-t="${x.tipo}" data-id="${esc(x.id)}">Turni doppi: ${mln(x.c.costo * 0.5)}, tempi dimezzati</button>` : x.c.accel ? '<small class="muted">Turni doppi attivi</small>' : ''}</div>`;
  }
  h += '<p class="small muted">Lascia scorrere il tempo (anche a 60×) per far avanzare i lavori. Una linea apre i tratti man mano che stazioni e gallerie sono pronte.</p>';
  el.innerHTML = h;
  el.querySelectorAll('.acc').forEach(b => b.onclick = () => accelera(b.dataset.t, b.dataset.id));
  el.querySelectorAll('.est').forEach(b => b.onclick = () => estinguiPrestito(b.dataset.id));
  const anteprima = () => {
    const imp = +$('#pImp').value, d = DURATE[+$('#pDur').value];
    const tasso = tassoOfferto(d, imp), rata = rataPrestito(imp, tasso, d.giorni);
    const oltre = debito() + imp > debitoMax();
    $('#pPrev').innerHTML = oltre ? `<span class="bad">Troppo: supereresti il limite di ${mln(debitoMax())}.</span>`
      : `Tasso <b>${tasso.toLocaleString('it-IT')}%</b> · rata <b>${mln(rata)}</b> al giorno · restituisci in tutto <b>${mln(rata * d.giorni)}</b>.`;
    $('#pChiedi').disabled = oltre;
  };
  $('#pImp').onchange = anteprima; $('#pDur').onchange = anteprima; anteprima();
  $('#pChiedi').onclick = () => chiediPrestito(+$('#pImp').value, DURATE[+$('#pDur').value]);
}

// ---------- Pannello: tariffe ----------
function pannelloTariffe() {
  const el = $('#tab-tariffe');
  if (!G.city) { el.innerHTML = '<p class="muted">Scegli una città.</p>'; return; }
  const t = G.tariffe; const R = G.C.R;
  let h = `<p class="small muted">Il prezzo del biglietto cambia chi sceglie la metro: più caro porta più soldi a viaggio ma meno passeggeri.</p>
    <label class="lbl">Sistema tariffario<select id="tModo">
      <option value="zone" ${t.modo === 'zone' ? 'selected' : ''}>A zone concentriche</option>
      <option value="unica" ${t.modo === 'unica' ? 'selected' : ''}>Biglietto unico</option></select></label>`;
  if (t.modo === 'zone') {
    h += `<p class="small">La città è divisa in 3 anelli attorno al centro. Si paga in base a quante zone si attraversano.</p>
    <label class="lbl">Fine della zona 1 (centro): <b id="r0v">${t.anelli[0].toFixed(1)} km</b><input type="range" id="r0" min="0.5" max="${(R * 0.9).toFixed(1)}" step="0.1" value="${t.anelli[0]}"></label>
    <label class="lbl">Fine della zona 2: <b id="r1v">${t.anelli[1].toFixed(1)} km</b><input type="range" id="r1" min="1" max="${R.toFixed(1)}" step="0.1" value="${t.anelli[1]}"></label>
    <div class="prezzi">
      ${['Dentro la stessa zona', 'Attraverso 2 zone', 'Attraverso 3 zone'].map((n, i) => `<label>${n}<span class="eur">€<input type="number" min="0" max="10" step="0.1" data-p="${i}" value="${t.prezzi[i].toFixed(2)}"></span></label>`).join('')}
    </div>`;
  } else {
    h += `<div class="prezzi"><label>Prezzo di ogni viaggio<span class="eur">€<input type="number" min="0" max="10" step="0.1" data-p="0" value="${t.prezzi[0].toFixed(2)}"></span></label></div>`;
  }
  h += `<div class="row"><button id="tReset">Torna ai prezzi iniziali</button></div><div id="tRis"></div>`;
  el.innerHTML = h;
  $('#tModo').onchange = e => { t.modo = e.target.value; disegnaZone(); pannelloTariffe(); ricalcolaTariffe(); };
  for (const i of [0, 1]) {
    const inp = $('#r' + i); if (!inp) continue;
    inp.oninput = e => {
      let v = +e.target.value;
      if (i === 0) v = Math.min(v, t.anelli[1] - 0.3); else v = Math.max(v, t.anelli[0] + 0.3);
      t.anelli[i] = +v.toFixed(1); $('#r' + i + 'v').textContent = t.anelli[i].toFixed(1) + ' km'; disegnaZone();
    };
    inp.onchange = () => { pannelloTariffe(); ricalcolaTariffe(); };
  }
  el.querySelectorAll('[data-p]').forEach(inp => inp.onchange = e => {
    const v = Math.max(0, Math.min(10, parseFloat(String(e.target.value).replace(',', '.')) || 0));
    t.prezzi[+e.target.dataset.p] = Math.round(v * 100) / 100; e.target.value = v.toFixed(2); ricalcolaTariffe();
  });
  $('#tReset').onclick = () => { G.tariffe = tariffeDefault(); disegnaZone(); pannelloTariffe(); ricalcolaTariffe(); };
  risultatiTariffe();
}
function ricalcolaTariffe() { clearTimeout(ricalcoloT); ricalcoloT = setTimeout(() => { ricalcola(); salva(); }, 100); }
function risultatiTariffe() {
  const el = $('#tRis'); if (!el) return; const r = G.res;
  if (!r || !r.riders) { el.innerHTML = '<p class="muted small">Costruisci una linea per vedere l\'effetto dei prezzi.</p>'; return; }
  const perZona = [0, 0, 0];
  for (const x of Object.values(r.stazioni)) perZona[Math.min(2, x.zona)] += x.ingressi;
  el.innerHTML = `<h3>Effetto sui conti</h3><div class="facts">
    <div><small>Passeggeri/giorno</small><b>${fmtK(r.riders)}</b></div>
    <div><small>Prezzo medio pagato</small><b>${euro(r.prezzoMedio)}</b></div>
    <div><small>Ricavi/giorno</small><b>€ ${fmtK(r.ricavi)}</b></div>
    <div><small>Copertura costi</small><b class="${r.ratio >= 0.7 ? 'good' : r.ratio >= 0.4 ? 'mid' : 'bad'}">${pct(r.ratio)}</b></div>
  </div>
  ${G.tariffe.modo === 'zone' ? `<p class="small">Ingressi per zona: ${perZona.map((v, i) => `zona ${i + 1} <b>${fmtK(v)}</b>`).join(' · ')}</p>` : ''}`;
}

// ---------- Pannello: statistiche ----------
function pannelloStatistiche() {
  const el = $('#tab-statistiche'); const r = G.res;
  if (!r || !G.C) { el.innerHTML = '<p class="muted">Nessun dato.</p>'; return; }
  let kmTot = 0, costoCostr = 0;
  for (const l of G.lines) {
    for (const seq of sequenze(l)) for (let k = 0; k < seq.length - 1; k++) {
      const a = G.stations[seq[k]], b = G.stations[seq[k + 1]]; const km = distKm(a, b) * 1.12;
      kmTot += km; costoCostr += km * PIANI[pianoTratta(a, b)].costoKm;
    }
  }
  for (const s of Object.values(G.stations)) costoCostr += CANTIERE[s.platform].stazione;
  const modi = Object.entries(r.modi).sort((a, b) => b[1] - a[1]);
  const MC = { metro: '#e2231a', auto: '#5b6770', scooter: '#f07f1a', bus: '#0067b1', piedi: '#7cb518', bici: '#00a3a6' };
  let h = `<div class="facts big">
    <div><small>Passeggeri/giorno</small><b>${fmt(r.riders)}</b></div>
    <div><small>A regime (abitudine piena)</small><b>${fmt(r.potenziale)}</b></div>
    <div><small>Lasciati a terra</small><b class="${r.quotaPersi > 0.02 ? 'bad' : ''}">${fmt(r.persi)}</b></div>
    <div><small>Copertura dei costi</small><b class="${r.ratio >= 0.7 ? 'good' : r.ratio >= 0.4 ? 'mid' : 'bad'}">${r.riders ? pct(r.ratio) : '—'}</b></div>
    <div><small>Ricavi/giorno</small><b>€ ${fmtK(r.ricavi)}</b><small>${r.riders ? euro(r.prezzoMedio) + ' a viaggio' : ''}</small></div>
    <div><small>Costi/giorno</small><b>€ ${fmtK(r.costi)}</b></div>
    <div><small>Rete</small><b>${kmTot.toFixed(1)} km</b><small>${Object.keys(G.stations).length} stazioni</small></div>
    <div><small>Valore delle opere</small><b>${mln(costoCostr)}</b><small>${conCantieri() ? 'stazioni e gallerie' : 'qui è gratis'}</small></div>
  </div>
  <h3>Come si spostano gli abitanti</h3>
  <div class="stack">${modi.map(([m, v]) => `<i style="width:${v * 100}%;background:${MC[m]}" title="${MODI_NOME[m]} ${pct(v)}"></i>`).join('')}</div>
  <div class="legend">${modi.map(([m, v]) => `<span><i style="background:${MC[m]}"></i>${MODI_NOME[m]} <b>${(v * 100).toFixed(1)}%</b></span>`).join('')}</div>
  <h3>Qualità del servizio: ${r.riders ? r.qualita : '—'}/100</h3>
  ${r.riders ? `<div class="bars">
    ${barra('Attesa', r.q.attesa, `${r.attesa.toFixed(1)} min in media`)}
    ${barra('Trasbordi', r.q.trasbordi, `${r.trasbordi.toFixed(2)} cambi per viaggio`)}
    ${barra('Affollamento', r.q.affollamento, `treni pieni al ${pct(r.affoll)} in media`)}
    ${barra('Lasciati a terra', r.q.persi, pct(r.quotaPersi) + ' della domanda')}</div>` : '<p class="muted">Apri una linea con almeno due fermate.</p>'}
  <h3>Andamento</h3>
  <canvas id="spark" width="560" height="120"></canvas>
  <p class="small muted">Passeggeri al giorno, un punto per giornata simulata. Abitanti modellati: ${fmtK(G.city.pop)} in ${G.C.N} zone di ${G.C.cell.toFixed(2)} km; ${fmtK(G.C.totTrips)} spostamenti al giorno. I numeri sono stime da dati OpenStreetMap, non dati reali.</p>`;
  if (r.riders) {
    h += `<h3>Stazioni più frequentate</h3><ol class="top">` + Object.entries(r.stazioni).sort((a, b) => b[1].ingressi - a[1].ingressi).slice(0, 8)
      .map(([sid, x]) => `<li><span>${esc(G.stations[sid]?.name || '')}</span><b>${fmtK(x.ingressi)}</b></li>`).join('') + '</ol>';
  }
  el.innerHTML = h;
  disegnaSpark();
}
function barra(nome, v, sub) {
  return `<div class="bar"><span>${nome}<small>${sub}</small></span><i><em style="width:${v}%;background:${v >= 75 ? 'var(--good)' : v >= 50 ? 'var(--mid)' : 'var(--bad)'}"></em></i><b>${Math.round(v)}</b></div>`;
}
function disegnaSpark() {
  const cv = $('#spark'); if (!cv) return;
  const c = cv.getContext('2d'); const W = cv.width, H = cv.height;
  c.clearRect(0, 0, W, H);
  const d = [...G.history.map(x => x.riders), Math.round(G.res?.riders || 0)];
  c.font = '20px Titillium Web'; c.fillStyle = getComputedStyle(document.body).getPropertyValue('--ink');
  if (d.length < 2) { c.globalAlpha = 0.5; c.fillText('Lascia scorrere qualche giorno per vedere la crescita.', 10, H / 2); c.globalAlpha = 1; return; }
  const max = Math.max(...d) * 1.1 || 1;
  c.strokeStyle = '#e2231a'; c.lineWidth = 3; c.beginPath();
  d.forEach((v, i) => { const x = 10 + i / (d.length - 1) * (W - 20), y = H - 10 - v / max * (H - 20); i ? c.lineTo(x, y) : c.moveTo(x, y); });
  c.stroke();
  c.globalAlpha = 0.6; c.fillText(fmtK(d[d.length - 1]), W - 90, 22); c.globalAlpha = 1;
}

// ---------- Sfide ----------
function sfide() {
  const P = G.city.pop; const r = G.res || { riders: 0, ratio: 0, qualita: 0 };
  const ls = G.lines.filter(l => G.res?.linee[l.id]?.aperta);
  const inter = Object.keys(G.stations).filter(s => lineeDi(s).length > 1 && !G.stations[s].cantiere).length;
  const tondo = x => x >= 10000 ? Math.round(x / 1000) * 1000 : Math.round(x / 100) * 100;
  return [
    { id: 'prima', nome: 'Primo taglio del nastro', desc: 'Apri una linea con almeno 5 fermate.', ok: ls.some(l => G.res.LP[l.id]?.sids.length >= 5) },
    { id: 'rete', nome: 'Rete a maglie', desc: 'Almeno 3 linee aperte e 2 stazioni di interscambio.', ok: ls.length >= 3 && inter >= 2 },
    { id: 'espresso', nome: 'Si salta la fermata', desc: 'Una corsa espressa con almeno 5.000 saliti al giorno.', ok: !!G.res && G.res.routes.some(x => x.sv?.tipo === 'espresso' && G.res.percorsi[x.id]?.saliti >= 5000) },
    { id: 'pendolari', nome: 'Pendolari convinti', desc: `${fmt(tondo(P * 0.03))} passeggeri al giorno.`, ok: r.riders >= P * 0.03 },
    { id: 'conti', nome: 'Conti in ordine', desc: `Copertura dei costi almeno 70% con ${fmt(tondo(P * 0.02))} passeggeri.`, ok: r.ratio >= 0.7 && r.riders >= P * 0.02 },
    { id: 'eccellenza', nome: 'Puntuali come un orologio', desc: `Qualità almeno 85 con ${fmt(tondo(P * 0.04))} passeggeri.`, ok: r.qualita >= 85 && r.riders >= P * 0.04 },
    { id: 'pareggio', nome: 'In attivo', desc: 'I biglietti coprono tutti i costi (100%).', ok: r.ratio >= 1 && r.riders >= P * 0.02 },
    { id: 'metropoli', nome: 'Addio traffico', desc: `${fmt(tondo(P * 0.1))} passeggeri al giorno.`, ok: r.riders >= P * 0.1 },
    { id: 'sorpasso', nome: 'Sorpasso sull\'auto', desc: 'Più viaggi in metro che in auto.', ok: !!G.res && G.res.modi.metro > G.res.modi.auto },
  ];
}
function controllaSfide() {
  if (!G.city) return;
  const list = sfide();
  for (const s of list) if (s.ok && !G.achievements[s.id]) { G.achievements[s.id] = G.day; toast(`🏆 Sfida completata: <b>${esc(s.nome)}</b>`, 4000); }
  const fatte = list.filter(s => G.achievements[s.id]).length;
  $('#tab-sfide').innerHTML = `<p class="small muted">${fatte} di ${list.length} sfide completate a ${esc(G.city.nome)}. I traguardi si adattano agli abitanti della città.</p>` +
    list.map(s => `<div class="sfida ${G.achievements[s.id] ? 'ok' : ''}"><span class="medal">${G.achievements[s.id] ? '★' : '☆'}</span>
      <span><b>${esc(s.nome)}</b><small>${esc(s.desc)}</small>${G.achievements[s.id] ? `<small class="good">Completata il giorno ${G.achievements[s.id]}</small>` : ''}</span></div>`).join('');
}

// ---------- Pannello: mappa e partita ----------
function pannelloMappa() {
  $('#tab-mappa').innerHTML = `
    <h3>Livelli</h3>
    <label class="check"><input type="checkbox" id="oDens" ${G.overlays.densita ? 'checked' : ''}> Densità: <span class="dot" style="background:#e85d3a"></span> dove vivono, <span class="dot" style="background:#2a6fdb"></span> dove lavorano e studiano</label>
    <label class="check"><input type="checkbox" id="oCop" ${G.overlays.copertura ? 'checked' : ''}> Copertura: 800 m a piedi dalle stazioni</label>
    <label class="check"><input type="checkbox" id="oZone" ${G.overlays.zone ? 'checked' : ''}> Zone tariffarie</label>
    <h3>Stile della mappa</h3>
    <div class="row">${Object.entries(TEMI).map(([k, t]) => `<button class="tema ${k === G.tema ? 'on' : ''}" data-t="${k}">${t[1]}</button>`).join('')}</div>
    ${G.city ? `<h3>Modalità di gioco</h3>
    <label class="check"><input type="radio" name="modo" value="cantieri" ${G.modo === 'cantieri' ? 'checked' : ''}> <b>Con cantieri e budget</b>: costruire costa e richiede giorni di lavori</label>
    <label class="check"><input type="radio" name="modo" value="libero" ${G.modo === 'libero' ? 'checked' : ''}> <b>Libera</b>: costruzione gratis e immediata</label>
    <p class="small muted">Passando ai cantieri, quello che hai già costruito resta e la cassa riparte da ${mln(cassaIniziale())}.</p>
    <h3>Nomi delle stazioni</h3>
    <label class="check"><input type="radio" name="nomi" value="via" ${nomiDaVie() ? 'checked' : ''}> Dalla <b>via o piazza</b> più vicina</label>
    <label class="check"><input type="radio" name="nomi" value="quartiere" ${nomiDaVie() ? '' : 'checked'}> Dal <b>quartiere</b></label>
    <div class="row"><button id="bNomiVie">Rinomina dalle vie le stazioni esistenti</button></div>
    <p class="small muted">Le stazioni che hai rinominato tu restano come sono.</p>
    <h3>Partita</h3>
    <div class="row"><button id="bReset" class="danger">Ricomincia ${esc(G.city.nome)}</button></div>` : ''}
    <p class="small muted">La partita si salva da sola in questo browser. Mappe © OpenStreetMap.</p>`;
  $('#oDens').onchange = e => { G.overlays.densita = e.target.checked; disegnaDensita(); };
  $('#oCop').onchange = e => { G.overlays.copertura = e.target.checked; disegnaCopertura(); };
  $('#oZone').onchange = e => { G.overlays.zone = e.target.checked; disegnaZone(); };
  document.querySelectorAll('input[name=modo]').forEach(i => i.onchange = e => {
    const m = e.target.value;
    if (m === 'cantieri' && !confirm('Passare alla modalità con cantieri e budget? La cassa riparte da ' + mln(cassaIniziale()) + '.')) { pannelloMappa(); return; }
    cambiaModo(m); pannelloMappa();
  });
  document.querySelectorAll('.tema').forEach(b => b.onclick = () => { impostaTema(b.dataset.t); pannelloMappa(); });
  document.querySelectorAll('input[name=nomi]').forEach(i => i.onchange = e => {
    try { localStorage.setItem('lineaitalia:nomi', e.target.value); } catch (err) {}
    pannelloMappa();
  });
  const bn = $('#bNomiVie'); if (bn) bn.onclick = () => {
    const ids = Object.values(G.stations).filter(s => !s.nomeManuale).map(s => s.id);
    if (!ids.length) return toast('Nessuna stazione da rinominare.');
    if (nomiDaVie()) {
      ids.forEach(nomeDaVia);
      toast(`Cerco le vie di ${ids.length} stazioni: circa ${Math.ceil(ids.length * 1.1)} secondi.`, 3500);
    } else {
      for (const sid of ids) { const s = G.stations[sid]; s.name = ''; s.name = nomeStazione(s.lat, s.lon); s.nomeVia = false; }
      cambiato(); toast('Nomi presi dai quartieri.');
    }
  };
  const br = $('#bReset'); if (br) br.onclick = () => {
    if (!confirm(`Cancellare la rete di ${G.city.nome} e ricominciare?`)) return;
    try { localStorage.removeItem(saveKey()); } catch (e) {}
    carica(); aggiornaCassa(); disegnaZone(); cambiato(true); pannelloMappa();
  };
}
function impostaTema(t) {
  G.tema = t; map.removeLayer(tiles);
  tiles = L.tileLayer(TEMI[t][0], { attribution: ATTRIB, maxZoom: 19 }).addTo(map);
  document.body.classList.toggle('notte', t === 'scuro'); document.body.dataset.tema = t;
  try { localStorage.setItem('lineaitalia:tema', t); } catch (e) {}
}

// ---------- Schede e tastiera ----------
function vaiTab(tab) {
  G.tab = tab;
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + tab));
  $('#panel').classList.remove('chiuso');
  if (tab === 'statistiche') pannelloStatistiche();
  if (tab === 'mappa') pannelloMappa();
  if (tab === 'tariffe') pannelloTariffe();
  if (tab === 'cantieri') pannelloCantieri();
  disegnaZone();
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => vaiTab(b.dataset.tab));
$('#panelToggle').onclick = () => $('#panel').classList.toggle('chiuso');
document.addEventListener('keydown', e => {
  if (e.target.matches('input,select,textarea')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); annulla(); }
  else if (e.key === 'Escape') { if (G.sel.ramo) G.sel.ramo = null; else { G.sel.line = null; G.sel.station = null; } ridisegna(); pannelloCostruisci(); }
  else if (e.key === 'Delete' && G.sel.station) eliminaStazione(G.sel.station);
  else if (e.key === 'F2' && G.sel.station) { e.preventDefault(); rinominaStazione(G.sel.station); }
  else if (e.key === ' ') { e.preventDefault(); G.speed = G.speed ? 0 : 1; aggiornaVelocita(); }
});

// ---------- Avvio ----------
try { const t = localStorage.getItem('lineaitalia:tema'); if (t && TEMI[t] && t !== 'chiaro') impostaTema(t); } catch (e) {}
pannelloCostruisci(); pannelloMappa(); aggiornaCassa();
mostraCitta();
$('#cityModal').classList.add('on');
requestAnimationFrame(ciclo);
