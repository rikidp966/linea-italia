// Scarica una volta i dati OpenStreetMap (quartieri, stazioni, ospedali, università) delle città in elenco
// e li salva in public/data/<id>.json, così il gioco non dipende da Overpass per queste città.
// Uso: node tools/scarica-osm.js            (salta le città già scaricate)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUB = path.join(__dirname, '..', 'public');
const OUT = path.join(PUB, 'data');
fs.mkdirSync(OUT, { recursive: true });
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(PUB, 'cities.js'), 'utf8') + ';this.CITTA=CITTA;', ctx);

const SERVER = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const raggio = pop => Math.max(4, Math.min(17, 3 + Math.sqrt(pop / 1000) * 0.26));
const pausa = ms => new Promise(r => setTimeout(r, ms));

function query(c) {
  const r = Math.round(raggio(c.pop) * 1000);
  return `[out:json][timeout:120];(
node["place"~"^(suburb|quarter|neighbourhood|town|village|hamlet)$"](around:${r},${c.lat},${c.lon});
nwr["railway"="station"]["station"!="subway"](around:${r},${c.lat},${c.lon});
nwr["amenity"~"^(university|hospital)$"](around:${r},${c.lat},${c.lon});
);out center tags;`;
}
function riduci(data) {
  const places = [], attr = [];
  const r5 = x => Math.round(x * 1e5) / 1e5;
  for (const el of data.elements || []) {
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null) continue;
    const t = el.tags || {}; const name = t['name:it'] || t.name || '';
    if (t.place) places.push({ lat: r5(lat), lon: r5(lon), name, type: t.place });
    else if (t.railway === 'station') attr.push({ lat: r5(lat), lon: r5(lon), name: name ? (/stazione/i.test(name) ? name : 'Stazione ' + name) : '', type: 'stazione', w: 2.5 });
    else if (t.amenity === 'university') attr.push({ lat: r5(lat), lon: r5(lon), name: name || 'Università', type: 'università', w: 3 });
    else if (t.amenity === 'hospital') attr.push({ lat: r5(lat), lon: r5(lon), name: name || 'Ospedale', type: 'ospedale', w: 2 });
  }
  return { places, attr };
}

async function prova(url, q) {
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 150000);
  try {
    const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctrl.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'LineaItalia/1.0 (gioco open source)' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (j.remark && /runtime error|timed out/i.test(j.remark)) throw new Error(j.remark.slice(0, 80));
    return j;
  } finally { clearTimeout(to); }
}

(async () => {
  const todo = ctx.CITTA.filter(c => !fs.existsSync(path.join(OUT, c.id + '.json')));
  console.log(`Da scaricare: ${todo.length} di ${ctx.CITTA.length}`);
  for (const c of todo) {
    let ok = false;
    for (let giro = 0; giro < 6 && !ok; giro++) {
      for (const url of SERVER) {
        try {
          const t0 = Date.now();
          const d = riduci(await prova(url, query(c)));
          if (!d.places.length && c.pop > 60000) throw new Error('risposta vuota');
          fs.writeFileSync(path.join(OUT, c.id + '.json'), JSON.stringify(d));
          console.log(`OK ${c.nome}: ${d.places.length} quartieri, ${d.attr.length} poli (${new URL(url).host}, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
          ok = true; break;
        } catch (e) {
          console.log(`.. ${c.nome} @ ${new URL(url).host}: ${e.name === 'AbortError' ? 'tempo scaduto' : e.message}`);
        }
        await pausa(3000);
      }
      if (!ok) await pausa(20000 * (giro + 1));
    }
    if (!ok) console.log(`FALLITA ${c.nome}`);
    await pausa(2000);
  }
  const fatte = ctx.CITTA.filter(c => fs.existsSync(path.join(OUT, c.id + '.json'))).length;
  console.log(`FINE: ${fatte} di ${ctx.CITTA.length} città salvate`);
})();
