/* AgroSat — consultas às bases públicas (CAR, SIGEF, IBAMA, PRODES, INPE Queimadas, clima)
   e relatório. Usa o servidor-ponte (Cloudflare Worker) para as bases do governo. */
'use strict';

const UFS = ['AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO'];
const CONF = {
  get proxy() { return (store('agrosat.proxy') || window.AGROSAT_PROXY || '').replace(/\/+$/, ''); },
  get consultor() { return store('agrosat.consultor') || window.AGROSAT_CONSULTOR || {}; },
  raioKm: 5,        // entorno analisado para embargos e focos
  diasFocos: 10,
};
const STATUS_CAR = { AT: 'Ativo', PE: 'Pendente', SU: 'Suspenso', CA: 'Cancelado' };

// ---------- Acesso às bases ----------
function precisaPonte() {
  if (!CONF.proxy) throw new Error('Configure o endereço do servidor-ponte (⚙ Configurações).');
}
const viaPonte = url => `${CONF.proxy}/?url=${encodeURIComponent(url)}`;

// Tenta direto do navegador; se a base recusar (CORS), passa pelo servidor-ponte.
const diretoBloqueado = new Set();
async function buscarTexto(url) {
  const host = new URL(url).hostname;
  if (!diretoBloqueado.has(host)) {
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 25000);
      const r = await fetch(url, { signal: ctl.signal }); clearTimeout(t);
      if (r.ok) return await r.text();
      if (r.status >= 500 && !CONF.proxy) throw new Error(`a base respondeu ${r.status} (fora do ar?)`);
    } catch (e) { if (/fora do ar/.test(e.message)) throw e; diretoBloqueado.add(host); }
  }
  if (!CONF.proxy) throw new Error('esta base não aceita consulta direta do navegador. Configure o servidor-ponte em ⚙ Configurações.');
  const r = await fetch(viaPonte(url));
  if (!r.ok) throw new Error(`base respondeu ${r.status}`);
  return r.text();
}
async function getGeo(url) {
  const txt = await buscarTexto(url);
  let fc;
  const t = txt.trim();
  if (t.startsWith('{')) fc = JSON.parse(t);
  else if (t.startsWith('<')) {
    if (/ServiceException|ExceptionReport/i.test(t)) throw new Error('a base recusou a consulta');
    fc = gmlToGeoJSON(t);
  } else throw new Error('resposta inesperada da base');
  fc.features = (fc.features || []).filter(f => f && f.geometry);
  fc.features.forEach(fixAxis);
  return fc;
}
// Alguns servidores devolvem latitude/longitude invertidas. No Brasil a longitude fica entre −75 e −28.
function fixAxis(f) {
  let first = null;
  turf.coordEach(f, c => { if (!first) first = c; });
  if (first && (first[0] > -28 || first[0] < -75) && first[1] <= -28 && first[1] >= -75) turf.coordEach(f, c => { const x = c[0]; c[0] = c[1]; c[1] = x; });
}
// GML simples (MapServer/i3Geo) -> GeoJSON
function gmlToGeoJSON(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const members = [...doc.getElementsByTagNameNS('*', 'featureMember'), ...doc.getElementsByTagNameNS('*', 'member')];
  const parseCoords = el => {
    const pl = el.getElementsByTagNameNS('*', 'posList')[0];
    if (pl) { const n = pl.textContent.trim().split(/\s+/).map(Number); const out = []; for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]); return out; }
    const cs = el.getElementsByTagNameNS('*', 'coordinates')[0];
    if (cs) return cs.textContent.trim().split(/\s+/).map(p => p.split(',').slice(0, 2).map(Number));
    return [];
  };
  const features = [];
  for (const m of members) {
    const feat = m.firstElementChild; if (!feat) continue;
    const polys = [...feat.getElementsByTagNameNS('*', 'Polygon')].map(pg => {
      const rings = [];
      const outer = pg.getElementsByTagNameNS('*', 'outerBoundaryIs')[0] || pg.getElementsByTagNameNS('*', 'exterior')[0];
      if (outer) rings.push(parseCoords(outer));
      [...pg.getElementsByTagNameNS('*', 'innerBoundaryIs'), ...pg.getElementsByTagNameNS('*', 'interior')].forEach(h => rings.push(parseCoords(h)));
      return rings;
    }).filter(r => r.length && r[0].length > 3);
    if (!polys.length) continue;
    const props = {};
    for (const c of feat.children) if (c.children.length === 0) props[c.localName] = c.textContent;
    features.push({ type: 'Feature', properties: props, geometry: polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys } });
  }
  return { type: 'FeatureCollection', features };
}
const bboxStr = b => b.map(v => v.toFixed(6)).join(',');

// CAR (SICAR)
const carWFS = (uf, extra) => `https://geoserver.car.gov.br/geoserver/sicar/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=sicar:sicar_imoveis_${uf.toLowerCase()}&outputFormat=application/json&srsName=EPSG:4326&maxFeatures=200${extra}`;
async function carPorCodigo(cod) {
  cod = cod.trim().toUpperCase().replace(/\s+/g, '');
  const uf = cod.slice(0, 2);
  if (!UFS.includes(uf)) throw new Error('Código do CAR deve começar com a sigla do estado, ex.: MA-2110005-...');
  const fc = await getGeo(carWFS(uf, `&CQL_FILTER=${encodeURIComponent(`cod_imovel='${cod}'`)}`));
  if (!fc.features.length) throw new Error('CAR não encontrado. Confira o código.');
  return fc.features[0];
}
async function carNaArea(b, uf) { return (await getGeo(carWFS(uf, `&bbox=${bboxStr(b)}`))).features; }
async function carNoPonto(lon, lat, uf) {
  const d = 0.0008, fs = await carNaArea([lon - d, lat - d, lon + d, lat + d], uf);
  const pt = turf.point([lon, lat]);
  return fs.filter(f => { try { return turf.booleanPointInPolygon(pt, f); } catch { return false; } });
}
// Serviços ArcGIS (aceitam consulta direta do navegador)
const ARC_SIGEF = 'https://geo.infrasa.gov.br/server/rest/services/Hosted/Sigef_Brasil/FeatureServer/0';
const ARC_EMBARGO = 'https://pamgia.ibama.gov.br/server/rest/services/01_Publicacoes_Bases/adm_embargos_ibama_a/MapServer/0'; // camada oficial viva (a antiga embargos_siscom_brasil ficou vazia)
function esriParaGeoJSON(j) {
  if (j.error) throw new Error(j.error.message || 'a base recusou a consulta');
  const area = r => { let a = 0; for (let i = 0, k = r.length - 1; i < r.length; k = i++) a += (r[k][0] - r[i][0]) * (r[k][1] + r[i][1]); return a / 2; };
  const features = (j.features || []).filter(f => f.geometry && f.geometry.rings).map(f => {
    const polys = [];
    f.geometry.rings.forEach(r => { if (area(r) < 0 || !polys.length) polys.push([r]); else polys[polys.length - 1].push(r); }); // externo: sentido horário
    return { type: 'Feature', properties: f.attributes || {}, geometry: polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys } };
  });
  return { type: 'FeatureCollection', features };
}
async function arcgisNaArea(servico, b) {
  const q = `${servico}/query?where=1%3D1&geometry=${bboxStr(b)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&resultRecordCount=500&f=json`;
  const fc = esriParaGeoJSON(JSON.parse(await buscarTexto(q)));
  fc.features.forEach(fixAxis);
  return fc.features;
}
// SIGEF: base nacional (Infra S.A.) e, se falhar, Acervo Fundiário do INCRA por estado (via ponte)
async function sigefNaArea(b, uf) {
  try { const fs = await arcgisNaArea(ARC_SIGEF, b); fs.forEach(f => f.properties._tema = 'SIGEF'); return fs; }
  catch (e) { console.warn('SIGEF Infra S.A. falhou:', e.message); }
  const out = [];
  for (const tema of [`certificada_sigef_particular_${uf.toLowerCase()}`, `certificada_sigef_publico_${uf.toLowerCase()}`]) {
    const base = `https://acervofundiario.incra.gov.br/i3geo/ogc.php?tema=${tema}&service=WFS&version=1.0.0&request=GetFeature&typename=${tema}&bbox=${bboxStr(b)}`;
    let fc = null;
    try { fc = await getGeo(base + '&outputformat=geojson'); } catch (e) { fc = await getGeo(base); }
    fc.features.forEach(f => f.properties._tema = tema.includes('publico') ? 'Público' : 'Particular');
    out.push(...fc.features);
  }
  return out;
}
// Embargos IBAMA: PAMGIA (cópia oficial do SISCOM, atualizada 2x ao dia) e, se falhar, SISCOM
async function embargosNaArea(b) {
  let erroPamgia;
  try { return await arcgisNaArea(ARC_EMBARGO, b); }
  catch (e) { erroPamgia = e; console.warn('PAMGIA falhou:', e.message); }
  if (!CONF.proxy) throw new Error('o servidor do IBAMA (PAMGIA) não respondeu: ' + erroPamgia.message);
  return (await getGeo(`https://siscom.ibama.gov.br/geoserver/publica/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=publica:vw_brasil_adm_embargo_a&outputFormat=application/json&srsName=EPSG:4326&maxFeatures=500&bbox=${bboxStr(b)}`)).features;
}
// PRODES (Amazônia Legal e Cerrado)
async function prodesNaArea(b) {
  const out = [];
  for (const [ws, nome] of [['prodes-legal-amz', 'Amazônia Legal'], ['prodes-cerrado-nb', 'Cerrado']]) {
    try {
      const fc = await getGeo(`https://terrabrasilis.dpi.inpe.br/geoserver/${ws}/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=${ws}:yearly_deforestation&outputFormat=application/json&srsName=EPSG:4326&maxFeatures=2000&bbox=${bboxStr(b)}`);
      fc.features.forEach(f => f.properties._fonte = nome); out.push(...fc.features);
    } catch (e) { if (ws === 'prodes-cerrado-nb' && !out.length) throw e; }
  }
  return out;
}
// Focos de queimada INPE
async function focosNaArea(b, dias) {
  if (CONF.proxy) {
    const r = await fetch(`${CONF.proxy}/focos?bbox=${bboxStr(b)}&dias=${dias}`);
    if (!r.ok) throw new Error(`ponte respondeu ${r.status}`);
    return r.json();
  }
  // sem ponte: tenta ler os arquivos diários do INPE direto
  const base = 'https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario/Brasil/';
  const focos = [], arquivos = []; let bloqueado = 0;
  await Promise.all(Array.from({ length: dias + 1 }, async (_, k) => {
    const nome = `focos_diario_br_${isoDay(new Date(Date.now() - k * 864e5)).replace(/-/g, '')}.csv`;
    try {
      const r = await fetch(base + nome); if (!r.ok) return;
      const linhas = (await r.text()).split(/\r?\n/), cab = linhas[0].split(',').map(s => s.trim().toLowerCase());
      const iLat = cab.indexOf('lat'), iLon = cab.indexOf('lon'); arquivos.push(nome);
      for (let i = 1; i < linhas.length; i++) {
        const c = linhas[i].split(','), lat = +c[iLat], lon = +c[iLon];
        if (lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]) { const o = {}; cab.forEach((h, j) => o[h] = c[j]); focos.push(o); }
      }
    } catch (e) { bloqueado++; }
  }));
  if (!arquivos.length && bloqueado) throw new Error('o INPE não aceita consulta direta do navegador. Configure o servidor-ponte em ⚙ Configurações.');
  return { arquivos, focos };
}
// Clima (Open-Meteo, sem chave)
async function climaNoPonto(lon, lat) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m&daily=precipitation_sum,temperature_2m_max,temperature_2m_min&past_days=30&forecast_days=7&timezone=auto`;
  const r = await fetch(u); if (!r.ok) throw new Error(`clima respondeu ${r.status}`);
  return r.json();
}

// datas: texto 'AAAA-MM-DD…' ou número em milissegundos (ArcGIS)
function dataISO(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' || /^\d{11,}$/.test(String(v))) { const d = new Date(+v); return isNaN(d) ? '' : d.toISOString().slice(0, 10); }
  return String(v).slice(0, 10);
}
// ---------- Geometria auxiliar ----------
function farmFeature(f) { return f.polys.length === 1 ? turf.polygon(f.polys[0]) : turf.multiPolygon(f.polys); }
function interHa(a, b) {
  try { const i = turf.intersect(a, b); return i ? turf.area(i) / 1e4 : 0; } catch (e) { return 0; }
}
// Área (ha) da UNIÃO das partes de várias feições que caem dentro da fazenda.
// Evita contar duas vezes onde as próprias feições se sobrepõem entre si.
function uniaoDentroHa(farmF, feats) {
  let U = null, soma = 0;
  for (const ft of feats) {
    let i = null;
    try { i = turf.intersect(farmF, ft); } catch (e) { i = null; }
    if (!i) continue;
    soma += turf.area(i) / 1e4;
    try { U = U ? (turf.union(U, i) || U) : i; } catch (e) { return Math.min(soma, turf.area(farmF) / 1e4); }
  }
  return U ? turf.area(U) / 1e4 : 0;
}
// '2026-10-31 16:20:00' (UTC) -> '31/10 às 13:20' no horário do aparelho
function dataHoraFoco(s) {
  if (!s) return '';
  const d = new Date(String(s).trim().replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
  if (isNaN(d)) return esc(s);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', ' às');
}
const agoraBR = iso => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', ' às');
const FONTES_DIAG = 'SICAR/SFB (CAR) · INCRA/SIGEF e Infra S.A. (parcelas certificadas) · IBAMA/PAMGIA–SISCOM (embargos) · INPE/TerraBrasilis (PRODES) · INPE/BDQueimadas (focos de queimada) · Open‑Meteo (clima)';
// Bases sem consulta por mapa: o app indica onde conferir pelo CPF/CNPJ do proprietário
const OUTRAS_LISTAS = [
  ['Embargos do ICMBio (unidades de conservação federais)', 'https://www.gov.br/pt-br/servicos/consultar-ocorrencia-de-embargo-e-emitir-certidao-negativa-de-embargo-icmbio'],
  ['Embargos da SEMA‑MA (órgão estadual)', 'https://www.sema.ma.gov.br/'],
  ['Lista de Trabalho Escravo (Cadastro de Empregadores do MTE)', 'https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho/areas-de-atuacao/cadastro_de_empregadores.pdf'],
  ['Certidão negativa de embargo do IBAMA', 'https://servicos.ibama.gov.br/ctf/publico/areasembargadas/ConsultaPublicaAreasEmbargadas.php'],
];
function distKm(farmF, feat) {
  try {
    if (interHa(farmF, feat) > 0) return 0;
    const line = turf.polygonToLine(farmF);
    let best = Infinity;
    turf.coordEach(feat, c => {
      const lines = line.type === 'FeatureCollection' ? line.features : [line];
      for (const l of lines) best = Math.min(best, turf.pointToLineDistance(turf.point(c), l, { units: 'kilometers' }));
    });
    return best;
  } catch (e) { return NaN; }
}
const ha = (v, d) => `${fmt(v, d != null ? d : v < 10 ? 2 : v < 100 ? 1 : 0)} ha`;
const pick = (p, ...ks) => { for (const k of ks) { const hit = Object.keys(p).find(x => x.toLowerCase() === k); if (hit && p[hit] !== null && p[hit] !== '') return p[hit]; } return null; };

// ---------- Diagnóstico ----------
const DL = { group: null };
function limparDiag() { if (DL.group) { DL.group.remove(); DL.group = null; } }

async function rodarDiagnostico() {
  const f = farm(); if (!f) return;
  const box = $('diagBox'); limparDiag();
  const F = farmFeature(f);
  const fb = turf.bbox(F);
  const viz = turf.bbox(turf.buffer(F, CONF.raioKm, { units: 'kilometers' }));
  const centro = turf.centroid(F).geometry.coordinates;
  const uf = f.uf || 'MA';
  DL.group = L.layerGroup().addTo(map);
  const secoes = [
    ['car', 'CAR e sobreposições', () => carNaArea(fb, uf)],
    ['sigef', 'SIGEF / INCRA', () => sigefNaArea(fb, uf)],
    ['emb', 'Embargos IBAMA', () => embargosNaArea(viz)],
    ['prodes', 'Desmatamento PRODES', () => prodesNaArea(fb)],
    ['fogo', `Focos de queimada (${CONF.diasFocos} dias)`, () => focosNaArea(viz, CONF.diasFocos)],
    ['clima', 'Clima', () => climaNoPonto(centro[0], centro[1])],
  ];
  box.innerHTML = secoes.map(([k, t]) => `<div class="dcard" id="d-${k}"><div class="dh"><span class="dot wait"></span><b>${t}</b></div><div class="db hint">Consultando…</div></div>`).join('');
  S.diag = { data: new Date().toISOString(), itens: {} };
  $('btnDiag').disabled = true;
  await Promise.all(secoes.map(async ([k, t, fn]) => {
    try {
      const res = await fn();
      const out = RENDER[k](res, F, f);
      S.diag.itens[k] = { titulo: t, ...out };
    } catch (e) {
      console.error(k, e);
      S.diag.itens[k] = { titulo: t, nivel: 'erro', resumo: 'Não consegui consultar agora: ' + e.message, detalhes: '' };
    }
    pintarCard(k);
  }));
  box.insertAdjacentHTML('beforeend', `<div class="dfoot">Consulta feita em <b>${agoraBR(S.diag.data)}</b> para ${esc(f.name)}${f.car ? ` (CAR ${esc(f.car)})` : ''}.<br>Fontes: ${FONTES_DIAG}.<br>Para levar ao cliente, use o botão 📄 Relatório.</div>`);
  $('btnDiag').disabled = false;
}
function pintarCard(k) {
  const it = S.diag.itens[k], el = $('d-' + k); if (!el) return;
  el.querySelector('.dot').className = 'dot ' + it.nivel;
  el.querySelector('.db').className = 'db';
  el.querySelector('.db').innerHTML = `<p class="dres">${it.resumo}</p>${it.detalhes ? `<details><summary>Detalhes</summary>${it.detalhes}</details>` : ''}${it.extra || ''}`;
  if (it.chart) it.chart();
}
function camada(feats, style, popup) {
  feats.forEach(ft => L.geoJSON(ft, { style, pointToLayer: (g, ll) => L.circleMarker(ll, style) }).bindPopup(popup(ft)).addTo(DL.group));
}
const tabela = (cab, linhas) => `<table class="tb"><tr>${cab.map(c => `<th>${c}</th>`).join('')}</tr>${linhas.map(l => `<tr>${l.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;

const RENDER = {
  car(feats, F, f) {
    const areaF = turf.area(F) / 1e4;
    const rows = feats.map(ft => {
      const p = ft.properties, oh = interHa(F, ft);
      return { ft, cod: pick(p, 'cod_imovel') || '—', st: pick(p, 'status_imovel') || '', area: +pick(p, 'area', 'num_area') || turf.area(ft) / 1e4, mun: pick(p, 'municipio', 'nom_munici') || '', tipo: pick(p, 'tipo_imovel') || '', cond: pick(p, 'condicao', 'des_condic') || '', oh };
    }).filter(r => r.oh > 0.01).sort((a, b) => b.oh - a.oh);
    camada(rows.map(r => r.ft), { color: '#ffd400', weight: 2, fill: false }, ft => `<b>CAR</b><br>${esc(pick(ft.properties, 'cod_imovel') || '')}`);
    const proprio = f.car ? rows.find(r => r.cod === f.car) : rows.find(r => r.oh / areaF > 0.8);
    const outros = rows.filter(r => r !== proprio && r.oh > 0.5);
    let nivel = 'ok', resumo;
    if (!rows.length) { nivel = 'alerta'; resumo = 'Nenhum CAR encontrado sobre esta área.'; }
    else {
      resumo = proprio ? `CAR <b>${esc(proprio.cod)}</b> · ${STATUS_CAR[proprio.st] || proprio.st || 'situação não informada'} · ${ha(proprio.area)} declarados${proprio.mun ? ' · ' + esc(proprio.mun) : ''}.` : 'Nenhum CAR cobre a maior parte da área.';
      if (proprio && ['SU', 'CA'].includes(proprio.st)) nivel = 'grave';
      else if (proprio && proprio.st === 'PE') nivel = 'alerta';
      if (outros.length) {
        const sob = uniaoDentroHa(F, outros.map(r => r.ft)), pct = sob / areaF * 100;
        // até 5%: costuma ser erro de desenho na divisa; acima de 25%: sobreposição séria
        nivel = nivel === 'grave' || pct >= 25 ? 'grave' : 'alerta';
        resumo += ` <b>${outros.length} outro(s) CAR sobreposto(s)</b>, ocupando <b>${ha(sob)} (${fmt(Math.min(100, pct), 0)}% da área)</b>${pct >= 25 ? '. Sobreposição grande: confira a divisa com os vizinhos e retifique o CAR' : pct < 5 ? ', provavelmente diferença de desenho na divisa' : ''}.`;
      }
    }
    return { nivel, resumo, detalhes: rows.length ? tabela(['Código CAR', 'Situação', 'Área declarada', 'Sobre a fazenda'], rows.map(r => [esc(r.cod), STATUS_CAR[r.st] || esc(r.st), ha(r.area), `${ha(Math.min(r.oh, areaF))} (${fmt(Math.min(100, r.oh / areaF * 100), 0)}%)`])) : '' };
  },
  sigef(feats, F) {
    const areaF = turf.area(F) / 1e4;
    const rows = feats.map(ft => ({ ft, p: ft.properties, oh: interHa(F, ft) })).filter(r => r.oh > 0.01).sort((a, b) => b.oh - a.oh);
    camada(rows.map(r => r.ft), { color: '#00e5ff', weight: 2, fill: false }, ft => `<b>SIGEF</b><br>${esc(pick(ft.properties, 'nome_area', 'parcela_co', 'codigo_imo') || '')}`);
    const cob = uniaoDentroHa(F, rows.map(r => r.ft));
    let nivel = 'ok', resumo;
    if (!rows.length) { nivel = 'alerta'; resumo = 'Nenhuma parcela certificada no SIGEF sobre esta área. A área pode não estar georreferenciada/certificada no INCRA.'; }
    else { if (cob / areaF < 0.8) nivel = 'alerta'; resumo = `${rows.length} parcela(s) certificada(s) cobrindo ${ha(cob)} de ${ha(areaF)} do perímetro cadastrado no app (${fmt(Math.min(100, cob / areaF * 100), 0)}%).${rows.length > 1 ? ' Confira se todas pertencem ao mesmo imóvel.' : ''}${cob / areaF < 0.8 ? ' Parte da área não está certificada.' : ''}`; }
    return { nivel, resumo, detalhes: rows.length ? tabela(['Denominação', 'Código/parcela', 'Situação', 'Sobre a fazenda'], rows.map(r => [esc(pick(r.p, 'nome_area', 'nome_imove', 'denominaca') || '—'), esc(pick(r.p, 'parcela_co', 'codigo_imo', 'cod_imovel') || '—'), esc(pick(r.p, 'situacao_i', 'situ_imov', 'status') || r.p._tema || ''), ha(r.oh)])) : '' };
  },
  emb(feats, F) {
    const rows = feats.map(ft => {
      const p = ft.properties, oh = interHa(F, ft);
      return { ft, oh, km: oh > 0 ? 0 : distKm(F, ft), tad: pick(p, 'num_tad', 'numero_tad', 'nr_tad', 'seq_tad') || '—', data: dataISO(pick(p, 'dat_embargo', 'dat_embarg', 'data_tad', 'dat_ult_al')), mun: pick(p, 'nom_municipio', 'municipio', 'nom_munici') || '', inf: pick(p, 'des_infracao', 'des_tad', 'des_infrac', 'infracao', 'des_embargo') || '', area: +pick(p, 'qtd_area_embargada', 'qtd_area_e', 'area_ha', 'qtd_area_d') || turf.area(ft) / 1e4 };
    }).filter(r => r.oh > 0 || r.km <= CONF.raioKm).sort((a, b) => a.km - b.km);
    camada(rows.map(r => r.ft), { color: '#ff3b3b', weight: 2, fillColor: '#ff3b3b', fillOpacity: .35 }, ft => `<b>Embargo IBAMA</b><br>TAD ${esc(pick(ft.properties, 'num_tad', 'seq_tad') || '')}`);
    const dentro = rows.filter(r => r.oh > 0), perto = rows.filter(r => !r.oh);
    let nivel = 'ok', resumo = `Nenhum embargo do IBAMA na área nem em até ${CONF.raioKm} km.`;
    if (dentro.length) { nivel = 'grave'; resumo = `<b>${dentro.length} embargo(s) dentro da área</b>, somando ${ha(dentro.reduce((s, r) => s + r.oh, 0))}.`; }
    if (perto.length) { if (nivel === 'ok') nivel = 'alerta'; resumo += ` ${perto.length} embargo(s) no entorno de ${CONF.raioKm} km.`; resumo = resumo.replace(`Nenhum embargo do IBAMA na área nem em até ${CONF.raioKm} km. `, 'Nenhum embargo dentro da área. '); }
    const listas = `<p class="hint" style="margin-bottom:4px">Estas bases não têm consulta por mapa. Confira pelo CPF/CNPJ do proprietário:</p><ul class="links">${OUTRAS_LISTAS.map(([t, u]) => `<li><a href="${u}" target="_blank" rel="noopener">${t}</a></li>`).join('')}</ul>`;
    resumo += ' <span class="hint">ICMBio, SEMA‑MA e Lista de Trabalho Escravo: conferir pelo CPF/CNPJ (ver Detalhes).</span>';
    return { nivel, resumo, detalhes: (rows.length ? tabela(['TAD', 'Data', 'Infração', 'Área', 'Distância'], rows.map(r => [esc(r.tad), r.data ? dBR(r.data) : '—', esc(String(r.inf).slice(0, 90)), ha(r.area), r.oh ? `<b>dentro (${ha(r.oh)})</b>` : `${fmt(r.km, 1)} km`])) : '') + listas, listas: OUTRAS_LISTAS };
  },
  prodes(feats, F) {
    const rows = feats.map(ft => {
      const p = ft.properties; let ano = +pick(p, 'year', 'ano');
      if (!ano) { const m = String(pick(p, 'class_name', 'main_class') || '').match(/(19|20)\d\d/); ano = m ? +m[0] : NaN; }
      return { ft, ano, oh: interHa(F, ft), fonte: p._fonte };
    }).filter(r => r.oh > 0.05);
    camada(rows.map(r => r.ft), { color: '#ff9800', weight: 1, fillColor: '#ff9800', fillOpacity: .45 }, ft => `<b>PRODES</b><br>${esc(pick(ft.properties, 'year', 'class_name') || '')}`);
    const porAno = {}; rows.forEach(r => { const k = Number.isNaN(r.ano) ? 's/ano' : r.ano; porAno[k] = (porAno[k] || 0) + r.oh; });
    const pos2008 = rows.filter(r => r.ano >= 2009).reduce((s, r) => s + r.oh, 0);
    const total = rows.reduce((s, r) => s + r.oh, 0);
    const pos2020 = rows.filter(r => r.ano >= 2021).reduce((s, r) => s + r.oh, 0);
    const fontes = [...new Set(rows.map(r => r.fonte).filter(Boolean))];
    let nivel = 'ok', resumo = 'Nenhuma supressão de vegetação nativa mapeada pelo PRODES dentro da área <b>desde 2008</b> (marco de 22/07/2008 do Código Florestal).';
    if (rows.length) {
      nivel = pos2008 > 0 ? 'alerta' : 'ok';
      resumo = `${ha(total)} de supressão mapeada pelo PRODES dentro da área${pos2008 > 0 ? `, sendo <b>${ha(pos2008)} depois de 2008</b> (após o marco de 22/07/2008 do Código Florestal; verifique se havia autorização)` : ', toda até 2008'}.`;
      if (pos2020 > 0) resumo += ` Desse total, <b>${ha(pos2020)} são de 2021 em diante</b> (após a data de corte de 31/12/2020 usada pela União Europeia).`;
    }
    const anos = Object.keys(porAno).sort();
    const nota = `<p class="hint">Período: série anual do PRODES/INPE${fontes.length ? ` (${fontes.join(' e ')})` : ''}, com destaque para o que é posterior a 22/07/2008. O ano PRODES vai de agosto a julho (ex.: “2009” = ago/2008 a jul/2009). Mapeamento por satélite Landsat (30 m); áreas pequenas podem não aparecer.</p>`;
    return { nivel, resumo, detalhes: (anos.length ? tabela(['Ano', 'Área na fazenda'], anos.map(a => [a, ha(porAno[a])])) : '') + nota };
  },
  fogo(res, F) {
    const fs = (res.focos || []).map(o => ({ o, pt: turf.point([+o.lon, +o.lat]) }));
    const dentro = fs.filter(x => { try { return turf.booleanPointInPolygon(x.pt, F); } catch { return false; } });
    const perto = fs.filter(x => !dentro.includes(x)).map(x => ({ ...x, km: distKm(F, x.pt) })).filter(x => x.km <= CONF.raioKm);
    [...dentro, ...perto].forEach(x => L.circleMarker([+x.o.lat, +x.o.lon], { radius: 6, color: '#fff', weight: 1, fillColor: '#ff5a00', fillOpacity: 1 }).bindPopup(`<b>Foco de queimada</b><br>${esc(x.o.data_hora_gmt || '')}<br>${esc(x.o.satelite || '')}`).addTo(DL.group));
    let nivel = 'ok', resumo = `Nenhum foco de queimada na área nem em até ${CONF.raioKm} km nos últimos ${CONF.diasFocos} dias.`;
    const recente = l => l.slice().sort((a, b) => String(b.o.data_hora_gmt).localeCompare(String(a.o.data_hora_gmt)))[0];
    if (dentro.length) { const r = recente(dentro); nivel = 'grave'; resumo = `<b>${dentro.length} foco(s) dentro da área</b> nos últimos ${CONF.diasFocos} dias${perto.length ? `, e mais ${perto.length} a menos de ${CONF.raioKm} km` : ''}. O mais recente dentro da área foi em <b>${dataHoraFoco(r.o.data_hora_gmt)}</b>${r.o.satelite ? ` (satélite ${esc(r.o.satelite)})` : ''}.`; }
    else if (perto.length) { const p = perto.reduce((a, b) => b.km < a.km ? b : a); nivel = 'alerta'; resumo = `${perto.length} foco(s) a menos de ${CONF.raioKm} km nos últimos ${CONF.diasFocos} dias. O mais próximo, a <b>${fmt(p.km, 1)} km</b>, foi em <b>${dataHoraFoco(p.o.data_hora_gmt)}</b>${p.o.satelite ? ` (satélite ${esc(p.o.satelite)})` : ''}.`; }
    resumo += ' <span class="hint">Fonte: INPE/BDQueimadas.</span>';
    const all = [...dentro.map(x => ({ ...x, km: 0 })), ...perto].sort((a, b) => String(b.o.data_hora_gmt).localeCompare(String(a.o.data_hora_gmt)));
    return { nivel, resumo, detalhes: all.length ? tabela(['Data/hora', 'Satélite', 'Distância', 'Dias sem chuva'], all.slice(0, 50).map(x => [dataHoraFoco(x.o.data_hora_gmt), esc(x.o.satelite || ''), x.km ? `${fmt(x.km, 1)} km` : '<b>dentro</b>', esc(x.o.numero_dias_sem_chuva || '—')])) + '<p class="hint">Focos detectados por satélite (INPE/BDQueimadas, arquivos diários). Horário convertido para o fuso do aparelho.</p>' : '' };
  },
  clima(j) {
    const d = j.daily, hoje = isoDay(new Date());
    const idx = d.time.findIndex(t => t >= hoje);
    const passado = d.precipitation_sum.slice(0, idx < 0 ? d.time.length : idx), futuro = idx < 0 ? [] : d.precipitation_sum.slice(idx);
    const chuva30 = passado.reduce((s, v) => s + (v || 0), 0), chuva7 = futuro.reduce((s, v) => s + (v || 0), 0);
    let semChuva = 0; for (let i = passado.length - 1; i >= 0 && (passado[i] || 0) < 1; i--) semChuva++;
    const c = j.current || {};
    const resumo = `Agora: <b>${fmt(c.temperature_2m, 0)} °C</b>, umidade ${fmt(c.relative_humidity_2m, 0)}%. Chuva nos últimos 30 dias: <b>${fmt(chuva30, 0)} mm</b> · ${semChuva} dia(s) seguidos sem chuva. Previsão para 7 dias: <b>${fmt(chuva7, 0)} mm</b>.`;
    const id = 'climaChart' + Date.now();
    return {
      nivel: 'info', resumo, extra: `<div class="chartbox sm"><canvas id="${id}"></canvas></div>`,
      dados: { chuva30, chuva7, semChuva, temp: c.temperature_2m },
      chart: () => {
        const el = document.getElementById(id); if (!el) return;
        if (S.climaChart) S.climaChart.destroy();
        S.climaChart = new Chart(el, {
          data: {
            labels: d.time.map(t => dBR(t).slice(0, 5)),
            datasets: [
              { type: 'bar', label: 'Chuva (mm)', data: d.precipitation_sum, backgroundColor: d.time.map(t => t >= hoje ? '#5aa9ff' : '#2f6fb3'), yAxisID: 'y' },
              { type: 'line', label: 'Máx (°C)', data: d.temperature_2m_max, borderColor: '#f2c14e', pointRadius: 0, tension: .3, yAxisID: 'y2' },
            ],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            scales: { y: { ticks: { color: '#9db3a4' }, grid: { color: '#24382b' }, title: { display: true, text: 'mm', color: '#9db3a4' } }, y2: { position: 'right', ticks: { color: '#9db3a4' }, grid: { display: false } }, x: { ticks: { color: '#9db3a4', maxTicksLimit: 8, maxRotation: 0 }, grid: { display: false } } },
            plugins: { legend: { labels: { color: '#e8f0ea' } } },
          },
        });
      },
    };
  },
};

// ---------- Camadas de referência no mapa (WMS: só imagem, não precisa da ponte) ----------
function camadasReferencia(uf) {
  uf = (uf || 'MA').toLowerCase();
  const o = { format: 'image/png', transparent: true, version: '1.1.1', maxZoom: 19 };
  return {
    'CAR (imóveis)': L.tileLayer.wms('https://geoserver.car.gov.br/geoserver/sicar/wms', { ...o, layers: `sicar:sicar_imoveis_${uf}` }),
    'SIGEF particular': L.tileLayer.wms(`https://acervofundiario.incra.gov.br/i3geo/ogc.php?tema=certificada_sigef_particular_${uf}`, { ...o, layers: `certificada_sigef_particular_${uf}` }),
    'Embargos IBAMA': L.tileLayer.wms('https://siscom.ibama.gov.br/geoserver/publica/wms', { ...o, layers: 'publica:vw_brasil_adm_embargo_a' }),
    'PRODES Cerrado': L.tileLayer.wms('https://terrabrasilis.dpi.inpe.br/geoserver/prodes-cerrado-nb/wms', { ...o, layers: 'prodes-cerrado-nb:yearly_deforestation' }),
    'PRODES Amazônia': L.tileLayer.wms('https://terrabrasilis.dpi.inpe.br/geoserver/prodes-legal-amz/wms', { ...o, layers: 'prodes-legal-amz:yearly_deforestation' }),
  };
}

// ---------- Relatório (imprimir / salvar em PDF) ----------
function imagemNDVIcomContorno() {
  const res = S.result; if (!res || res.isDiff) return null;
  const f = farm(), g = res.g, fwd = toUTM(g.epsg);
  const img = new Image(); img.src = renderCanvas(res, 'ndvi', false);
  return new Promise(ok => {
    img.onload = () => {
      const k = Math.max(1, Math.round(900 / Math.max(g.W, g.H)));
      const cv = document.createElement('canvas'); cv.width = g.W * k; cv.height = g.H * k;
      const ctx = cv.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.imageSmoothingEnabled = S.suave; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, cv.width, cv.height);
      const desenha = (rings, lw) => rings.forEach(r => {
        ctx.lineWidth = lw; ctx.beginPath();
        r.forEach((c, i) => { const [x, y] = fwd(c); const px = (x - g.bbox[0]) / g.res * k, py = (g.bbox[3] - y) / g.res * k; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
        ctx.closePath(); ctx.stroke();
      });
      ctx.strokeStyle = '#111';
      (f.divs || []).forEach(dv => {
        desenha(dv.rings, 1);
        const c = turf.centroid(turf.polygon(dv.rings)).geometry.coordinates, [x, y] = fwd(c);
        ctx.font = `bold ${Math.max(11, 6 * k)}px system-ui`; ctx.textAlign = 'center'; ctx.fillStyle = '#111';
        ctx.fillText(dv.nome, (x - g.bbox[0]) / g.res * k, (g.bbox[3] - y) / g.res * k);
      });
      ctx.lineWidth = 2;
      f.polys.forEach(p => p.forEach(r => {
        ctx.beginPath();
        r.forEach((c, i) => { const [x, y] = fwd(c); const px = (x - g.bbox[0]) / g.res * k, py = (g.bbox[3] - y) / g.res * k; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
        ctx.closePath(); ctx.stroke();
      }));
      ok(cv.toDataURL('image/png'));
    };
  });
}
async function gerarRelatorio() {
  const f = farm(); if (!f) return;
  const cons = CONF.consultor;
  const ndvi = await imagemNDVIcomContorno();
  const st = S.result && !S.result.isDiff ? S.result.stats : null;
  let serieImg = null;
  if (S.chart && S.seriesData && S.seriesData.length) {
    // redesenha o gráfico em fundo branco para impressão
    const cv = document.createElement('canvas'); cv.width = 900; cv.height = 320; cv.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(cv);
    const ch = new Chart(cv, { type: 'line', data: { labels: S.seriesData.map(r => dBR(r.date)), datasets: [{ label: 'NDVI', data: S.seriesData.map(r => r.ndvi), borderColor: '#1a9850', tension: .3 }, { label: 'NDRE', data: S.seriesData.map(r => r.ndre), borderColor: '#d4a017', borderDash: [4, 3], tension: .3 }] }, options: { animation: false, responsive: false, scales: { y: { min: 0, max: 1 } } } });
    serieImg = cv.toDataURL('image/png'); ch.destroy(); cv.remove();
  }
  const cor = { ok: '#1a9850', alerta: '#e0a800', grave: '#d73027', erro: '#888', info: '#2f6fb3' };
  const rot = { ok: 'Sem pendências', alerta: 'Atenção', grave: 'Crítico', erro: 'Não consultado', info: 'Informativo' };
  const diag = S.diag ? ['car', 'sigef', 'emb', 'prodes', 'fogo', 'clima'].map(k => S.diag.itens[k]).filter(Boolean) : [];
  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório — ${esc(f.name)}</title>
<style>
 body{font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1b1b1b;margin:0;padding:24px 28px;max-width:900px}
 header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #1a9850;padding-bottom:10px;margin-bottom:16px}
 h1{font-size:20px;margin:0} h2{font-size:15px;margin:22px 0 8px;color:#1a6b3c;border-bottom:1px solid #ddd;padding-bottom:4px}
 .sub{color:#555;font-size:12px} .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
 .k{border:1px solid #ddd;border-radius:8px;padding:8px} .k b{display:block;font-size:17px}
 table{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px} th,td{border:1px solid #ddd;padding:4px 6px;text-align:left} th{background:#f2f5f3}
 .tag{display:inline-block;color:#fff;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700}
 img{max-width:100%} .item{margin-bottom:10px;page-break-inside:avoid} details{display:block} summary{display:none}
 .grad{height:10px;border-radius:5px;background:linear-gradient(90deg,#a50026,#f46d43,#fee08b,#a6d96a,#1a9850,#006837);margin:4px 0}
 .hint{color:#666;font-size:11.5px} ul.links{margin:4px 0 0;padding-left:18px;font-size:12px} a{color:#1a6b3c}
 footer{margin-top:26px;border-top:1px solid #ddd;padding-top:8px;font-size:11px;color:#666}
 @media print{body{padding:0} button{display:none}}
</style></head><body>
<div style="text-align:right;margin-bottom:10px"><button onclick="print()" style="padding:8px 14px">Imprimir / salvar PDF</button></div>
<header><div><h1>Relatório da propriedade — ${esc(f.name)}</h1>
<div class="sub">${f.owner ? 'Cliente: ' + esc(f.owner) + ' · ' : ''}${ha(f.area)} · ${esc(f.uf || '')}${f.car ? ' · CAR ' + esc(f.car) : ''}</div></div>
<div class="sub" style="text-align:right">${cons.nome ? '<b>' + esc(cons.nome) + '</b><br>' : ''}${cons.empresa ? esc(cons.empresa) + '<br>' : ''}${cons.contato ? esc(cons.contato) + '<br>' : ''}Emitido em ${dBR(isoDay(new Date()))}</div></header>
${diag.length ? `<h2>Situação ambiental e fundiária</h2><p class="sub">Bases públicas consultadas em ${agoraBR(S.diag.data)}.</p>${diag.map(d => `<div class="item"><span class="tag" style="background:${cor[d.nivel]}">${rot[d.nivel]}</span> <b>${d.titulo}</b><div>${d.resumo}</div>${d.detalhes || ''}</div>`).join('')}` : '<p class="sub">Situação não verificada (aba Situação).</p>'}
${ndvi ? `<h2>Vigor da vegetação — ${dBR(S.result.it.properties.datetime)}</h2>
<div style="display:grid;grid-template-columns:1.4fr 1fr;gap:14px;align-items:start"><div><img src="${ndvi}"><div class="grad"></div><div class="sub" style="display:flex;justify-content:space-between"><span>NDVI baixo</span><span>NDVI alto</span></div></div>
<div><div class="grid" style="grid-template-columns:1fr 1fr">${st ? `<div class="k"><b>${fmt(st.mean)}</b>NDVI médio</div><div class="k"><b>${S.result.statsRE ? fmt(S.result.statsRE.mean) : '—'}</b>NDRE médio</div><div class="k"><b>${fmt(st.p10)}</b>pior 10%</div><div class="k"><b>${fmt(st.p90)}</b>melhor 10%</div>` : ''}</div>${tabelaDivs(S.result.divStats)}</div></div>` : '<p class="sub">Nenhuma imagem de satélite aberta (aba Imagens).</p>'}
${typeof CL !== 'undefined' && CL.dados ? `<h2>Clima — ${dBR(CL.dados.ini)} a ${dBR(CL.dados.fim)}</h2><div class="grid"><div class="k"><b>${fmt(CL.dados.chuva, 0)} mm</b>chuva acumulada</div><div class="k"><b>${CL.dados.diasChuva}</b>dias com chuva</div><div class="k"><b>${CL.dados.seco}</b>dias seguidos sem chuva</div><div class="k"><b>+${fmt(CL.dados.gdd, 0)}</b>soma térmica (base ${CL.dados.tb} °C)</div><div class="k"><b>${fmt(CL.dados.tmaxMed, 1)}° / ${fmt(CL.dados.tminMed, 1)}°</b>máx / mín médias</div><div class="k"><b>${fmt(CL.dados.chuvaPrev, 0)} mm</b>previsão 7 dias</div></div>` : ''}
${serieImg ? `<h2>Histórico de NDVI</h2><img src="${serieImg}"><p class="sub">${$('serieSum').textContent}</p>` : ''}
<footer>Fontes: ${FONTES_DIAG} · Copernicus Sentinel‑2/ESA (imagens).${S.diag ? ` Situação consultada em ${agoraBR(S.diag.data)}.` : ''} Relatório emitido em ${agoraBR(new Date().toISOString())}. Dados públicos; não substituem certidões oficiais.${cons.nome || cons.empresa ? `<br>${esc([cons.nome, cons.empresa, cons.contato].filter(Boolean).join(' · '))}` : ''}</footer>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('Permita janelas pop-up para abrir o relatório.'); return; }
  w.document.open(); w.document.write(html); w.document.close();
}
