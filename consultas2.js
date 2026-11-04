/* AgroSat — consultas do relatório completo: bioma e Amazônia Legal, Reserva Legal, DETER,
   áreas queimadas (MapBiomas Fogo), idade e vigor da pastagem, solo (SoilGrids) e climatologia. */
'use strict';

const TB = 'https://terrabrasilis.dpi.inpe.br/geoserver';
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

// ---------- Bioma e Amazônia Legal ----------
// Amazônia Legal (LC 124/2007): AC, AM, AP, PA, RO, RR, MT, TO inteiros e o Maranhão a oeste do meridiano de 44° W.
function naAmazoniaLegal(lon, lat, uf) {
  uf = (uf || '').toUpperCase();
  if (['AC', 'AM', 'AP', 'PA', 'RO', 'RR', 'MT', 'TO'].includes(uf)) return true;
  if (uf === 'MA') return lon <= -44;
  return false;
}
async function wfsAtributosNoPonto(ws, camada, lon, lat) {
  const tn = `${ws}:${camada}`;
  const xml = await buscarTexto(`${TB}/${ws}/ows?service=WFS&version=1.0.0&request=DescribeFeatureType&typeName=${tn}`);
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const els = [...doc.getElementsByTagNameNS('*', 'element')].filter(e => e.getAttribute('name') && e.getAttribute('type'));
  const props = els.filter(e => !/^gml:/i.test(e.getAttribute('type')) && e.getAttribute('name') !== camada).map(e => e.getAttribute('name'));
  if (!props.length) throw new Error('camada sem atributos');
  const e = 0.0003;
  const txt = await buscarTexto(`${TB}/${ws}/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=${tn}&outputFormat=application/json&maxFeatures=3&propertyName=${props.join(',')}&bbox=${bboxStr([lon - e, lat - e, lon + e, lat + e])}`);
  return (JSON.parse(txt).features || []).map(f => f.properties || {});
}
const BIOMAS = [['Amazônia', /amaz/i], ['Cerrado', /cerrad/i], ['Caatinga', /caating/i], ['Mata Atlântica', /mata|atl[aâ]nt/i], ['Pantanal', /pantan/i], ['Pampa', /pampa/i]];
async function biomaNoPonto(lon, lat) {
  const ps = await wfsAtributosNoPonto('prodes-brasil-nb', 'biomas_brasil', lon, lat);
  for (const p of ps) for (const v of Object.values(p)) for (const [nome, re] of BIOMAS) if (re.test(String(v))) return nome;
  return null;
}
// Reserva Legal mínima (Lei 12.651/2012, art. 12)
function percentualRL(legal, bioma, nativaDom) {
  if (!legal) return { pct: 20, regra: 'demais regiões do país' };
  const tipo = bioma === 'Amazônia' ? 'floresta' : bioma === 'Cerrado' ? 'cerrado' : bioma ? 'campos' :
    nativaDom === 'floresta' ? 'floresta' : nativaDom === 'savana' ? 'cerrado' : 'campos';
  if (tipo === 'floresta') return { pct: 80, regra: 'Amazônia Legal, área de floresta' };
  if (tipo === 'cerrado') return { pct: 35, regra: 'Amazônia Legal, área de cerrado' };
  return { pct: 20, regra: 'Amazônia Legal, campos gerais' };
}

// ---------- DETER (alertas do INPE, Amazônia e Cerrado) ----------
async function deterNaArea(b) {
  const out = []; let erro = null, ok = 0;
  for (const [ws, camada, nome] of [['deter-amz', 'deter_amz', 'Amazônia'], ['deter-cerrado-nb', 'deter_cerrado', 'Cerrado']]) {
    try {
      const fc = await getGeo(`${TB}/${ws}/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=${ws}:${camada}&outputFormat=application/json&srsName=EPSG:4326&maxFeatures=1000&bbox=${bboxStr(b)}`);
      fc.features.forEach(f => f.properties._fonte = nome); out.push(...fc.features); ok++;
    } catch (e) { erro = e; }
  }
  if (!ok) throw erro || new Error('DETER não respondeu');
  const vistos = new Set();   // o mesmo alerta pode vir nas duas camadas
  return out.filter(f => { const k = JSON.stringify(f.geometry.coordinates).slice(0, 200) + (f.properties.view_date || ''); if (vistos.has(k)) return false; vistos.add(k); return true; });
}
const DETER_CLASSE = {
  DESMATAMENTO_CR: 'Desmatamento (corte raso)', DESMATAMENTO_VEG: 'Desmatamento com vegetação', MINERACAO: 'Mineração',
  DEGRADACAO: 'Degradação', CICATRIZ_DE_QUEIMADA: 'Cicatriz de queimada', CS_DESORDENADO: 'Corte seletivo desordenado', CS_GEOMETRICO: 'Corte seletivo geométrico',
  desmatamento: 'Desmatamento',
};
const deterNome = c => DETER_CLASSE[c] || DETER_CLASSE[String(c).toUpperCase()] || String(c || '—').replace(/_/g, ' ').toLowerCase();
const deterGrave = c => /DESMAT|MINERA/i.test(String(c));

// ---------- Áreas queimadas (MapBiomas Fogo, Coleção 5, mensal, 30 m) ----------
const FOGO_URL = a => `https://storage.googleapis.com/mapbiomas-public/initiatives/brasil/collection_10/fire-col5/mapbiomas_fire_collection5_monthly_burned_v1/burned_monthly_${a}.tif`;
const FOGO_ANOS = [2021, 2022, 2023, 2024, 2025];
async function queimadasNaFazenda(f) {
  const g = grid(f.polys, 4326, 30 / 111320);
  const lat = (g.bbox[1] + g.bbox[3]) / 2, pxHa = Math.pow(g.res * 111320, 2) * Math.cos(lat * Math.PI / 180) / 1e4;
  const anos = [], falhas = [];
  const queimado = new Uint16Array(g.W * g.H);   // último ano queimado em cada pixel
  await Promise.all(FOGO_ANOS.map(async a => {
    try {
      const r = await lerRasters(FOGO_URL(a), { bbox: g.bbox, width: g.W, height: g.H, resampleMethod: 'nearest', fillValue: 0, samples: [0] });
      const v = r[0], porMes = {}; let n = 0;
      for (let i = 0; i < v.length; i++) {
        if (!g.mask[i] || !v[i] || v[i] > 12) continue;
        n++; porMes[v[i]] = (porMes[v[i]] || 0) + 1;
        if (a > queimado[i]) queimado[i] = a;
      }
      anos.push({ ano: a, ha: n * pxHa, meses: Object.entries(porMes).map(([m, c]) => ({ mes: +m, ha: c * pxHa })).sort((x, y) => x.mes - y.mes) });
    } catch (e) { falhas.push(a); }
  }));
  if (!anos.length) {
    if (window.QUEIMADAS_ALT) return window.QUEIMADAS_ALT(f);   // MapBiomas fora do ar: MODIS (NASA)
    throw new Error('não consegui ler os mapas do MapBiomas Fogo');
  }
  anos.sort((x, y) => x.ano - y.ano);
  let unico = 0; for (let i = 0; i < queimado.length; i++) if (queimado[i]) unico++;
  return { g, anos, falhas, queimado, unicoHa: unico * pxHa, somaHa: anos.reduce((s, a) => s + a.ha, 0), fonte: 'MapBiomas Fogo, Coleção 5 (30 m)' };
}

// ---------- Idade da pastagem (anos seguidos como pastagem no MapBiomas 30 m) ----------
const IDADE = [[1, 5, '1 a 5 anos', '#E4DF6E'], [6, 10, '6 a 10 anos', '#BDCA77'], [11, 20, '11 a 20 anos', '#9DCB8F'], [21, 30, '21 a 30 anos', '#7ABF88'], [31, 39, '31 a 39 anos', '#39A7A4'], [40, 999, 'desde 1985 ou antes', '#310032']];
async function idadePastagem(f) {
  const [a0, a1] = MB.COL.m30.anos, anos = [];
  for (let a = a1; a >= a0; a--) anos.push(a);
  let ms;
  try { ms = await pool(anos, 6, a => MB.ler('m30', a)); }
  catch (e) { throw new Error('a idade da pastagem precisa da série do MapBiomas desde 1985, e o MapBiomas suspendeu os downloads de mapas; volta a funcionar quando eles reabrirem'); }
  if (ms.some(m => m.alt)) throw new Error('a idade da pastagem precisa da série do MapBiomas desde 1985, e o MapBiomas suspendeu os downloads de mapas');
  const g = ms[0].g, N = ms[0].cod.length, lat = (g.bbox[1] + g.bbox[3]) / 2;
  const pxHa = Math.pow(g.res * 111320, 2) * Math.cos(lat * Math.PI / 180) / 1e4;
  const idade = new Uint8Array(N), cont = IDADE.map(() => 0), vals = [];
  for (let i = 0; i < N; i++) {
    if (!g.mask[i] || ms[0].cod[i] !== 15) continue;
    let k = 0; while (k < ms.length && ms[k].cod[i] === 15) k++;
    idade[i] = k; vals.push(k);
    cont[IDADE.findIndex(c => k >= c[0] && k <= c[1])]++;
  }
  if (!vals.length) return { g, ano: a1, ha: 0, classes: [], idade };
  vals.sort((x, y) => x - y);
  const tot = vals.length;
  return {
    g, ano: a1, idade, pxHa, ha: tot * pxHa, media: vals.reduce((s, v) => s + v, 0) / tot, mediana: vals[Math.floor(tot / 2)], max: a1 - a0 + 1,
    classes: IDADE.map((c, i) => ({ nome: c[2], cor: c[3], ha: cont[i] * pxHa, pct: cont[i] / tot * 100 })),
  };
}
function desenharIdade(I) {
  const { g, idade } = I, cv = document.createElement('canvas'); cv.width = g.W; cv.height = g.H;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(g.W, g.H), d = img.data;
  const hx = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  for (let i = 0; i < idade.length; i++) {
    if (!idade[i]) continue;
    const c = hx(IDADE.find(c => idade[i] >= c[0] && idade[i] <= c[1])[3]), o = i * 4;
    d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 235;
  }
  ctx.putImageData(img, 0, 0); return cv.toDataURL('image/png');
}

// ---------- Imagem recente e vigor da pastagem (NDVI do Sentinel-2 sobre a pastagem do MapBiomas) ----------
const VIGOR = [[-1, 0.35, 'Baixo', '#fa6970'], [0.35, 0.55, 'Médio', '#f7b47e'], [0.55, 2, 'Alto', '#44b160']];
async function cenaRecente(f) {
  const hoje = new Date(), ini = new Date(hoje - 120 * 864e5);
  const cenas = await stacSearch(f.polys, isoDay(ini), isoDay(hoje), 60, 40, 's2');
  let melhor = null;
  for (const it of cenas.slice(0, 6)) {
    try {
      const r = await processScene(it, null, true);
      const nuv = r.nIn ? r.nCloud / r.nIn : 1;
      if (!melhor || nuv < melhor.nuv) melhor = { r, nuv };
      if (nuv < 0.1) break;
    } catch (e) { console.warn('cena', e.message); }
  }
  if (!melhor) throw new Error('nenhuma imagem do Sentinel-2 aproveitável nos últimos 4 meses');
  return melhor.r;
}
function vigorPastagem(cena, uso) {
  // uso: leitura do MapBiomas (grade geográfica); cena: Sentinel-2 (grade UTM)
  const { g } = uso, fwd = toUTM(cena.g.epsg), G = cena.g;
  const lat = (g.bbox[1] + g.bbox[3]) / 2, pxHa = Math.pow(g.res * 111320, 2) * Math.cos(lat * Math.PI / 180) / 1e4;
  const classe = new Uint8Array(uso.cod.length), cont = [0, 0, 0]; let soma = 0, n = 0;
  for (let j = 0; j < g.H; j++) for (let i = 0; i < g.W; i++) {
    const k = j * g.W + i; if (!g.mask[k] || uso.cod[k] !== 15) continue;
    const lon = g.bbox[0] + (i + 0.5) * g.res, la = g.bbox[3] - (j + 0.5) * g.res, [x, y] = fwd([lon, la]);
    const ci = Math.floor((x - G.bbox[0]) / G.res), cj = Math.floor((G.bbox[3] - y) / G.res);
    if (ci < 0 || cj < 0 || ci >= G.W || cj >= G.H) continue;
    const v = cena.ndvi[cj * G.W + ci]; if (Number.isNaN(v)) continue;
    const c = VIGOR.findIndex(q => v >= q[0] && v < q[1]); classe[k] = c + 1; cont[c]++; soma += v; n++;
  }
  if (!n) return null;
  return { g, classe, pxHa, media: soma / n, ha: n * pxHa, data: cena.it.properties.datetime, classes: VIGOR.map((q, i) => ({ nome: q[2], cor: q[3], ha: cont[i] * pxHa, pct: cont[i] / n * 100 })) };
}
function desenharClasse(g, classe, cores) {
  const cv = document.createElement('canvas'); cv.width = g.W; cv.height = g.H;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(g.W, g.H), d = img.data;
  const hx = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const C = cores.map(hx);
  for (let i = 0; i < classe.length; i++) { if (!classe[i]) continue; const c = C[classe[i] - 1], o = i * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 235; }
  ctx.putImageData(img, 0, 0); return cv.toDataURL('image/png');
}

// ---------- Solo (SoilGrids / ISRIC, 250 m) ----------
const WRB_SIBCS = {
  Ferralsols: 'Latossolos', Acrisols: 'Argissolos', Lixisols: 'Argissolos', Alisols: 'Argissolos', Luvisols: 'Luvissolos', Nitisols: 'Nitossolos',
  Plinthosols: 'Plintossolos', Gleysols: 'Gleissolos', Arenosols: 'Neossolos Quartzarênicos', Leptosols: 'Neossolos Litólicos', Regosols: 'Neossolos Regolíticos',
  Fluvisols: 'Neossolos Flúvicos', Cambisols: 'Cambissolos', Vertisols: 'Vertissolos', Planosols: 'Planossolos', Podzols: 'Espodossolos', Histosols: 'Organossolos',
  Solonetz: 'Planossolos Nátricos', Chernozems: 'Chernossolos', Phaeozems: 'Chernossolos', Kastanozems: 'Chernossolos', Umbrisols: 'Cambissolos Húmicos',
  Stagnosols: 'Planossolos/Gleissolos', Retisols: 'Argissolos', Durisols: 'Plintossolos', Calcisols: 'Cambissolos/Chernossolos', Gypsisols: '—', Solonchaks: 'Gleissolos Sálicos', Anthrosols: '—', Technosols: '—', Cryosols: '—',
};
async function soloNoPonto(lon, lat) {
  const ler = async u => { const t = await buscarTexto(u); return JSON.parse(t); };
  const props = ['clay', 'sand', 'silt', 'phh2o', 'soc', 'cec', 'nitrogen'];
  const u = `https://rest.isric.org/soilgrids/v2.0/properties/query?lon=${lon.toFixed(5)}&lat=${lat.toFixed(5)}&${props.map(p => 'property=' + p).join('&')}&depth=0-5cm&depth=5-15cm&depth=15-30cm&value=mean`;
  const j = await ler(u);
  const out = { prof: {} };
  for (const L of (j.properties && j.properties.layers) || []) {
    const df = (L.unit_measure && L.unit_measure.d_factor) || 1, v = {};
    L.depths.forEach(d => { const m = d.values && d.values.mean; v[d.label] = m == null ? NaN : m / df; });
    out.prof[L.name] = v;
  }
  if (!out.prof.clay || Number.isNaN(out.prof.clay['0-5cm'])) throw new Error('sem dado de solo neste ponto');
  // média 0–30 cm ponderada pela espessura
  const p030 = n => { const v = out.prof[n]; if (!v) return NaN; const a = v['0-5cm'], b = v['5-15cm'], c = v['15-30cm']; return [a, b, c].some(Number.isNaN) ? a : (a * 5 + b * 10 + c * 15) / 30; };
  // valores já convertidos pelo d_factor da API: argila/areia/silte em %, C orgânico em g/kg, CTC em cmol(c)/kg, N em g/kg
  out.argila = p030('clay'); out.areia = p030('sand'); out.silte = p030('silt');
  out.ph = out.prof.phh2o ? out.prof.phh2o['0-5cm'] : NaN; out.co = out.prof.soc ? out.prof.soc['0-5cm'] : NaN;
  out.ctc = out.prof.cec ? out.prof.cec['0-5cm'] : NaN; out.n = out.prof.nitrogen ? out.prof.nitrogen['0-5cm'] : NaN;
  out.textura = out.argila > 60 ? 'Muito argilosa' : out.argila >= 35 ? 'Argilosa' : out.areia < 15 ? 'Siltosa' : (out.areia - out.argila) >= 70 ? 'Arenosa' : 'Média';
  try {
    const c = await ler(`https://rest.isric.org/soilgrids/v2.0/classification/query?lon=${lon.toFixed(5)}&lat=${lat.toFixed(5)}&number_classes=3`);
    out.wrb = (c.wrb_class_probability || []).map(([nome, p]) => ({ nome, sibcs: WRB_SIBCS[nome] || '—', p }));
  } catch (e) { out.wrb = null; }
  return out;
}

// ---------- Climatologia (Open-Meteo, reanálise ERA5, desde 1991) ----------
async function climatologia(lon, lat) {
  const fim = isoDay(new Date(Date.now() - 6 * 864e5));
  const u = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&start_date=1991-01-01&end_date=${fim}&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum&timezone=America%2FSao_Paulo`;
  const r = await fetch(u); if (!r.ok) throw new Error(`clima histórico respondeu ${r.status}`);
  const d = (await r.json()).daily, T = d.time, P = d.precipitation_sum;
  const anoFim = +fim.slice(0, 4), anosCompletos = [];
  for (let a = 1991; a < anoFim; a++) anosCompletos.push(a);
  const tot = {}, tmx = Array.from({ length: 12 }, () => []), tmn = Array.from({ length: 12 }, () => []), tme = Array.from({ length: 12 }, () => []);
  const veran = {}; // [ano-mes] -> maior sequência sem chuva (< 1 mm) dentro do mês
  let run = 0, chave = '';
  for (let i = 0; i < T.length; i++) {
    const a = +T[i].slice(0, 4), m = +T[i].slice(5, 7) - 1, k = a + '-' + m, p = P[i];
    if (k !== chave) { chave = k; run = 0; }
    if (p != null) tot[k] = (tot[k] || 0) + p;
    if (d.temperature_2m_max[i] != null) tmx[m].push(d.temperature_2m_max[i]);
    if (d.temperature_2m_min[i] != null) tmn[m].push(d.temperature_2m_min[i]);
    if (d.temperature_2m_mean[i] != null) tme[m].push(d.temperature_2m_mean[i]);
    run = p != null && p < 1 ? run + 1 : 0; veran[k] = Math.max(veran[k] || 0, run);
  }
  const med = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
  const quant = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; };
  const meses = MESES.map((nome, m) => {
    const ch = anosCompletos.map(a => tot[a + '-' + m]).filter(v => v != null), ve = anosCompletos.map(a => ({ a, v: veran[a + '-' + m] })).filter(x => x.v != null);
    const pior = ve.reduce((b, x) => x.v > b.v ? x : b, { a: null, v: -1 });
    return { nome, chuva: med(ch), p10: quant(ch, .1), p90: quant(ch, .9), tmax: med(tmx[m]), tmin: med(tmn[m]), tmed: med(tme[m]), veranMed: med(ve.map(x => x.v)), veranMax: pior.v, veranAno: pior.a };
  });
  const anuais = anosCompletos.map(a => ({ a, mm: MESES.reduce((s, _, m) => s + (tot[a + '-' + m] || 0), 0) }));
  const chuvaAnual = med(anuais.map(x => x.mm));
  // últimos 30 dias contra a média dos mesmos dias nos anos anteriores
  const n = T.length, iniRec = Math.max(0, n - 30);
  const rec = P.slice(iniRec).reduce((s, v) => s + (v || 0), 0);
  const md = T.slice(iniRec).map(t => t.slice(5));
  const normais = anosCompletos.map(a => {
    let s = 0; md.forEach(x => { const i = T.indexOf(`${a}-${x}`); if (i >= 0) s += P[i] || 0; }); return s;
  });
  const normal = med(normais);
  // estação chuvosa: meses com chuva média >= 100 mm; meses secos: < 50 mm
  const chuvosos = meses.map((x, m) => ({ ...x, m })).filter(x => x.chuva >= 100), secos = meses.filter(x => x.chuva < 50);
  let piorVeranico = null;
  chuvosos.forEach(x => { if (!piorVeranico || x.veranMax > piorVeranico.dias) piorVeranico = { dias: x.veranMax, mes: x.nome, ano: x.veranAno }; });
  const maiorMedio = meses.reduce((b, x) => x.veranMed > b.veranMed ? x : b, meses[0]);
  const chuvoso = meses.reduce((b, x) => x.chuva > b.chuva ? x : b, meses[0]), seco = meses.reduce((b, x) => x.chuva < b.chuva ? x : b, meses[0]);
  return {
    ini: T[0], fim: T[n - 1], anos: anosCompletos.length, meses, chuvaAnual, anuais, chuvoso, seco, secos: secos.length,
    recente: { ini: T[iniRec], fim: T[n - 1], mm: rec, normal, dif: normal > 0 ? (rec - normal) / normal * 100 : NaN },
    tAnual: [Math.min(...meses.map(x => x.tmin)), Math.max(...meses.map(x => x.tmax))],
    piorVeranico, maiorMedio, chuvosos: chuvosos.map(x => x.nome),
  };
}
