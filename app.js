/* AgroSat — monitoramento de fazendas por satélite (Sentinel-2)
   Tudo roda no navegador: busca no catálogo STAC público (Earth Search / AWS),
   lê só o recorte da fazenda nas imagens COG e calcula NDVI/NDRE. */
'use strict';

// ---------- Configuração ----------
const qs = new URLSearchParams(location.search);
const CFG = {
  stac: qs.get('stac') || 'https://earth-search.aws.element84.com/v1',
  collection: qs.get('col') || 'sentinel-2-l2a',
  maxPx: 1400,                // limite de pixels por lado na imagem processada
  serieRes: 20,               // resolução (m) usada no histórico (mais rápido)
  invalidSCL: new Set([0, 1, 3, 8, 9, 10, 11]), // sem dado, saturado, sombra, nuvem, cirrus, neve
};

// ---------- Satélites (fontes de imagem) ----------
const FONTES = {
  s2: { nome: 'Sentinel‑2 · 10 m · desde 2017', curto: 'Sentinel‑2', stac: CFG.stac, col: CFG.collection, res: 10, red: ['red', 'B04'], nir: ['nir', 'B08'], re: ['rededge1', 'B05'], qa: ['scl', 'SCL'], qaTipo: 'scl', vis: ['visual', 'TCI'], g: ['green', 'B03'], b: ['blue', 'B02'], nuvemQuery: true },
  ls: { nome: 'Landsat 5/7/8/9 · 30 m · desde 1984', curto: 'Landsat', stac: 'https://planetarycomputer.microsoft.com/api/stac/v1', col: 'landsat-c2-l2', res: 30, red: ['red'], nir: ['nir08'], re: null, qa: ['qa_pixel'], qaTipo: 'landsat', vis: null, g: ['green'], b: ['blue'], nuvemQuery: true, assinar: 'landsat-c2-l2' },
  cb: { nome: 'CBERS‑4A · 2 m · só cor real', curto: 'CBERS‑4A', stac: 'https://data.inpe.br/bdc/stac/v1', col: 'CB4A-WPM-PCA-FUSED-1', res: 2, soRGB: true, nuvemQuery: false },
};
const fonteDe = it => FONTES[it._fonte || 's2'];
// Landsat (Planetary Computer) exige um "token" gratuito na URL dos arquivos
const tokensPC = {};
async function assinarHref(fonte, href) {
  if (!fonte.assinar) return href;
  const t = tokensPC[fonte.assinar];
  if (!t || t.exp < Date.now() + 120000) {
    const r = await fetch(`https://planetarycomputer.microsoft.com/api/sas/v1/token/${fonte.assinar}`);
    if (!r.ok) throw new Error('não consegui a autorização do Planetary Computer');
    const j = await r.json();
    tokensPC[fonte.assinar] = { token: j.token, exp: Date.parse(j['msft:expiry']) || Date.now() + 3e6 };
  }
  return href + (href.includes('?') ? '&' : '?') + tokensPC[fonte.assinar].token;
}

// ---------- Utilidades ----------
const $ = id => document.getElementById(id);
const fmt = (n, d = 2) => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const dBR = iso => { const [y, m, d] = iso.slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
const isoDay = dt => dt.toISOString().slice(0, 10);
function toast(msg, ms = 3500) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, ms); }
function busy(on, txt) { $('busy').hidden = !on; if (txt) $('busyText').textContent = txt; }
function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }

// ---------- Geometria ----------
function polysFromGeoJSON(gj) {
  // Retorna lista de polígonos [[ring...]] em lon/lat. Linhas fechadas viram polígonos.
  const out = [], nomes = [];
  let nomeAtual = null;
  const feats = gj.type === 'FeatureCollection' ? gj.features : gj.type === 'Feature' ? [gj] : [{ geometry: gj }];
  const walk = g => {
    if (!g) return;
    const n0 = out.length;
    if (g.type === 'Polygon') out.push(g.coordinates.map(r => r.map(c => [c[0], c[1]])));
    else if (g.type === 'MultiPolygon') g.coordinates.forEach(p => out.push(p.map(r => r.map(c => [c[0], c[1]]))));
    else if (g.type === 'LineString') {
      const c = g.coordinates; if (c.length > 3) {
        const a = c[0], b = c[c.length - 1];
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-4) out.push([c.map(p => [p[0], p[1]])]);
      }
    } else if (g.type === 'GeometryCollection') g.geometries.forEach(walk);
    for (let i = n0; i < out.length; i++) nomes[i] = nomeAtual;
  };
  feats.forEach(f => { nomeAtual = f.properties && (f.properties.name || f.properties.nome || f.properties.NOME) || null; walk(f.geometry); });
  out.nomes = nomes;
  return out;
}
// Vários polígonos: separa o perímetro (união) das subdivisões (piquetes, glebas, talhões).
function organizarPerimetro(polys) {
  const nomes = polys.nomes || [];
  if (polys.length < 2) return { polys, divs: [] };
  const feats = polys.map(p => turf.polygon(p));
  const areas = feats.map(f => turf.area(f));
  const iL = areas.indexOf(Math.max(...areas));
  const dentroDoMaior = i => { try { const x = turf.intersect(feats[iL], feats[i]); return x ? turf.area(x) / areas[i] : 0; } catch (e) { return 0; } };
  const internos = feats.map((_, i) => i).filter(i => i !== iL && dentroDoMaior(i) >= 0.9);
  // Se há um contorno geral com áreas dentro, as divisões são as áreas internas; senão, cada polígono é uma divisão.
  const idx = internos.length ? internos : feats.map((_, i) => i);
  let U = feats[0];
  for (let i = 1; i < feats.length; i++) { try { U = turf.union(U, feats[i]) || U; } catch (e) { } }
  const up = U.geometry.type === 'Polygon' ? [U.geometry.coordinates] : U.geometry.coordinates;
  const genericos = new Set([nomes[iL], null, undefined, '']);
  const d = idx.map(i => ({ rings: polys[i], nome: nomes[i], c: turf.centroid(feats[i]).geometry.coordinates }))
    .sort((a, b) => (b.c[1] - a.c[1]) || (a.c[0] - b.c[0]));
  const usaNome = d.every(x => !genericos.has(x.nome)) && new Set(d.map(x => x.nome)).size === d.length;
  return { polys: internos.length ? [polys[iL]] : polys.map(p => p), divs: d.map((x, k) => ({ nome: usaNome ? String(x.nome) : `Área ${k + 1}`, rings: x.rings })) };
}
function bboxOf(polys) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  polys.forEach(p => p[0].forEach(([x, y]) => { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }));
  return b;
}
function utmEPSG(lon, lat) { const z = Math.floor((lon + 180) / 6) + 1; return (lat < 0 ? 32700 : 32600) + z; }
function projDef(epsg) {
  if (epsg === 4326 || epsg === 4674) return '+proj=longlat +datum=WGS84 +no_defs';
  const z = epsg % 100, south = Math.floor(epsg / 100) === 327;
  return `+proj=utm +zone=${z}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
}
function toUTM(epsg) { const p = proj4('EPSG:4326', projDef(epsg)); return c => p.forward(c); }
function toLL(epsg) { const p = proj4(projDef(epsg), 'EPSG:4326'); return c => p.forward(c); }
function ringArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(a / 2); }
function areaHa(polys) {
  const b = bboxOf(polys), f = toUTM(utmEPSG((b[0] + b[2]) / 2, (b[1] + b[3]) / 2));
  let a = 0; polys.forEach(p => p.forEach((r, i) => { const s = ringArea(r.map(f)); a += i === 0 ? s : -s; }));
  return a / 1e4;
}
function pip(x, y, ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}

// ---------- Leitura do perímetro ----------
async function readPerimeter(file) {
  const name = file.name.toLowerCase();
  let gj;
  if (name.endsWith('.kml')) gj = toGeoJSON.kml(new DOMParser().parseFromString(await file.text(), 'text/xml'));
  else if (name.endsWith('.kmz')) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const k = Object.keys(zip.files).find(n => n.toLowerCase().endsWith('.kml'));
    if (!k) throw new Error('KMZ sem arquivo KML dentro.');
    gj = toGeoJSON.kml(new DOMParser().parseFromString(await zip.file(k).async('string'), 'text/xml'));
  } else if (name.endsWith('.zip')) {
    gj = await shp(await file.arrayBuffer());
    if (Array.isArray(gj)) gj = { type: 'FeatureCollection', features: gj.flatMap(g => g.features) };
  } else gj = JSON.parse(await file.text());
  const polys = polysFromGeoJSON(gj);
  if (!polys.length) throw new Error('Não achei nenhum polígono no arquivo. Ele precisa ter o contorno fechado da área.');
  const b = bboxOf(polys);
  if (b[0] < -180 || b[2] > 180 || b[1] < -90 || b[3] > 90) throw new Error('Coordenadas fora de latitude/longitude. Exporte o arquivo em WGS84 (EPSG:4326).');
  return polys;
}

// ---------- Estado ----------
const S = {
  farms: store('agrosat.farms') || [],
  farmId: store('agrosat.current'),
  suave: store('agrosat.suave') !== false,
  scenes: [], scene: null, result: null, layer: 'ndvi', overlay: null, outline: null, chart: null,
};
const farm = () => S.farms.find(f => f.id === S.farmId);
const saveFarms = () => { store('agrosat.farms', S.farms); store('agrosat.current', S.farmId); };

// ---------- Mapa ----------
const map = L.map('map', { zoomControl: true, attributionControl: true, maxZoom: 19 }).setView([-3.9, -45.1], 8);
// Mapas de fundo: se um não carregar, troca sozinho para o próximo.
const FUNDOS = {
  'Satélite (Esri)': { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', nat: 17, attr: 'Esri World Imagery' },
  'Satélite (Esri, servidor 2)': { url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', nat: 17, attr: 'Esri World Imagery' },
  'Satélite Sentinel‑2 sem nuvens (EOX)': { url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg', nat: 15, attr: 'Sentinel‑2 cloudless 2020 © EOX IT Services (dados Copernicus)' },
  'Mapa de ruas (OpenStreetMap)': { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', nat: 19, attr: '© colaboradores do OpenStreetMap' },
};
const BASES = {};
Object.entries(FUNDOS).forEach(([nome, d]) => { BASES[nome] = L.tileLayer(d.url, { maxZoom: 19, maxNativeZoom: d.nat, attribution: d.attr }); BASES[nome]._nomeFundo = nome; });
let fundoAtual = null;
function usarFundo(nome) {
  if (!BASES[nome]) nome = Object.keys(BASES)[0];
  if (fundoAtual) map.removeLayer(fundoAtual);
  fundoAtual = BASES[nome].addTo(map); fundoAtual.bringToBack();
}
const fundosFalhos = new Set();
Object.values(BASES).forEach(l => {
  let ok = 0, falhas = 0;
  l.on('tileload', () => ok++);
  l.on('tileerror', () => {
    if (++falhas < 4 || ok > 0 || fundoAtual !== l || fundosFalhos.has(l._nomeFundo)) return;
    fundosFalhos.add(l._nomeFundo);
    const prox = Object.keys(BASES).find(n => !fundosFalhos.has(n));
    if (!prox) { toast('Nenhum mapa de fundo carregou. Verifique a internet.', 6000); return; }
    toast(`O fundo "${l._nomeFundo}" não carregou; trocando para "${prox}".`, 4000);
    usarFundo(prox);
  });
});
// só lembra o fundo escolhido à mão; a troca automática vale só para aquela visita
map.on('baselayerchange', e => { fundoAtual = e.layer; store('agrosat.fundoEscolhido', e.layer._nomeFundo); });
usarFundo(store('agrosat.fundoEscolhido') || Object.keys(BASES)[0]);

function drawOutline() {
  if (S.outline) S.outline.remove();
  const f = farm(); if (!f) return;
  const latlngs = f.polys.map(p => p.map(r => r.map(([x, y]) => [y, x])));
  const grp = L.featureGroup();
  (f.divs || []).forEach(d => L.polygon(d.rings.map(r => r.map(([x, y]) => [y, x])), { color: '#fff', weight: 1, opacity: .8, fill: false })
    .bindTooltip(d.nome, { permanent: true, direction: 'center', className: 'divlbl' }).addTo(grp));
  L.polygon(latlngs, { color: '#fff', weight: 2.5, fill: false, dashArray: '5 3' }).addTo(grp);
  S.outline = grp.addTo(map);
  map.fitBounds(S.outline.getBounds(), { padding: [30, 30] });
}

// ---------- STAC ----------
async function stacSearch(polys, from, to, cloud, limit = 200, fk = 's2') {
  const F = FONTES[fk];
  const b = bboxOf(polys);
  const body = {
    collections: [F.col], bbox: b, datetime: `${from}T00:00:00Z/${to}T23:59:59Z`, limit: 100,
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
  };
  if (F.nuvemQuery) body.query = { 'eo:cloud_cover': { lte: cloud } };
  if (!F.nuvemQuery) delete body.sortby;
  let url = `${fk === 's2' ? CFG.stac : F.stac}/search`, items = [], guard = 0, metodo = 'POST';
  while (url && items.length < limit && guard++ < 12) {
    let r = metodo === 'POST' ? await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) : await fetch(url);
    if (!r.ok && metodo === 'POST' && guard === 1 && (r.status === 405 || r.status === 400)) {
      // catálogo que só aceita GET
      metodo = 'GET';
      url = `${F.stac}/search?collections=${F.col}&bbox=${b.join(',')}&datetime=${encodeURIComponent(body.datetime)}&limit=100`;
      r = await fetch(url);
    }
    if (!r.ok) throw new Error(`Catálogo ${F.curto} respondeu ${r.status}`);
    const j = await r.json();
    items.push(...(j.features || []));
    const next = (j.links || []).find(l => l.rel === 'next');
    if (!next) url = null;
    else if (next.body && (next.method || 'POST').toUpperCase() === 'POST') { Object.assign(body, next.body); url = next.href; metodo = 'POST'; }
    else { url = next.href; metodo = 'GET'; }
  }
  items.forEach(it => it._fonte = fk);
  const nuvem = it => { const p = it.properties; return p['eo:cloud_cover'] ?? p.cloud_cover ?? p['cbers:cloud_cover'] ?? 0; };
  items = items.filter(it => nuvem(it) <= cloud);
  // Landsat 7 depois de 2003 tem faixas sem dado (falha do sensor): fica de fora
  if (fk === 'ls') items = items.filter(it => !(it.properties.platform === 'landsat-7' && it.properties.datetime >= '2003-06-01'));
  items.forEach(it => { if (it.properties['eo:cloud_cover'] == null) it.properties['eo:cloud_cover'] = nuvem(it); });
  // Uma cena por dia: a que cobre toda a fazenda, no fuso UTM da fazenda, com menos nuvem
  const farmEPSG = utmEPSG((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
  const covers = it => it.bbox && it.bbox[0] <= b[0] && it.bbox[1] <= b[1] && it.bbox[2] >= b[2] && it.bbox[3] >= b[3];
  const byDay = new Map();
  for (const it of items) {
    const day = it.properties.datetime.slice(0, 10);
    const score = (covers(it) ? 0 : 1000) + (itemEPSG(it) === farmEPSG ? 0 : 500) + (it.properties['eo:cloud_cover'] || 0);
    const cur = byDay.get(day);
    if (!cur || score < cur.score) byDay.set(day, { it, score });
  }
  return [...byDay.values()].map(v => v.it).sort((a, b2) => b2.properties.datetime.localeCompare(a.properties.datetime));
}
function itemEPSG(it) {
  const p = it.properties;
  if (p['proj:epsg']) return +p['proj:epsg'];
  if (p['proj:code']) return +String(p['proj:code']).split(':').pop();
  const a = it.assets.red || it.assets.B04 || {};
  if (a['proj:epsg']) return +a['proj:epsg'];
  if (a['proj:code']) return +String(a['proj:code']).split(':').pop();
  return null;
}
function asset(it, ...keys) { for (const k of keys) if (k && it.assets[k]) return it.assets[k]; return null; }
// asset colorido do CBERS-4A (nome pode variar entre versões do catálogo)
function assetRGB(it) {
  const ks = Object.keys(it.assets);
  const tif = k => /\.tiff?($|\?)/i.test(it.assets[k].href || '') || /tiff/i.test(it.assets[k].type || '');
  const k = ks.find(k => tif(k) && /pca|rgb|tci|visual|fus/i.test(k)) || ks.find(k => tif(k) && !/thumb|quick|preview|mask|cmask/i.test(k));
  return k ? it.assets[k] : null;
}
const qaInvalido = { scl: v => CFG.invalidSCL.has(v), landsat: v => (v & 0x1F) !== 0 };
function detectarOffset(R, NI, mask, SC, meta, inval = qaInvalido.scl) {
  if (!meta) return 0;            // metadados dizem que não há offset
  const v = [];
  for (let i = 0; i < R.length; i++) if (mask[i] && R[i] > 0 && NI[i] > 0 && (!SC || !inval(SC[i]))) v.push(R[i]);
  if (v.length < 20) return 0;
  v.sort((a, b) => a - b);
  // valores abaixo de 1000 provam que a imagem NÃO tem o +1000 (senão a reflectância seria negativa)
  return v[Math.floor(v.length * 0.02)] >= 1000 ? meta : 0;
}
function scaleOffset(it, a) {
  const rb = a && a['raster:bands'] && a['raster:bands'][0];
  const scale = rb && rb.scale != null ? rb.scale : 1e-4;
  // Earth Search v1 "sentinel-2-l2a": os pixels já vêm SEM o +1000, apesar de raster:bands dizer offset -0,1
  // (problema conhecido: github.com/Element84/earth-search/issues/71). Exceção: cenas de 25/01 a 27/02/2022.
  if (it.collection === 'sentinel-2-l2a') {
    const d = (it.properties.datetime || '').slice(0, 10);
    return [scale, d >= '2022-01-25' && d <= '2022-02-27' ? -0.1 : 0];
  }
  if (rb && rb.scale != null) return [scale, rb.offset || 0];
  const pb = parseFloat(it.properties['s2:processing_baseline'] || '0');
  return [scale, pb >= 4 ? -0.1 : 0];
}

// ---------- Leitura das bandas (COG) ----------
const tiffCache = new Map();
// Leitura de GeoTIFF (COG) por partes, sem cache do navegador: o Safari do iPhone às vezes devolve
// do cache o primeiro pedaço do arquivo no lugar do pedaço pedido. Cada resposta é conferida.
const ultimoErroTiff = { msg: '' };
class ClienteTiff {
  constructor(url) { this.url = url; this.n = 0; }
  async request({ headers = {}, signal } = {}) {
    const rg = headers.Range || headers.range || '', pedido = +((rg.match(/bytes=(\d+)/) || [])[1] || 0);
    const via = (u, unico) => {
      if (!unico) return u;
      const sep = u.includes('?') ? '&' : '?';
      return `${u}${sep}agrosat_r=${pedido}-${Date.now() % 1e6}-${this.n++}`;
    };
    let ultimo = null;
    const ponte = /[?&]url=/.test(this.url);
    for (let tent = 0; tent < 3; tent++) {
      // endereço único só pela ponte (servidores de imagem com assinatura recusam parâmetros extras)
      let r;
      try { r = await fetch(via(this.url, ponte), { headers, signal, cache: tent ? 'reload' : 'no-store' }); }
      catch (e) { ultimo = `falha de rede (${e.message})`; if (signal && signal.aborted) throw e; continue; }
      if (r.status === 206 && rg) {
        const cr = r.headers.get('content-range');
        const ini = cr ? +((cr.match(/bytes (\d+)-/) || [])[1]) : pedido;   // alguns servidores não deixam o navegador ler esse cabeçalho
        if (ini !== pedido) { ultimo = `pedi a partir do byte ${pedido} e veio ${cr}`; try { await r.body?.cancel(); } catch (e) { } continue; }
        const buf = await r.arrayBuffer(); return { ok: true, status: 206, getHeader: n => r.headers.get(n), getData: async () => buf };
      }
      if (!r.ok) { ultimo = `o servidor respondeu ${r.status}`; if (r.status === 403 || r.status === 404) break; continue; }
      if (rg) { ultimo = `pedi uma parte e veio o arquivo inteiro (${r.status})`; try { await r.body?.cancel(); } catch (e) { } break; }
      const buf = await r.arrayBuffer(); return { ok: true, status: r.status, getHeader: n => r.headers.get(n), getData: async () => buf };
    }
    ultimoErroTiff.msg = ultimo || 'falha desconhecida';
    return { ok: false, status: 0, getHeader: () => null, getData: async () => new ArrayBuffer(0) };
  }
}
function abrirGeoTIFF(href) {
  return GeoTIFF.fromCustomClient ? GeoTIFF.fromCustomClient(new ClienteTiff(href), { allowFullFile: false }) : GeoTIFF.fromUrl(href, { allowFullFile: false });
}
function openTiff(href) {
  if (!tiffCache.has(href)) tiffCache.set(href, (async () => {
    try { const t = await abrirGeoTIFF(href); await t.getImage(); return t; }
    catch (e) {
      // servidor que não aceita o navegador: tenta pelo servidor-ponte
      const ponte = (typeof CONF !== 'undefined') && CONF.proxy;
      if (!ponte || href.startsWith(ponte) || /amazonaws\.com/.test(href)) throw e;
      const t = await abrirGeoTIFF(`${ponte}/?url=${encodeURIComponent(href)}`); await t.getImage(); return t;
    }
  })());
  const p = tiffCache.get(href); p.catch(() => tiffCache.delete(href));
  return p;
}
// Lê um recorte; se a leitura direta falhar (servidor que recusa parte dos pedidos do navegador), refaz pelo servidor-ponte.
async function lerRasters(href, opts) {
  try { const t = await openTiff(href); return await t.readRasters(opts); }
  catch (e) {
    const ponte = (typeof CONF !== 'undefined') && CONF.proxy;
    if (!ponte || href.startsWith(ponte) || /amazonaws\.com/.test(href)) throw e;
    console.warn('leitura direta falhou, tentando pela ponte:', e.message);
    try { const t = await openTiff(`${ponte}/?url=${encodeURIComponent(href)}`); return await t.readRasters(opts); }
    catch (e2) { throw new Error(`direto: ${detalheErro(e)} · pela ponte: ${detalheErro(e2)}`); }
  }
}
function detalheErro(e) {
  const dentro = e && e.errors && e.errors[0];
  let m = (e && e.message) || String(e);
  if (dentro && dentro.message && dentro.message !== m) m += ` (${dentro.message})`;
  if (/Request failed|Error fetching/i.test(m) && ultimoErroTiff.msg) { m += ` — ${ultimoErroTiff.msg}`; ultimoErroTiff.msg = ''; }
  return m;
}
function makeGrid(polys, epsg, res, divs) {
  const f = toUTM(epsg);
  const up = polys.map(p => p.map(r => r.map(f)));
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  up.forEach(p => p[0].forEach(([x, y]) => { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }));
  const pad = res * 2;
  b = [Math.floor((b[0] - pad) / res) * res, Math.floor((b[1] - pad) / res) * res, Math.ceil((b[2] + pad) / res) * res, Math.ceil((b[3] + pad) / res) * res];
  let W = Math.round((b[2] - b[0]) / res), H = Math.round((b[3] - b[1]) / res);
  const k = Math.max(1, Math.max(W, H) / CFG.maxPx);
  if (k > 1) { res *= k; W = Math.round((b[2] - b[0]) / res); H = Math.round((b[3] - b[1]) / res); }
  const mask = new Uint8Array(W * H);
  // máscara do perímetro (exterior menos furos), varrendo linha a linha
  for (let j = 0; j < H; j++) {
    const y = b[3] - (j + 0.5) * res;
    for (let i = 0; i < W; i++) {
      const x = b[0] + (i + 0.5) * res;
      for (const p of up) {
        if (pip(x, y, p[0]) && !p.slice(1).some(h => pip(x, y, h))) { mask[j * W + i] = 1; break; }
      }
    }
  }
  const ll = toLL(epsg);
  const corners = [[b[0], b[1]], [b[0], b[3]], [b[2], b[1]], [b[2], b[3]]].map(ll);
  const lats = corners.map(c => c[1]), lons = corners.map(c => c[0]);
  const bounds = [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]];
  let n = 0; for (let i = 0; i < mask.length; i++) n += mask[i];
  let div = null;
  if (divs && divs.length) {
    div = new Uint8Array(W * H);
    const ud = divs.map(d => d.rings.map(r => r.map(f)));
    for (let j = 0; j < H; j++) {
      const y = b[3] - (j + 0.5) * res;
      for (let i = 0; i < W; i++) {
        if (!mask[j * W + i]) continue;
        const x = b[0] + (i + 0.5) * res;
        for (let k = 0; k < ud.length; k++) if (pip(x, y, ud[k][0]) && !ud[k].slice(1).some(h => pip(x, y, h))) { div[j * W + i] = k + 1; break; }
      }
    }
  }
  return { epsg, res, bbox: b, W, H, mask, bounds, nIn: n, div };
}
const gridCache = new Map();
function grid(polys, epsg, res) {
  const k = `${S.farmId}|${epsg}|${res}`;
  if (!gridCache.has(k)) gridCache.set(k, makeGrid(polys, epsg, res, farm() && farm().divs));
  return gridCache.get(k);
}
async function readBand(it, keys, g, samples) {
  const a = keys && asset(it, ...keys); if (!a) throw new Error(`Banda ${keys ? keys[0] : ''} indisponível nesta cena.`);
  const tiff = await openTiff(await assinarHref(fonteDe(it), a.href));
  const r = await tiff.readRasters({ bbox: g.bbox, width: g.W, height: g.H, resampleMethod: 'nearest', fillValue: 0, samples });
  return { data: r, so: scaleOffset(it, a) };
}

async function processCBERS(it, res) {
  const f = farm(), a = assetRGB(it); if (!a) throw new Error('cena CBERS sem imagem colorida');
  const tiff = await openTiff(a.href), img = await tiff.getImage(), gk = img.getGeoKeys() || {};
  let epsg = gk.ProjectedCSTypeGeoKey || gk.GeographicTypeGeoKey || itemEPSG(it) || 4326;
  if (epsg === 32767 || !epsg) epsg = itemEPSG(it) || 4326;
  const geo = epsg === 4326 || epsg === 4674;
  const g = grid(f.polys, epsg, geo ? res / 111320 : res);
  const data = await tiff.readRasters({ bbox: g.bbox, width: g.W, height: g.H, resampleMethod: 'bilinear', fillValue: 0 });
  const N = g.W * g.H, cloud = new Uint8Array(N), nada = new Float32Array(N).fill(NaN);
  return { it, g, ndvi: nada, ndre: nada, cloud, rgb: { tci: true, data: data.length >= 3 ? data : [data[0], data[0], data[0]] }, nIn: g.nIn, nCloud: 0, stats: null, statsRE: null, divStats: null, soRGB: true };
}
async function processScene(it, res, withRGB = true) {
  const F = fonteDe(it);
  if (F.soRGB) return processCBERS(it, res || F.res);
  res = res || F.res;
  const f = farm(); const epsg = itemEPSG(it) || utmEPSG(...bboxCenter(f.polys));
  const g = grid(f.polys, epsg, res);
  const [red, nir, re1, scl] = await Promise.all([
    readBand(it, F.red, g, [0]), readBand(it, F.nir, g, [0]),
    F.re ? readBand(it, F.re, g, [0]).catch(() => null) : null, readBand(it, F.qa, g, [0]).catch(() => null),
  ]);
  const inval = qaInvalido[F.qaTipo];
  const N = g.W * g.H, ndvi = new Float32Array(N).fill(NaN), ndre = new Float32Array(N).fill(NaN), cloud = new Uint8Array(N);
  const R = red.data[0], NI = nir.data[0], RE = re1 ? re1.data[0] : null, SC = scl ? scl.data[0] : null;
  // Calibração: imagens Sentinel-2 mais novas somam +1000 aos valores (offset de -0,1 na reflectância),
  // mas nem todas as cenas do catálogo vêm assim, e os metadados nem sempre batem.
  // Decide pela própria imagem: com offset, o vermelho quase nunca fica abaixo de 1000.
  const off = detectarOffset(R, NI, g.mask, SC, red.so[1], inval);
  const so = (x, s) => x * s[0] + off;
  let nIn = 0, nCloud = 0;
  for (let i = 0; i < N; i++) {
    if (!g.mask[i]) continue; nIn++;
    if ((SC && inval(SC[i])) || R[i] === 0 || NI[i] === 0) { cloud[i] = 1; nCloud++; continue; }
    const r = so(R[i], red.so), n = so(NI[i], nir.so), e = RE ? so(RE[i], re1.so) : NaN;
    if (r <= 0 || n <= 0) continue;
    const v = (n - r) / (n + r), w = e > 0 ? (n - e) / (n + e) : NaN;
    // sombra de nuvem que o filtro do satélite deixou passar: tudo escuro (vermelho e infravermelho baixos), mas não é água
    if (v > 0.05 && n < 0.13 && r < 0.035) { cloud[i] = 1; nCloud++; continue; }
    ndvi[i] = v > 1 || v < -1 ? NaN : v;
    ndre[i] = w > 1 || w < -1 ? NaN : w;
  }
  // as bordas de nuvem e sombra escapam da máscara: alarga 20 m (2 pixels de 10 m; 1 pixel no Landsat)
  nCloud += alargarMascara(cloud, ndvi, ndre, g, res <= 10 ? 2 : 1);
  let rgb = null;
  if (withRGB) {
    const vis = F.vis && asset(it, ...F.vis);
    try {
      if (vis) { const t = await openTiff(await assinarHref(F, vis.href)); rgb = { tci: true, data: await t.readRasters({ bbox: g.bbox, width: g.W, height: g.H, resampleMethod: 'nearest', fillValue: 0 }) }; }
      else { const [gr, bl] = await Promise.all([readBand(it, F.g, g, [0]), readBand(it, F.b, g, [0])]); rgb = { tci: false, r: red, g: gr, b: bl }; }
    } catch (e) { rgb = null; }
  }
  const divStats = calcDivStats(f, g, ndvi, ndre, cloud);
  return { it, g, ndvi, ndre, cloud, rgb, nIn, nCloud, stats: statsOf(ndvi, g.mask), statsRE: statsOf(ndre, g.mask), divStats };
}
function calcDivStats(f, g, ndvi, ndre, cloud) {
  let divStats = null; const N = g.W * g.H;
  if (g.div) {
    const nd = f.divs.length, acc = Array.from({ length: nd + 1 }, () => ({ n: 0, s: 0, sr: 0, nr: 0, nub: 0, tot: 0 }));
    for (let i = 0; i < N; i++) {
      if (!g.mask[i]) continue;
      const k = g.div[i] || nd + 1; const a = acc[k - 1]; a.tot++;
      if (cloud[i]) { a.nub++; continue; }
      if (!Number.isNaN(ndvi[i])) { a.n++; a.s += ndvi[i]; }
      if (!Number.isNaN(ndre[i])) { a.nr++; a.sr += ndre[i]; }
    }
    const linha = (nome, area, a, fora) => { const nuvem = a.tot ? a.nub / a.tot : 0, ok = a.n && nuvem < 0.8; return { nome, area, fora, ndvi: ok ? a.s / a.n : NaN, ndre: ok && a.nr ? a.sr / a.nr : NaN, nuvem }; };
    divStats = f.divs.map((d, k) => linha(d.nome, areaHa([d.rings]), acc[k]));
    const foraHa = acc[nd].tot * g.res * g.res / 1e4;
    if (foraHa >= 0.5) divStats.push(linha('Fora das divisões', foraHa, acc[nd], true));
  }
  return divStats;
}
function alargarMascara(cloud, ndvi, ndre, g, r) {
  if (r < 1) return 0;
  const W = g.W, H = g.H, orig = cloud.slice(); let novos = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x; if (orig[k] || !g.mask[k]) continue;
    let perto = false;
    for (let dy = -r; dy <= r && !perto; dy++) for (let dx = -r; dx <= r; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; if (orig[yy * W + xx]) { perto = true; break; } }
    if (perto) { cloud[k] = 1; ndvi[k] = NaN; ndre[k] = NaN; novos++; }
  }
  return novos;
}
function bboxCenter(polys) { const b = bboxOf(polys); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }
const zoneThr = st => st.mean - 1.2 * st.sd; // bem abaixo da média da própria área
function statsOf(arr, mask) {
  const v = []; for (let i = 0; i < arr.length; i++) if (mask[i] && !Number.isNaN(arr[i])) v.push(arr[i]);
  if (!v.length) return null;
  v.sort((a, b) => a - b);
  const q = p => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length);
  return { n: v.length, mean, sd, min: v[0], max: v[v.length - 1], p10: q(.1), p50: q(.5), p90: q(.9), vals: v };
}

// ---------- Cores ----------
const RAMP_NDVI = [[-0.1, [165, 0, 38]], [0.15, [215, 48, 39]], [0.3, [244, 109, 67]], [0.4, [254, 224, 139]], [0.5, [217, 239, 139]], [0.6, [166, 217, 106]], [0.7, [102, 189, 99]], [0.8, [26, 152, 80]], [0.9, [0, 104, 55]]];
const RAMP_NDRE = [[0.0, [165, 0, 38]], [0.1, [244, 109, 67]], [0.2, [254, 224, 139]], [0.3, [166, 217, 106]], [0.4, [26, 152, 80]], [0.5, [0, 104, 55]]];
const RAMP_DIFF = [[-0.3, [178, 24, 43]], [-0.15, [239, 138, 98]], [-0.03, [247, 247, 247]], [0.03, [247, 247, 247]], [0.15, [127, 191, 123]], [0.3, [27, 120, 55]]];
function ramp(stops, v) {
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) if (v <= stops[i][0]) {
    const [a, ca] = stops[i - 1], [b, cb] = stops[i], t = (v - a) / (b - a);
    return [0, 1, 2].map(k => Math.round(ca[k] + (cb[k] - ca[k]) * t));
  }
  return stops[stops.length - 1][1];
}
const cssGrad = stops => `linear-gradient(90deg,${stops.map(([v, c], i) => `rgb(${c}) ${(i / (stops.length - 1) * 100).toFixed(0)}%`).join(',')})`;

// Cor real com contraste ajustado: corta 2% dos extremos de cada canal (dentro da área), gama leve e um pouco mais de saturação.
// A imagem "visual" pronta do Sentinel-2 sai lavada e avermelhada em áreas pequenas.
function esticarRGB(res) {
  if (res._est) return res._est;
  const { g } = res, N = g.W * g.H, cr = res.rgb;
  const bruto = (c, i) => cr.tci ? cr.data[c][i] / 255 : Math.max(0, cr[['r', 'g', 'b'][c]].data[0][i] * cr[['r', 'g', 'b'][c]].so[0] + cr[['r', 'g', 'b'][c]].so[1]);
  const est = [0, 1, 2].map(c => {
    const v = [];
    for (let i = 0; i < N; i += 1) { if (!g.mask[i]) continue; const x = bruto(c, i); if (x > 0) v.push(x); }
    if (v.length < 20) for (let i = 0; i < N; i++) { const x = bruto(c, i); if (x > 0) v.push(x); }
    v.sort((a, b) => a - b);
    const q = p => v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : 0;
    return [q(0.02), Math.max(q(0.98), q(0.02) + 1e-3)];
  });
  // mesma escala nos 3 canais (mantém a cor natural), com o pior caso de cada ponta
  const lo = Math.min(...est.map(e => e[0])), hi = Math.max(...est.map(e => e[1]));
  res._est = { bruto, lo, hi };
  return res._est;
}
function renderCanvas(res, layer, suave) { return renderCanvasEl(res, layer, suave).toDataURL('image/png'); }
function renderCanvasEl(res, layer, suave) {
  const { g } = res, cv = document.createElement('canvas'); cv.width = g.W; cv.height = g.H;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(g.W, g.H), d = img.data;
  const st = res.stats, thr = st ? zoneThr(st) : -1;
  for (let i = 0; i < g.W * g.H; i++) {
    const o = i * 4;
    if (layer === 'rgb') {
      if (!res.rgb) continue;
      const E = esticarRGB(res);
      const r0 = E.bruto(0, i), g0 = E.bruto(1, i), b0 = E.bruto(2, i);
      if (r0 + g0 + b0 === 0) continue;
      const t = x => Math.pow(Math.max(0, Math.min(1, (x - E.lo) / (E.hi - E.lo))), 0.9);
      let r = t(r0), gg = t(g0), b = t(b0);
      const lum = 0.3 * r + 0.59 * gg + 0.11 * b, sat = 1.2;
      r = Math.max(0, Math.min(255, (lum + (r - lum) * sat) * 255)); gg = Math.max(0, Math.min(255, (lum + (gg - lum) * sat) * 255)); b = Math.max(0, Math.min(255, (lum + (b - lum) * sat) * 255));
      d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = g.mask[i] ? 255 : 110;
      continue;
    }
    if (!g.mask[i]) continue;
    if (res.cloud[i]) { d[o] = d[o + 1] = d[o + 2] = 200; d[o + 3] = 170; continue; }
    if (layer === 'diff') {
      const v = res.diff[i]; if (Number.isNaN(v)) continue;
      const c = ramp(RAMP_DIFF, v); d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; continue;
    }
    const v = layer === 'ndre' ? res.ndre[i] : res.ndvi[i];
    if (Number.isNaN(v)) continue;
    if (layer === 'zonas') {
      if (v < thr) { d[o] = 255; d[o + 1] = 40; d[o + 2] = 200; d[o + 3] = 255; }
      else { const c = ramp(RAMP_NDVI, v); d[o] = c[0] * .45; d[o + 1] = c[1] * .45; d[o + 2] = c[2] * .45; d[o + 3] = 200; }
      continue;
    }
    const c = ramp(layer === 'ndre' ? RAMP_NDRE : RAMP_NDVI, v);
    d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
  }
  if (layer === 'rgb') realcar(d, g.W, g.H, 0.6);
  ctx.putImageData(img, 0, 0);
  if (suave === undefined ? S.suave : suave) {
    // amplia com interpolação: mesma informação de 10 m, sem os quadrados
    const k = Math.max(1, Math.min(8, Math.floor(2400 / Math.max(g.W, g.H))));
    if (k > 1) {
      const big = document.createElement('canvas'); big.width = g.W * k; big.height = g.H * k;
      const bx = big.getContext('2d'); bx.imageSmoothingEnabled = true; bx.imageSmoothingQuality = 'high';
      bx.drawImage(cv, 0, 0, big.width, big.height);
      return big;
    }
  }
  return cv;
}
// realce de bordas (máscara de nitidez 3x3) feito na resolução original, antes de ampliar
function realcar(d, W, H, q) {
  const src = new Uint8ClampedArray(d);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const o = (y * W + x) * 4; if (!src[o + 3]) continue;
    for (let c = 0; c < 3; c++) {
      const v = src[o + c], viz = src[o - 4 + c] + src[o + 4 + c] + src[o - W * 4 + c] + src[o + W * 4 + c];
      if (!src[o - 4 + 3] || !src[o + 4 + 3] || !src[o - W * 4 + 3] || !src[o + W * 4 + 3]) continue;
      d[o + c] = v + q * (4 * v - viz);
    }
  }
}
function showLayer() {
  const res = S.result; if (!res) return;
  if (S.overlay) S.overlay.remove();
  S.overlay = L.imageOverlay(renderCanvas(res, S.layer), res.g.bounds, { opacity: $('opacity').value / 100, className: S.suave ? 'suave' : 'pix' }).addTo(map);
  if (S.outline) S.outline.bringToFront();
  document.querySelectorAll('#layerSeg button').forEach(b => {
    b.classList.toggle('on', b.dataset.layer === S.layer);
    b.hidden = res.isDiff ? b.dataset.layer !== 'diff' : res.soRGB ? b.dataset.layer !== 'rgb' : b.dataset.layer === 'diff';
  });
  $('layerbar').hidden = false;
  legend();
}
function legend() {
  const L_ = $('legend'), res = S.result; L_.hidden = false;
  const quando = res.composto ? `imagem limpa: ${res.composto.n} passagens, ${dBR(res.composto.de)} a ${dBR(res.composto.ate)}` : dBR(res.it.properties.datetime);
  if (S.layer === 'rgb') { L_.innerHTML = `<b>Cor real · ${fonteDe(res.it).curto} ${fonteDe(res.it).res} m</b><div class="ends"><span>${quando}</span></div>`; return; }
  if (S.layer === 'diff') { L_.innerHTML = `<b>Variação do NDVI</b><div class="grad" style="background:${cssGrad(RAMP_DIFF)}"></div><div class="ends"><span>caiu −0,3</span><span>0</span><span>subiu +0,3</span></div>`; return; }
  if (S.layer === 'zonas') { L_.innerHTML = `<b>Zonas de atenção</b><div class="ends"><span><i style="display:inline-block;width:10px;height:10px;background:#ff28c8;border-radius:2px"></i> NDVI bem abaixo da média da área</span></div><div class="ends"><span>Limite: NDVI &lt; ${fmt(zoneThr(res.stats))}</span></div>`; return; }
  const ndre = S.layer === 'ndre', st = ndre ? RAMP_NDRE : RAMP_NDVI;
  L_.innerHTML = `<b>${ndre ? 'NDRE' : 'NDVI'} — vigor da vegetação</b><div class="grad" style="background:${cssGrad(st)}"></div><div class="ends"><span>pouca (${fmt(st[0][0], 1)})</span><span>muita (${fmt(st[st.length - 1][0], 1)})</span></div><div class="ends"><span><i style="display:inline-block;width:10px;height:10px;background:#c8c8c8;border-radius:2px"></i> nuvem/sombra</span></div>${res.composto ? `<div class="ends"><span>${quando}</span></div>` : ''}`;
}

// ---------- Painéis ----------
function renderFarmSelect() {
  const sel = $('farmSelect');
  sel.innerHTML = S.farms.length ? S.farms.map(f => `<option value="${f.id}">${esc(f.name)}${f.owner ? ' — ' + esc(f.owner) : ''}</option>`).join('') : '<option>Nenhuma fazenda</option>';
  sel.disabled = !S.farms.length; $('btnDelFarm').disabled = !S.farms.length;
  if (S.farmId) sel.value = S.farmId;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function selectFarm(id) {
  S.farmId = id; saveFarms();
  S.scenes = []; S.scene = null; S.result = null; S.seriesData = null; S.extra = null;
  if (S.overlay) { S.overlay.remove(); S.overlay = null; }
  $('layerbar').hidden = true; $('legend').hidden = true; $('stats').hidden = true; $('cmpStats').hidden = true;
  $('scenes').innerHTML = ''; $('searchInfo').textContent = ''; $('serieSum').textContent = '';
  if (S.chart) { S.chart.destroy(); S.chart = null; }
  const f = farm();
  $('emptyState').hidden = !!f; $('farmPanel').hidden = !f;
  renderFarmSelect();
  if (window.onFarmChange && !f) window.onFarmChange(null);
  if (!f) return;
  $('farmName').textContent = f.name;
  $('farmArea').textContent = `${fmt(f.area, f.area < 100 ? 1 : 0)} ha`;
  drawOutline(); fillCompare();
  if (window.onFarmChange) window.onFarmChange(f);
}

function renderScenes() {
  const box = $('scenes');
  box.innerHTML = S.scenes.map((it, k) => {
    const p = it.properties, th = asset(it, 'thumbnail');
    return `<button class="scene${S.scene === it ? ' on' : ''}" data-k="${k}">
      ${th ? `<img loading="lazy" src="${th.href}" alt="">` : '<img alt="">'}
      <div><div class="d">${dBR(p.datetime)}</div>
      <div class="m">${esc(String(p.platform || fonteDe(it).curto).replace(/^sentinel-/i, 'Sentinel-').replace(/^landsat-/i, 'Landsat ').toUpperCase())} · ${fonteDe(it).res} m · ☁ ${fmt(p['eo:cloud_cover'] || 0, 1)}% na cena</div>
      <div class="m">${fonteDe(it).soRGB ? 'Toque para ver a imagem colorida de 2 m' : 'Toque para ver NDVI na fazenda'}</div></div></button>`;
  }).join('');
}

function renderStats(res) {
  const st = res.stats, el = $('stats'); el.hidden = false;
  const f = farm(), pxHa = (res.g.res * res.g.res) / 1e4;
  const pctCloud = res.nIn ? res.nCloud / res.nIn * 100 : 0;
  if (res.soRGB) { el.innerHTML = `<h4>${dBR(res.it.properties.datetime)} · CBERS‑4A</h4><p class="hint">Imagem colorida de 2 m (fusão pancromática do INPE). Ótima para enxergar cercas, estradas, sede, aguadas e falhas de pasto, mas não tem infravermelho, então não calcula NDVI. Para vigor da vegetação, use Sentinel‑2 ou Landsat.</p>`; return; }
  if (!st) { el.innerHTML = `<h4>${dBR(res.it.properties.datetime)}</h4><p class="hint">A fazenda está toda coberta por nuvem nessa data. Escolha outra.</p>`; return; }
  const cls = [['Solo/pasto degradado', -1, 0.3, '#d73027'], ['Vigor baixo', 0.3, 0.5, '#fdae61'], ['Vigor bom', 0.5, 0.7, '#a6d96a'], ['Vigor alto', 0.7, 2, '#1a9850']];
  const tot = st.n;
  const bars = cls.map(([n, a, b, c]) => {
    const k = st.vals.filter(v => v >= a && v < b).length, pc = k / tot * 100;
    return `<div class="bar"><span>${n}</span><div class="trk"><i style="width:${pc}%;background:${c}"></i></div><span>${fmt(pc, 0)}%</span></div>`;
  }).join('');
  const thr = zoneThr(st);
  const zonasHa = st.vals.filter(v => v < thr).length * pxHa;
  el.innerHTML = `<h4>${res.composto ? `Imagem limpa · ${res.composto.n} passagens de ${dBR(res.composto.de)} a ${dBR(res.composto.ate)}` : dBR(res.it.properties.datetime)} · ${esc(f.name)}</h4>
    <div class="kpis">
      <div class="kpi"><b>${fmt(st.mean)}</b><span>NDVI médio</span></div>
      <div class="kpi"><b>${res.statsRE ? fmt(res.statsRE.mean) : '—'}</b><span>NDRE médio</span></div>
      <div class="kpi"><b>${fmt(pctCloud, 0)}%</b><span>área com nuvem</span></div>
      <div class="kpi"><b>${fmt(st.p10)}</b><span>NDVI pior 10%</span></div>
      <div class="kpi"><b>${fmt(st.p90)}</b><span>NDVI melhor 10%</span></div>
      <div class="kpi"><b>${fmt(zonasHa, zonasHa < 10 ? 1 : 0)} ha</b><span>zonas de atenção</span></div>
    </div>
    <div class="bars">${bars}</div>${tabelaDivs(res.divStats)}
    <p class="hint">Faixas de referência para pasto tropical. Compare sempre a mesma área ao longo do tempo: a queda no NDVI importa mais que o número isolado.</p>`;
}

function classeNDVI(v) { return v < 0.3 ? ['Solo/degradado', '#d73027'] : v < 0.5 ? ['Vigor baixo', '#fdae61'] : v < 0.7 ? ['Vigor bom', '#a6d96a'] : ['Vigor alto', '#1a9850']; }
function tabelaDivs(ds, imprimir) {
  if (!ds || !ds.length) return '';
  const ord = [...ds.filter(d => !d.fora)].sort((a, b) => (Number.isNaN(a.ndvi) ? 9 : a.ndvi) - (Number.isNaN(b.ndvi) ? 9 : b.ndvi)).concat(ds.filter(d => d.fora));
  const linhas = ord.map(d => {
    const [c, cor] = Number.isNaN(d.ndvi) ? ['Coberta por nuvem', '#999'] : classeNDVI(d.ndvi);
    return `<tr${d.fora ? ' style="opacity:.75;font-style:italic"' : ''}><td>${esc(d.nome)}</td><td>${fmt(d.area, 1)}</td><td><b>${Number.isNaN(d.ndvi) ? '—' : fmt(d.ndvi)}</b></td><td>${Number.isNaN(d.ndre) ? '—' : fmt(d.ndre)}</td><td><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${cor}"></span> ${c}${d.nuvem > 0.2 ? ` <small>(☁ ${fmt(d.nuvem * 100, 0)}%)</small>` : ''}</td></tr>`;
  }).join('');
  return `<h4 style="margin-top:14px">Por divisão (pior → melhor)</h4><table class="tb"><tr><th>Divisão</th><th>ha</th><th>NDVI</th><th>NDRE</th><th>Situação</th></tr>${linhas}</table>`;
}

async function openScene(it) {
  S.scene = it; renderScenes();
  busy(true, `Baixando o recorte de ${dBR(it.properties.datetime)}…`);
  try {
    S.result = await processScene(it, null, true);
    if (S.layer === 'diff' || S.result.soRGB) S.layer = S.result.soRGB ? 'rgb' : 'ndvi';
    showLayer(); renderStats(S.result);
  } catch (e) { console.error(e); toast('Não consegui processar essa imagem: ' + e.message, 6000); }
  finally { busy(false); }
}

async function doSearch() {
  const f = farm(); if (!f) return;
  const from = $('dFrom').value, to = $('dTo').value, cloud = +$('cloudMax').value;
  if (!from || !to || from > to) return toast('Confira as datas.');
  $('btnSearch').disabled = true; busy(true, 'Buscando imagens no catálogo…');
  try {
    const fk = $('fonteImg').value;
    busy(true, `Buscando imagens ${FONTES[fk].curto}…`);
    S.scenes = await stacSearch(f.polys, from, to, cloud, 200, fk);
    $('searchInfo').textContent = S.scenes.length ? `${S.scenes.length} ${S.scenes.length === 1 ? 'imagem encontrada' : 'imagens encontradas'} entre ${dBR(from)} e ${dBR(to)}.` : 'Nenhuma imagem nesse período com esse limite de nuvens. Aumente o período ou o limite.';
    renderScenes(); fillCompare();
    if (S.scenes.length) openScene(S.scenes[0]);
  } catch (e) { console.error(e); toast('Falha na busca: ' + e.message + '. Verifique a internet.', 6000); }
  finally { $('btnSearch').disabled = false; busy(false); }
}

// ---------- Histórico ----------
async function pool(items, n, fn) { let i = 0; const out = []; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }
async function doSerie() {
  const f = farm(); if (!f) return;
  const meses = +$('serieMeses').value, cloud = +$('serieNuvem').value;
  const to = new Date(), from = new Date(); from.setMonth(from.getMonth() - meses);
  $('btnSerie').disabled = true; busy(true, 'Buscando imagens do período…');
  try {
    const fk = $('fonteSerie').value;
    let items = (await stacSearch(f.polys, isoDay(from), isoDay(to), cloud, fk === 'ls' ? 2000 : 600, fk)).reverse();
    // períodos longos: no máximo 1 imagem por mês (ou por trimestre acima de 5 anos), a de menos nuvem
    if (meses > 24) {
      const passo = meses > 60 ? 3 : 1, grupos = new Map();
      for (const it of items) {
        const d = it.properties.datetime, k = d.slice(0, 4) + '-' + Math.floor((+d.slice(5, 7) - 1) / passo);
        const c = grupos.get(k); if (!c || it.properties['eo:cloud_cover'] < c.properties['eo:cloud_cover']) grupos.set(k, it);
      }
      items = [...grupos.values()].sort((x, y) => x.properties.datetime.localeCompare(y.properties.datetime));
    }
    let done = 0;
    const rows = await pool(items, 4, async it => {
      try {
        const r = await processScene(it, fk === 's2' ? CFG.serieRes : null, false);
        busy(true, `Calculando NDVI ${++done}/${items.length}…`);
        const valid = r.nIn ? (r.nIn - r.nCloud) / r.nIn : 0;
        if (!r.stats || valid < 0.6) return null;
        return { it, date: it.properties.datetime.slice(0, 10), ndvi: r.stats.mean, ndre: r.statsRE ? r.statsRE.mean : null, valid };
      } catch (e) { busy(true, `Calculando NDVI ${++done}/${items.length}…`); return null; }
    });
    S.seriesData = rows.filter(Boolean);
    drawChart();
  } catch (e) { console.error(e); toast('Falha no histórico: ' + e.message, 6000); }
  finally { $('btnSerie').disabled = false; busy(false); }
}
function drawChart() {
  const rows = S.seriesData || [];
  if (S.chart) S.chart.destroy();
  const ctx = $('chart');
  S.chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: rows.map(r => dBR(r.date)),
      datasets: [
        { label: 'NDVI', data: rows.map(r => r.ndvi), borderColor: '#3ecf6e', backgroundColor: '#3ecf6e', tension: .3, pointRadius: 3 },
        { label: 'NDRE', data: rows.map(r => r.ndre), borderColor: '#f2c14e', backgroundColor: '#f2c14e', tension: .3, pointRadius: 2, borderDash: [4, 3] },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      scales: { y: { min: 0, max: 1, ticks: { color: '#9db3a4' }, grid: { color: '#24382b' } }, x: { ticks: { color: '#9db3a4', maxRotation: 0, autoSkip: true, maxTicksLimit: 6 }, grid: { display: false } } },
      plugins: { legend: { labels: { color: '#e8f0ea' } }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmt(c.parsed.y)}` } } },
      onClick: (e, els) => { if (els.length) { const r = rows[els[0].index]; switchTab('imagens'); if (!S.scenes.includes(r.it)) { S.scenes.unshift(r.it); S.scenes.sort((a, b) => b.properties.datetime.localeCompare(a.properties.datetime)); fillCompare(); } openScene(r.it); } },
    },
  });
  if (!rows.length) { $('serieSum').textContent = 'Nenhuma data com céu limpo suficiente sobre a fazenda. Tente um período maior ou aceite mais nuvem.'; return; }
  const last = rows[rows.length - 1], max = rows.reduce((a, b) => b.ndvi > a.ndvi ? b : a), min = rows.reduce((a, b) => b.ndvi < a.ndvi ? b : a);
  $('serieSum').innerHTML = `${rows.length} datas com céu limpo. Último NDVI: <b>${fmt(last.ndvi)}</b> (${dBR(last.date)}). Maior: <b>${fmt(max.ndvi)}</b> em ${dBR(max.date)}. Menor: <b>${fmt(min.ndvi)}</b> em ${dBR(min.date)}.`;
}

// ---------- Comparar ----------
function fillCompare() {
  const opts = S.scenes.map((it, k) => `<option value="${k}">${dBR(it.properties.datetime)} (☁ ${fmt(it.properties['eo:cloud_cover'] || 0, 0)}%)</option>`).join('') || '<option value="">Busque imagens na aba 1</option>';
  $('cmpA').innerHTML = opts; $('cmpB').innerHTML = opts;
  if (S.scenes.length > 1) { $('cmpA').value = String(S.scenes.length - 1); $('cmpB').value = '0'; }
}
async function doCompare() {
  const a = S.scenes[+$('cmpA').value], b = S.scenes[+$('cmpB').value];
  if (!a || !b || a === b) return toast('Escolha duas datas diferentes.');
  if (itemEPSG(a) !== itemEPSG(b)) return toast('Essas duas imagens estão em fusos UTM diferentes; escolha outras datas.');
  busy(true, 'Comparando as duas datas…');
  try {
    if (fonteDe(a).soRGB || fonteDe(b).soRGB) throw new Error('o CBERS‑4A não tem infravermelho; compare com Sentinel‑2 ou Landsat');
    const [ra, rb] = await Promise.all([processScene(a, null, false), processScene(b, null, false)]);
    const N = ra.g.W * ra.g.H, diff = new Float32Array(N).fill(NaN), cloud = new Uint8Array(N);
    let up = 0, down = 0, n = 0;
    for (let i = 0; i < N; i++) {
      if (!ra.g.mask[i]) continue;
      if (ra.cloud[i] || rb.cloud[i]) { cloud[i] = 1; continue; }
      const v = rb.ndvi[i] - ra.ndvi[i]; if (Number.isNaN(v)) continue;
      diff[i] = v; n++; if (v > 0.1) up++; else if (v < -0.1) down++;
    }
    const pxHa = ra.g.res * ra.g.res / 1e4;
    S.result = { ...rb, diff, cloud, isDiff: true }; S.layer = 'diff'; showLayer();
    const el = $('cmpStats'); el.hidden = false;
    el.innerHTML = `<h4>${dBR(a.properties.datetime)} → ${dBR(b.properties.datetime)}</h4>
      <div class="kpis">
        <div class="kpi"><b>${ra.stats ? fmt(ra.stats.mean) : '—'}</b><span>NDVI antes</span></div>
        <div class="kpi"><b>${rb.stats ? fmt(rb.stats.mean) : '—'}</b><span>NDVI depois</span></div>
        <div class="kpi"><b>${ra.stats && rb.stats ? (rb.stats.mean >= ra.stats.mean ? '+' : '') + fmt(rb.stats.mean - ra.stats.mean) : '—'}</b><span>variação</span></div>
        <div class="kpi"><b>${fmt(up * pxHa, 0)} ha</b><span>subiu &gt; 0,1</span></div>
        <div class="kpi"><b>${fmt(down * pxHa, 0)} ha</b><span>caiu &gt; 0,1</span></div>
        <div class="kpi"><b>${fmt(n * pxHa, 0)} ha</b><span>área comparada</span></div>
      </div>`;
  } catch (e) { console.error(e); toast('Falha na comparação: ' + e.message, 6000); }
  finally { busy(false); }
}

// ---------- Abas e eventos ----------
function switchTab(t) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  ['imagens', 'serie', 'comparar', 'situacao', 'clima', 'uso', 'terreno'].forEach(k => $('tab-' + k).hidden = k !== t);
  if (['imagens', 'serie', 'comparar'].includes(t) && typeof voltarParaSatelite === 'function') voltarParaSatelite();
  if (t !== 'comparar' && S.result && S.result.isDiff && S.scene) openScene(S.scene);
}
$('tabs').onclick = e => { const b = e.target.closest('button'); if (b) switchTab(b.dataset.tab); };
$('layerSeg').onclick = e => { const b = e.target.closest('button'); if (!b || !S.result) return; S.layer = b.dataset.layer; showLayer(); };
$('layerSeg').insertAdjacentHTML('beforeend', '<button data-layer="diff" hidden>Diferença</button>');
$('opacity').oninput = e => S.overlay && S.overlay.setOpacity(e.target.value / 100);
$('cloudMax').oninput = e => $('cloudVal').textContent = e.target.value;
$('btnSearch').onclick = doSearch;
$('btnSerie').onclick = doSerie;
$('btnCompare').onclick = doCompare;
$('scenes').onclick = e => { const b = e.target.closest('.scene'); if (b) openScene(S.scenes[+b.dataset.k]); };
$('farmSelect').onchange = e => selectFarm(e.target.value);

const openFarmModal = () => { $('farmForm').reset(); $('fmErr').textContent = ''; $('farmModal').hidden = false; $('fmName').focus(); };
$('btnAddFarm').onclick = openFarmModal; $('btnAddFarm2').onclick = openFarmModal;
$('fmCancel').onclick = () => $('farmModal').hidden = true;
$('farmForm').onsubmit = async e => {
  e.preventDefault(); $('fmErr').textContent = '';
  try {
    const file = $('fmFile').files[0]; if (!file) throw new Error('Escolha o arquivo do perímetro.');
    const polys = await readPerimeter(file);
    const f = { id: 'f' + Date.now().toString(36), name: $('fmName').value.trim(), owner: $('fmOwner').value.trim(), polys, area: areaHa(polys), created: new Date().toISOString() };
    S.farms.push(f); $('farmModal').hidden = true; selectFarm(f.id);
    toast(`${f.name} cadastrada: ${fmt(f.area, 1)} ha.`);
  } catch (err) { console.error(err); $('fmErr').textContent = err.message || 'Arquivo inválido.'; }
};
$('btnDelFarm').onclick = () => {
  const f = farm(); if (!f) return;
  $('cfText').textContent = `Excluir a fazenda "${f.name}" deste aparelho?`; $('confirmModal').hidden = false;
};
$('cfNo').onclick = () => $('confirmModal').hidden = true;
$('cfYes').onclick = () => {
  $('confirmModal').hidden = true;
  S.farms = S.farms.filter(f => f.id !== S.farmId);
  if (S.outline) { S.outline.remove(); S.outline = null; }
  selectFarm(S.farms[0] ? S.farms[0].id : null);
};

// datas padrão: últimos 60 dias
(() => { const t = new Date(), f = new Date(); f.setDate(f.getDate() - 60); $('dFrom').value = isoDay(f); $('dTo').value = isoDay(t); })();
if (!farm() && S.farms.length) S.farmId = S.farms[0].id;
selectFarm(S.farmId);
