/* AgroSat — Entorno, água e infraestrutura:
   • Energia (ANEEL/SIGEL): usinas solares, hidrelétricas, termelétricas, linhas de transmissão e subestações
   • Mineração (ANM/SIGMINE), água (ANA: outorgas, pivôs, barragens), florestas públicas (SFB via IBAMA), sítios arqueológicos (IPHAN)
   • OpenStreetMap: rios, nascentes, linhas de energia, pistas de pouso — com estimativa de APP de curso d'água
   • Faixa de fronteira (Lei 6.634/1979) e rebanho bovino do município (IBGE/PPM)
   As camadas dos catálogos ArcGIS são descobertas pelo nome na primeira consulta e guardadas por 30 dias. */
'use strict';

const RAIZ = {
  aneel: 'https://sigel.aneel.gov.br/arcgis/rest/services',
  anm: 'https://geo.anm.gov.br/arcgis/rest/services',
  ana: 'https://portal1.snirh.gov.br/server/rest/services',
  ibama: 'https://pamgia.ibama.gov.br/server/rest/services',
  infrasa: 'https://geo.infrasa.gov.br/server/rest/services',   // Infra S.A.: bases de logística e energia da EPE
  ana2: 'https://www.snirh.gov.br/arcgis/rest/services',
};
const TEMAS_ENTORNO = [
  { k: 'solar', nome: 'Usinas solares (UFV)', raiz: ['aneel', 'infrasa'], re: /fotovolt|\bUFV\b|solar/i, raio: 50 },
  { k: 'hidro', nome: 'Hidrelétricas (UHE, PCH, CGH)', raiz: ['aneel', 'infrasa'], re: /\bUHE\b|\bPCH\b|\bCGH\b|hidrel/i, raio: 50 },
  { k: 'termo', nome: 'Termelétricas (UTE)', raiz: ['aneel', 'infrasa'], re: /\bUTE\b|termel/i, raio: 50 },
  { k: 'lt', nome: 'Linhas de transmissão', raiz: ['aneel', 'infrasa'], re: /linhas? de transmiss|\bLT\b/i, raio: 20 },
  { k: 'se', nome: 'Subestações', raiz: ['aneel', 'infrasa'], re: /subesta/i, raio: 30 },
  { k: 'min', nome: 'Processos minerários (ANM)', raiz: 'anm', re: /processo|sigmine|brasil/i, raio: 10, dentro: 'alerta' },
  { k: 'outorga', nome: 'Outorgas de água (ANA)', raiz: ['ana', 'ana2'], re: /outorg/i, raio: 10 },
  { k: 'pivo', nome: 'Pivôs centrais', raiz: ['ana', 'ana2'], re: /piv[oô]/i, raio: 20 },
  { k: 'barragem', nome: 'Barragens (SNISB)', raiz: ['ana', 'ana2', 'infrasa'], re: /barrag|snisb/i, raio: 50 },
  { k: 'flopub', nome: 'Florestas públicas (SFB)', raiz: 'ibama', re: /floresta.{0,4}p[uú]blica|cnfp/i, raio: 5, dentro: 'alerta' },
  { k: 'armazem', nome: 'Armazéns e silos', raiz: ['infrasa'], re: /armaz|silo|conab/i, raio: 50 },
  { k: 'porto', nome: 'Portos e terminais', raiz: ['infrasa'], re: /porto|terminal/i, raio: 50 },
  { k: 'ferrovia', nome: 'Ferrovias', raiz: ['infrasa'], re: /ferrovi/i, raio: 30 },
];

// limite de tempo: uma base lenta não pode segurar o relatório
const comLimite = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg || `não respondeu em ${Math.round(ms / 1000)} s`)), ms))]);

// ---------- descoberta de camadas nos catálogos ArcGIS ----------
const CHAVE_IDX = 'agrosat.catalogos';
const catalogoEmLeitura = {};
function indiceCatalogo(nomeRaiz) {
  // vários temas usam o mesmo órgão: lê o catálogo uma vez só
  if (!catalogoEmLeitura[nomeRaiz]) { catalogoEmLeitura[nomeRaiz] = lerCatalogo(nomeRaiz); catalogoEmLeitura[nomeRaiz].catch(() => delete catalogoEmLeitura[nomeRaiz]); }
  return catalogoEmLeitura[nomeRaiz];
}
async function lerCatalogo(nomeRaiz) {
  const cache = store(CHAVE_IDX) || {}, c = cache[nomeRaiz];
  if (c && Date.now() - c.t < 30 * 864e5 && c.camadas.length) return c.camadas;
  const raiz = RAIZ[nomeRaiz], camadas = [];
  const ler = u => comLimite(buscarTexto(u), 12000);
  const j = JSON.parse(await ler(`${raiz}?f=json`));
  let servicos = (j.services || []).slice();
  await pool((j.folders || []).slice(0, 25), 6, async fo => { try { const jf = JSON.parse(await ler(`${raiz}/${fo}?f=json`)); servicos.push(...(jf.services || [])); } catch (e) { } });
  servicos = servicos.filter(s => /MapServer|FeatureServer/.test(s.type));
  // FeatureServer e MapServer do mesmo serviço repetem as camadas: fica com um só
  const vistos = new Set();
  servicos = servicos.filter(s => { if (vistos.has(s.name)) return false; vistos.add(s.name); return true; }).slice(0, 80);
  await pool(servicos, 6, async s => {
    try {
      const js = JSON.parse(await ler(`${raiz}/${s.name}/${s.type}?f=json`));
      (js.layers || []).forEach(L => { if (!L.subLayerIds || !L.subLayerIds.length) camadas.push({ url: `${raiz}/${s.name}/${s.type}/${L.id}`, nome: `${s.name} › ${L.name}` }); });
    } catch (e) { }
  });
  if (camadas.length) { cache[nomeRaiz] = { t: Date.now(), camadas }; store(CHAVE_IDX, cache); }
  return camadas;
}
const nomeDe = p => {
  for (const [k, v] of Object.entries(p)) if (/^(nome|nom_|nm_|name|noUsina|empreend|titular|usina|denomina)/i.test(k) && typeof v === 'string' && v.trim()) return v.trim();
  for (const v of Object.values(p)) if (typeof v === 'string' && v.trim().length > 2 && !/^\d+$/.test(v)) return v.trim();
  return '—';
};
const detalheDe = p => {
  const out = [];
  for (const [k, v] of Object.entries(p)) {
    if (v == null || v === '') continue;
    if (/potenc|pot_|mw|kw/i.test(k) && !/data/i.test(k)) out.push(`${fmt(+v, +v < 10 ? 2 : 0)} ${/kw/i.test(k) ? 'kW' : /mw/i.test(k) ? 'MW' : ''}`.trim());
    else if (/subst|fase|tensao|tens[aã]o|finalid|uso|situa|tipo/i.test(k) && typeof v === 'string') out.push(v);
    if (out.length >= 2) break;
  }
  return out.join(' · ');
};

// distância (km) entre o imóvel e uma feição; 0 se encostam
function distKmFeicao(F, ft) {
  try { if (turf.booleanIntersects(F, ft)) return 0; } catch (e) { }
  const borda = turf.polygonToLine(F), linhas = (borda.type === 'FeatureCollection' ? borda.features : [borda]).flatMap(x => x.geometry.type === 'MultiLineString' ? x.geometry.coordinates.map(c => turf.lineString(c)) : [x]);
  const pts = turf.coordAll(ft); const passo = Math.max(1, Math.floor(pts.length / 400));
  let d = Infinity;
  for (let i = 0; i < pts.length; i += passo) for (const L of linhas) d = Math.min(d, turf.pointToLineDistance(turf.point(pts[i]), L, { units: 'kilometers' }));
  // linhas e polígonos: também dos vértices do imóvel até a feição (o trecho mais perto pode não ter vértice)
  const g = ft.geometry; let lf = null;
  if (/LineString/.test(g.type)) lf = ft; else if (/Polygon/.test(g.type)) { try { lf = turf.polygonToLine(ft); } catch (e) { } }
  if (lf) {
    const ls = lf.type === 'FeatureCollection' ? lf.features : [lf], vs = turf.coordAll(F), p2 = Math.max(1, Math.floor(vs.length / 200));
    const segs = ls.flatMap(x => x.geometry.type === 'MultiLineString' ? x.geometry.coordinates.map(c => turf.lineString(c)) : [x]);
    for (let i = 0; i < vs.length; i += p2) for (const L of segs) d = Math.min(d, turf.pointToLineDistance(turf.point(vs[i]), L, { units: 'kilometers' }));
  }
  return d;
}

async function consultarTema(T, F) {
  // tenta cada órgão da lista até achar a camada (ex.: ANEEL; se recusar, Infra S.A./EPE)
  const raizes = Array.isArray(T.raiz) ? T.raiz : [T.raiz];
  let alvo = [], erro = null;
  for (const rz of raizes) {
    try { alvo = (await indiceCatalogo(rz)).filter(c => T.re.test(c.nome)).slice(0, 4); if (alvo.length) break; }
    catch (e) { erro = e; }
  }
  if (!alvo.length) throw erro || new Error('camada não encontrada no catálogo do órgão');
  const b = turf.bbox(turf.buffer(F, T.raio, { units: 'kilometers' }));
  const feats = [];
  for (const c of alvo) { try { feats.push(...(await arcgisNaArea(c.url, b)).map(f => (f.properties._camada = c.nome, f))); } catch (e) { console.warn(T.k, c.url, e.message); } }
  const itens = feats.map(ft => ({ ft, nome: nomeDe(ft.properties), det: detalheDe(ft.properties), km: distKmFeicao(F, ft) }))
    .filter(x => x.km <= T.raio).sort((a, b) => a.km - b.km);
  return { itens, camadas: alvo.map(c => c.nome) };
}

// ---------- IPHAN: sítios arqueológicos (GeoServer) ----------
async function sitiosArqueologicos(F) {
  const b = turf.bbox(turf.buffer(F, 5, { units: 'kilometers' })), out = [];
  for (const tn of ['SICG:sitios', 'SICG:sitios_pol']) {
    try {
      const fc = await getGeo(`https://portal.iphan.gov.br/geoserver/SICG/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=${tn}&outputFormat=application/json&srsName=EPSG:4326&maxFeatures=300&bbox=${bboxStr(b)}`);
      out.push(...fc.features);
    } catch (e) { console.warn('IPHAN', tn, e.message); }
  }
  return out.map(ft => ({ ft, nome: nomeDe(ft.properties), det: '', km: distKmFeicao(F, ft) })).filter(x => x.km <= 5).sort((a, b) => a.km - b.km);
}

// ---------- OpenStreetMap: rios, nascentes, energia, pistas ----------
async function overpass(q) {
  // sorteia a ordem entre os espelhos para dividir a carga; tenta no máximo dois
  const urls = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'].sort(() => Math.random() - 0.5).slice(0, 2);
  let erro;
  for (const u of urls) {
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(u, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal }); clearTimeout(t);
      if (r.ok) return await r.json(); erro = new Error('OpenStreetMap respondeu ' + r.status + ' (servidor ocupado)');
    } catch (e) { erro = erro || e; }
  }
  throw erro;
}
const bb = b => `${b[1]},${b[0]},${b[3]},${b[2]}`;
async function osmEntorno(F) {
  const b1 = turf.bbox(turf.buffer(F, 1, { units: 'kilometers' })), b5 = turf.bbox(turf.buffer(F, 5, { units: 'kilometers' })), b20 = turf.bbox(turf.buffer(F, 20, { units: 'kilometers' }));
  // três consultas pequenas (uma grande costuma estourar o tempo do servidor); a de água é a essencial
  const j = { elements: [] }, falhas = [];
  const qs = [
    `[out:json][timeout:25];(way["waterway"~"^(river|stream|canal|ditch|drain)$"](${bb(b1)});node["natural"="spring"](${bb(b1)});way["natural"="water"](${bb(b1)}););out geom;`,
    `[out:json][timeout:25];way["power"~"^(line|minor_line)$"](${bb(b5)});out geom;`,
    `[out:json][timeout:25];(node["aeroway"="aerodrome"](${bb(b20)});way["aeroway"="aerodrome"](${bb(b20)}););out center;`,
  ];
  await Promise.all(qs.map(async q => { try { j.elements.push(...((await overpass(q)).elements || [])); } catch (e) { falhas.push(e); } }));
  if (falhas.length === 3) throw falhas[0];
  const agua = [], nasc = [], lagos = [], energia = [], pistas = [];
  for (const el of j.elements || []) {
    const t = el.tags || {};
    let g = null;
    if (el.type === 'node') g = { type: 'Point', coordinates: [el.lon, el.lat] };
    else if (el.center) g = { type: 'Point', coordinates: [el.center.lon, el.center.lat] };
    else if (el.geometry) { const c = el.geometry.map(p => [p.lon, p.lat]); const fechado = c.length > 3 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1]; g = fechado && (t.natural === 'water' || t.aeroway === 'aerodrome') ? { type: 'Polygon', coordinates: [c] } : { type: 'LineString', coordinates: c }; }
    if (!g) continue;
    const ft = { type: 'Feature', properties: t, geometry: g };
    if (t.waterway) agua.push(ft); else if (t.natural === 'spring') nasc.push(ft); else if (t.natural === 'water') lagos.push(ft);
    else if (t.power) energia.push(ft); else if (t.aeroway) pistas.push(ft);
  }
  // APP de curso d'água: 30 m de cada lado (rios até 10 m de largura); nascente: raio de 50 m (Lei 12.651/2012, art. 4º)
  let app = null;
  try {
    const partes = [];
    agua.slice(0, 80).forEach(ft => { if (ft.geometry.type === 'LineString') partes.push(turf.buffer(ft, 0.03, { units: 'kilometers', steps: 4 })); });
    nasc.slice(0, 40).forEach(ft => partes.push(turf.circle(ft.geometry.coordinates, 0.05, { units: 'kilometers', steps: 16 })));
    let u = null; for (const p of partes) { try { u = u ? turf.union(u, p) : p; } catch (e) { } }
    const dentro = u ? turf.intersect(F, u) : null;
    app = { ha: dentro ? turf.area(dentro) / 1e4 : 0, geom: dentro };
  } catch (e) { console.warn('APP', e.message); }
  const lista = (fs, raio) => fs.map(ft => ({ ft, nome: ft.properties.name || ft.properties.ref || '(sem nome)', det: [ft.properties.waterway || ft.properties.power || ft.properties.aeroway || '', ft.properties.voltage ? `${Math.round(+String(ft.properties.voltage).split(';')[0] / 1000)} kV` : '', ft.properties.surface || ''].filter(Boolean).join(' · '), km: distKmFeicao(F, ft) })).filter(x => x.km <= raio).sort((a, b) => a.km - b.km);
  return { agua: lista(agua, 1), nasc: lista(nasc, 1), lagos: lista(lagos, 1), energia: lista(energia, 5), pistas: lista(pistas.filter(p => p.properties.aeroway === 'aerodrome' || !pistas.some(q => q.properties.aeroway === 'aerodrome')), 20), app };
}

// ---------- Faixa de fronteira ----------
async function faixaFronteira(F) {
  const r = await fetch('lib/fronteira_br.json'); const linhas = await r.json();
  const c = turf.centroid(F); let d = Infinity;
  linhas.forEach(l => { d = Math.min(d, turf.pointToLineDistance(c, turf.lineString(l), { units: 'kilometers' })); });
  return { km: d, dentro: d <= 150 };
}

// ---------- Município (IBGE): código e rebanho bovino (PPM) ----------
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
async function municipioIBGE(lon, lat, nomeCAR, ufCAR) {
  let nome = nomeCAR, uf = ufCAR;
  if (!nome) {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&accept-language=pt-BR&lat=${lat}&lon=${lon}`);
    const j = await r.json(); const a = j.address || {};
    nome = a.city || a.town || a.municipality || a.village || a.county;
    uf = uf || (a['ISO3166-2-lvl4'] || '').split('-')[1];
  }
  if (!nome || !uf) throw new Error('município não identificado');
  const ms = await (await fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios`)).json();
  const m = ms.find(x => semAcento(x.nome) === semAcento(nome)) || ms.find(x => semAcento(nome).includes(semAcento(x.nome)));
  if (!m) throw new Error(`município "${nome}" não encontrado no IBGE`);
  const out = { id: m.id, nome: m.nome, uf };
  try {
    const s = await (await fetch(`https://apisidra.ibge.gov.br/values/t/3939/n6/${m.id}/v/105/p/last%205/c79/2670`)).json();
    out.bovinos = s.slice(1).map(x => ({ ano: x.D3N || x['D3N'] || x.D2N, cab: +x.V })).filter(x => Number.isFinite(x.cab));
  } catch (e) { out.bovinos = null; }
  return out;
}

// ---------- Certidões e documentos (links oficiais) ----------
const CERTIDOES = [
  ['CCIR (INCRA/SNCR)', 'https://sncr.serpro.gov.br/ccir/emissao', 'Certificado de Cadastro de Imóvel Rural; precisa do código do imóvel no INCRA.'],
  ['Consulta pública do SIGEF', 'https://sigef.incra.gov.br/consultar/parcelas/', 'Parcelas certificadas, com memorial e situação.'],
  ['Consulta pública do CAR', 'https://consultapublica.car.gov.br/publico/imoveis/index', 'Demonstrativo do imóvel no SICAR (com o número do CAR).'],
  ['Certidão negativa do ITR (Receita Federal)', 'https://solucoes.receita.fazenda.gov.br/Servicos/certidaointernet/ITR/Emitir', 'Débitos do Imposto Territorial Rural pelo NIRF.'],
  ['Matrícula do imóvel (ONR)', 'https://registradores.onr.org.br/', 'Pedido de certidão de matrícula no cartório de registro de imóveis (pago).'],
  ['Registrato (Banco Central)', 'https://www.bcb.gov.br/cidadaniafinanceira/registrato', 'Dívidas em aberto do produtor, inclusive crédito rural (com gov.br do titular).'],
];

// ---------- execução completa ----------
async function consultarEntorno(f, F, opcoes = {}) {
  const centro = turf.centroid(F).geometry.coordinates;
  const R = {}, E = {};
  const rodar = async (k, fn) => { try { R[k] = await comLimite(fn(), opcoes.limite || 60000, 'demorou demais (base lenta ou fora do ar); tente de novo mais tarde'); } catch (e) { E[k] = e.message || String(e); console.warn('entorno', k, e); } opcoes.aviso && opcoes.aviso(k); };
  await Promise.all([
    ...TEMAS_ENTORNO.map(T => rodar(T.k, () => consultarTema(T, F))),
    rodar('iphan', () => sitiosArqueologicos(F)),
    rodar('osm', () => osmEntorno(F)),
    rodar('fronteira', () => faixaFronteira(F)),
    rodar('mun', () => municipioIBGE(centro[0], centro[1], opcoes.mun, opcoes.uf || f.uf)),
  ]);
  return { R, E, data: new Date().toISOString() };
}

// linhas-resumo (usadas na aba Situação e no relatório)
function linhasEntorno(EN) {
  const { R, E } = EN, L = [];
  const lin = (nome, x, raio, dentroNivel) => {
    if (!x) return L.push({ nome, nivel: 'erro', texto: 'Não consultado agora', itens: [] });
    const dentro = x.filter(i => i.km === 0), perto = x[0];
    const nivel = dentro.length && dentroNivel ? dentroNivel : 'info';
    L.push({ nome, nivel, texto: dentro.length ? `<b>${dentro.length} dentro do imóvel</b>${x.length > dentro.length ? ` · ${x.length - dentro.length} até ${raio} km` : ''}` : perto ? `Mais próximo a ${fmt(perto.km, perto.km < 10 ? 1 : 0)} km${x.length > 1 ? ` · ${x.length} até ${raio} km` : ''}` : `Nenhum até ${raio} km`, itens: x });
  };
  TEMAS_ENTORNO.forEach(T => { const r = R[T.k]; if (r) lin(T.nome, r.itens, T.raio, T.dentro); else L.push({ nome: T.nome, nivel: 'erro', texto: 'Não consultado: ' + esc(E[T.k] || ''), itens: [] }); });
  if (R.iphan) lin('Sítios arqueológicos (IPHAN)', R.iphan, 5, 'alerta'); else L.push({ nome: 'Sítios arqueológicos (IPHAN)', nivel: 'erro', texto: 'Não consultado: ' + esc(E.iphan || ''), itens: [] });
  if (R.osm) {
    const o = R.osm;
    L.push({ nome: 'Rios e córregos (OpenStreetMap)', nivel: 'info', texto: o.agua.filter(i => i.km === 0).length ? `${o.agua.filter(i => i.km === 0).length} curso(s) d'água cruzam o imóvel${o.nasc.filter(i => i.km === 0).length ? ` · ${o.nasc.filter(i => i.km === 0).length} nascente(s)` : ''}${o.app ? ` · APP estimada de ${fmt(o.app.ha, 1)} ha` : ''}` : o.agua.length ? `Curso d'água a ${fmt(o.agua[0].km * 1000, 0)} m do limite` : 'Nenhum curso d\'água mapeado até 1 km', itens: [...o.agua, ...o.nasc] });
    lin('Linhas de energia (OpenStreetMap)', o.energia, 5, null);
    lin('Aeródromos e pistas (OpenStreetMap)', o.pistas, 20, null);
  } else L.push({ nome: 'Rios, energia e pistas (OpenStreetMap)', nivel: 'erro', texto: 'Não consultado: ' + esc(E.osm || ''), itens: [] });
  if (R.fronteira) L.push({ nome: 'Faixa de fronteira', nivel: R.fronteira.dentro ? 'alerta' : 'ok', texto: R.fronteira.dentro ? `<b>Dentro da faixa de fronteira</b> (${fmt(R.fronteira.km, 0)} km da divisa): compra por estrangeiro e alguns atos dependem de assentimento prévio` : `Fora da faixa de 150 km (${fmt(R.fronteira.km, 0)} km da fronteira terrestre)`, itens: [] });
  return L;
}

(function () {
  const btn = $('btnEntorno'); if (!btn) return;
  const COR = { ok: '#1a9850', alerta: '#e0a800', grave: '#d73027', erro: '#8a8f8c', info: '#2f6fb3' };
  btn.onclick = async () => {
    const f = farm(); if (!f) return;
    btn.disabled = true; let n = 0; const tot = TEMAS_ENTORNO.length + 4;
    try {
      const F = farmFeature(f);
      const EN = await consultarEntorno(f, F, { aviso: () => busy(true, `Entorno: ${++n} de ${tot} bases`) });
      S.entorno = { id: f.id, EN }; busy(false);
      const L = linhasEntorno(EN), M = EN.R.mun;
      const camada = L.flatMap(l => l.itens.filter(i => i.km <= 5).map(i => i.ft));
      if (DL.group) DL.group.clearLayers(); else DL.group = L_layerGroupSafe();
      try { L_geo(camada); } catch (e) { }
      $('entRes').hidden = false;
      const MIN = EN.R.min ? mineracaoNoImovel(EN.R.min.itens, F) : null;
      $('entRes').innerHTML = L.map(l => `<div class="dcard" style="border-left:4px solid ${COR[l.nivel]}"><b>${l.nome}</b><div>${l.texto}</div>${l.itens.length ? `<details><summary>${l.itens.length > 1 ? `ver os ${Math.min(8, l.itens.length)} mais próximos` : "ver detalhe"}</summary>${tabelaHTML(['Nome', 'Detalhe', 'Distância'], l.itens.slice(0, 8).map(i => [esc(i.nome), esc(i.det || ''), i.km === 0 ? 'dentro' : fmt(i.km, i.km < 10 ? 1 : 0) + ' km']))}</details>` : ''}</div>`).join('')
        + (M ? `<div class="dcard" style="border-left:4px solid ${COR.info}"><b>Município: ${esc(M.nome)} - ${M.uf}</b>${M.bovinos && M.bovinos.length ? `<div>Rebanho bovino (IBGE/PPM): ${M.bovinos.map(x => `${x.ano}: ${fmt(x.cab, 0)}`).join(' · ')} cabeças</div>` : ''}</div>` : '')
        + `<h4>Certidões e documentos</h4>${CERTIDOES.map(([n, u, d]) => `<p><a href="${u}" target="_blank" rel="noopener">${n}</a><br><span class="hint">${d}</span></p>`).join('')}` ;
      if (MIN) $('entRes').insertAdjacentHTML('afterbegin', `<div class="dcard" style="border-left:4px solid ${MIN.sobre.length ? COR.alerta : COR.ok}"><b>⛏️ Mineração (ANM)</b>${mineracaoHTML(MIN, true)}</div>`);
    } catch (e) { busy(false); toast('Não consegui consultar o entorno: ' + e.message, 6000); }
    finally { btn.disabled = false; }
  };
  function L_layerGroupSafe() { return L.layerGroup().addTo(map); }
  function L_geo(fs) { if (!fs.length) return; DL.group.addLayer(L.geoJSON({ type: 'FeatureCollection', features: fs }, { style: { color: '#ffb000', weight: 2, fillOpacity: .15 }, pointToLayer: (ft, ll) => L.circleMarker(ll, { radius: 6, color: '#fff', weight: 2, fillColor: '#ffb000', fillOpacity: 1 }) })); }
})();

// ---------- Mineração (ANM/SIGMINE): processos sobre o imóvel, com área sobreposta ----------
const FASES_MIN = [
  [/concess[aã]o de lavra|lavra garimpeira|licenciamento|registro de extra/i, 'grave', 'direito de lavrar (extração autorizada)'],
  [/requerimento de lavra|requerimento de licenciamento|requerimento de lavra garimpeira|requerimento de registro/i, 'alerta', 'pedido de extração em análise'],
  [/autoriza[cç][aã]o de pesquisa/i, 'alerta', 'pesquisa mineral autorizada (pode haver sondagem na área)'],
  [/requerimento de pesquisa/i, 'alerta', 'pedido de pesquisa em análise'],
  [/disponibilidade/i, 'info', 'área devolvida, disponível para novo interessado'],
];
const ehEmpresa = n => /\b(ltda|s\.?\/?a\.?|eireli|\bme\b|\bepp\b|minera|minera[cç][aã]o|empresa|companhia|cia\b|cooperativa|ind[uú]stria|com[eé]rcio|holding|associa|mining|resources|recursos|brasil)\b/i.test(n || '');
function mineracaoNoImovel(itens, F) {
  const P = (p, re) => { for (const [k, v] of Object.entries(p)) if (re.test(k) && v != null && v !== '') return String(v).trim(); return ''; };
  const areaTot = turf.area(F) / 1e4, inters = [];
  const proc = (itens || []).map(x => {
    const p = x.ft.properties || {};
    const fase = P(p, /^fase$/i), subs = P(p, /^subs/i), tit = P(p, /^nome$|titular|requerente/i);
    let inter = null, haSob = 0;
    if (x.km === 0) { try { inter = turf.intersect(F, x.ft); if (inter) { haSob = turf.area(inter) / 1e4; inters.push(inter); } } catch (e) { } }
    const f = FASES_MIN.find(([re]) => re.test(fase)) || [null, 'info', ''];
    return {
      processo: P(p, /^processo$|^dsprocesso$/i) || [P(p, /^numero$/i), P(p, /^ano$/i)].filter(Boolean).join('/'),
      subs: subs ? subs.charAt(0) + subs.slice(1).toLowerCase() : '—', fase: fase || '—', nivel: f[1], leitura: f[2],
      ultimo: P(p, /ult_?evento|ultimo/i), uso: P(p, /^uso$/i), titular: tit ? (ehEmpresa(tit) ? tit : 'Pessoa física') : '—',
      haProc: +P(p, /^area_?ha$|^area$/i) || 0, haSob, km: x.km, ft: x.ft, inter,
    };
  });
  const sobre = proc.filter(x => x.km === 0 && x.haSob >= 0.01).sort((a, b) => b.haSob - a.haSob);
  let haUniao = 0;
  try { if (inters.length) { let u = inters[0]; for (const g of inters.slice(1)) u = turf.union(u, g) || u; haUniao = turf.area(u) / 1e4; } } catch (e) { haUniao = Math.min(areaTot, sobre.reduce((s, x) => s + x.haSob, 0)); }
  return { sobre, perto: proc.filter(x => x.km > 0).sort((a, b) => a.km - b.km), haSoma: sobre.reduce((s, x) => s + x.haSob, 0), haUniao, pct: haUniao / areaTot * 100 };
}
function mineracaoHTML(MI, compacto) {
  const COR = { grave: '#d73027', alerta: '#e0a800', info: '#2f6fb3' };
  if (!MI.sobre.length) return `<p><b>Nenhum processo minerário sobre o imóvel.</b>${MI.perto.length ? ` ${MI.perto.length} processo(s) até 10 km; o mais próximo a ${fmt(MI.perto[0].km, 1)} km (${esc(MI.perto[0].subs)}, ${esc(MI.perto[0].fase.toLowerCase())}).` : ' Nenhum até 10 km.'}</p>`;
  const card = x => `<div style="border:1px solid #ddd;border-left:5px solid ${COR[x.nivel]};border-radius:8px;padding:8px 10px;margin:6px 0">
    <b style="font-size:1.05em">${esc(x.subs)}</b> · <b>${fmt(x.haSob, x.haSob < 10 ? 1 : 0)} ha sobrepostos</b>${x.haProc ? ` <span style="color:#666">(processo de ${fmt(x.haProc, 0)} ha)</span>` : ''}
    <div><b>${esc(x.fase.toUpperCase())}</b>${x.leitura ? ` — ${x.leitura}` : ''}</div>
    <div style="color:#555;font-size:.92em">Processo ANM ${esc(x.processo || '—')} · Titular: ${esc(x.titular)}${x.uso ? ` · Uso: ${esc(x.uso)}` : ''}${x.ultimo ? `<br>Último evento: ${esc(x.ultimo)}` : ''}</div></div>`;
  return `<p><b>${MI.sobre.length} processo(s) minerário(s) sobre o imóvel</b>, cobrindo <b>${fmt(MI.haUniao, MI.haUniao < 10 ? 1 : 0)} ha (${fmt(MI.pct, 0)}% da área)</b>${Math.abs(MI.haSoma - MI.haUniao) > 0.5 ? ` — a soma por processo dá ${fmt(MI.haSoma, 1)} ha porque alguns se sobrepõem entre si` : ''}.</p>
    ${MI.sobre.slice(0, compacto ? 6 : 20).map(card).join('')}
    ${MI.perto.length ? `<p style="color:#555">Mais ${MI.perto.length} processo(s) até 10 km do limite.</p>` : ''}
    <p class="${compacto ? 'hint' : 'nota'}">Fonte: ANM/SIGMINE. O subsolo é da União: o processo dá ao titular o direito de pesquisar ou lavrar o minério, não a posse da terra. Para pesquisar ele precisa de acordo com o proprietário ou de autorização judicial, e o dono do solo tem direito a renda pela ocupação, indenização por danos e participação no resultado da lavra (Código de Mineração, arts. 11 e 27). Nome de pessoa física não é exibido. Confira o andamento no SEI/Cadastro Mineiro da ANM pelo número do processo.</p>`;
}
