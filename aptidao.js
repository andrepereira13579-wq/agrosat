/* AgroSat — geração distribuída (ANEEL) e aptidão agrícola das terras (Embrapa/IBGE, 1:500.000).
   • Geração distribuída: base da ANEEL recortada por estado pelo robô do GitHub (data/gd/<UF>.json).
   • Aptidão agrícola: Mapa de Aptidão Agrícola das Terras do Brasil, 2ª aproximação (Embrapa Solos e IBGE, 2025),
     no GeoInfo da Embrapa (GeoNode/GeoServer). A camada é achada pelo nome; a legenda é decodificada
     pelo Sistema de Avaliação da Aptidão Agrícola das Terras (Ramalho Filho & Beek). */
'use strict';

// ---------------- Geração distribuída ----------------
const cacheGD = {};
async function baseGD(uf) {
  if (cacheGD[uf]) return cacheGD[uf];
  const r = await fetch(`data/gd/${uf}.json`, { cache: 'no-cache' });
  if (r.status === 404) throw new Error(`a base da ANEEL para ${uf} ainda não foi gerada no site (veja a aba Actions do GitHub)`);
  if (!r.ok) throw new Error('não consegui abrir a base da ANEEL (' + r.status + ')');
  return (cacheGD[uf] = await r.json());
}

async function geracaoDistribuida(f, F, raio = 50) {
  const uf = (f.uf || 'MA').toUpperCase();
  const B = await baseGD(uf), L = B.listas, porSub = B.local === 'subestacao';
  const bb = turf.bbox(turf.buffer(F, raio, { units: 'kilometers' }));
  const grupos = new Map(), memo = new Map();
  let n = 0, kw = 0;
  for (const d of B.d) {
    const [lat, lon] = d;
    if (lon < bb[0] || lon > bb[2] || lat < bb[1] || lat > bb[3]) continue;
    const kk = lat + ',' + lon;
    let km = memo.get(kk);
    if (km === undefined) { km = distKmFeicao(F, turf.point([lon, lat])); memo.set(kk, km); }
    if (km > raio) continue;
    n++; kw += d[6] || 0;
    // agrupa pelo ponto (subestação, quando a ANEEL só informa a subestação)
    const g = grupos.get(kk) || { lon, lat, km, sub: L.sub ? L.sub[d[8]] : '', muns: new Map(), classes: new Map(), n: 0, kw: 0 };
    g.n++; g.kw += d[6] || 0;
    const m = L.mun[d[2]]; g.muns.set(m, (g.muns.get(m) || 0) + 1);
    const c = L.classe[d[3]]; g.classes.set(c, (g.classes.get(c) || 0) + 1);
    grupos.set(kk, g);
  }
  const lista = [...grupos.values()].sort((a, b) => a.km - b.km).map(g => ({ ...g, muns: [...g.muns.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]), classes: [...g.classes.entries()].sort((a, b) => b[1] - a[1]) }));
  return { grupos: lista, n, kw, raio, uf, gerado: B.gerado, fonte: B.fonte, porSub };
}

// ---------------- Aptidão agrícola ----------------
const GEOINFO = 'https://geoinfo.dados.embrapa.br';
const MAPA_APTIDAO = 6499;   // "Mapa de aptidão agrícola das terras do Brasil" no catálogo do GeoInfo

async function buscarJSONgeo(url) { const t = await buscarTexto(url); try { return JSON.parse(t); } catch (e) { throw new Error('o GeoInfo da Embrapa respondeu algo inesperado'); } }

let camadaAptidao = null;
async function acharCamadaAptidao() {
  if (camadaAptidao) return camadaAptidao;
  try { const c = JSON.parse(localStorage.getItem('agrosat.aptidao') || 'null'); if (c && Date.now() - c.t < 30 * 864e5) return (camadaAptidao = c.nome); } catch (e) { }
  const nomes = [];
  const juntar = o => {
    (function andar(x) {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) return x.forEach(andar);
      for (const k of ['alternate', 'typename', 'name']) if (typeof x[k] === 'string' && /:/.test(x[k]) && /aptid/i.test(x[k] + ' ' + (x.title || ''))) nomes.push(x[k]);
      Object.values(x).forEach(andar);
    })(o);
  };
  const tentativas = [
    `${GEOINFO}/api/v2/maps/${MAPA_APTIDAO}`,
    `${GEOINFO}/api/v2/maps/${MAPA_APTIDAO}/maplayers`,
    `${GEOINFO}/api/v2/datasets?search=aptid%C3%A3o%20agr%C3%ADcola&page_size=20`,
    `${GEOINFO}/api/v2/resources?search=aptid%C3%A3o%20agr%C3%ADcola&page_size=20`,
  ];
  for (const u of tentativas) {
    try { juntar(await buscarJSONgeo(u)); } catch (e) { console.warn('aptidão', u, e.message); }
    if (nomes.length) break;
  }
  if (!nomes.length) {   // último recurso: lista de camadas do GeoServer
    const caps = await buscarTexto(`${GEOINFO}/geoserver/ows?service=WFS&version=1.1.0&request=GetCapabilities`);
    for (const m of caps.matchAll(/<Name>([^<]*aptid[^<]*)<\/Name>/gi)) nomes.push(m[1]);
  }
  if (!nomes.length) throw new Error('não achei a camada de aptidão agrícola no GeoInfo da Embrapa');
  const pontua = n => (/brasil|br\b/i.test(n) ? 4 : 0) + (/500/.test(n) ? 3 : 0) + (/2025|2a|aprox/i.test(n) ? 2 : 0) - (/legenda|simplif|reclass/i.test(n) ? 3 : 0);
  camadaAptidao = [...new Set(nomes)].sort((a, b) => pontua(b) - pontua(a))[0];
  try { localStorage.setItem('agrosat.aptidao', JSON.stringify({ nome: camadaAptidao, t: Date.now() })); } catch (e) { }
  return camadaAptidao;
}

// "3(bc)" → texto, pelo Sistema de Avaliação da Aptidão Agrícola das Terras
const NIVEL = { a: 'A (baixo nível tecnológico)', b: 'B (médio)', c: 'C (alto)' };
function lerSimbolo(simb) {
  const s = String(simb || '').trim().replace(/\s+/g, '');
  const m = s.match(/^([1-6])(.*)$/);
  if (!m) return null;
  const g = +m[1], resto = m[2];
  if (g === 6 || !resto) return { grupo: g, simbolo: s, texto: g === 6 ? 'Sem aptidão agrícola: terras indicadas para preservação da flora e da fauna.' : 'Grupo ' + g, uso: 'preservação' };
  // letra maiúscula = boa; minúscula = regular; entre parênteses = restrita; ausente = inapta
  const cls = {};
  let dentro = false;
  for (const ch of resto) { if (ch === '(') dentro = true; else if (ch === ')') dentro = false; else if (/[a-z]/i.test(ch)) cls[ch.toLowerCase()] = dentro ? 'RESTRITA' : ch === ch.toUpperCase() ? 'BOA' : 'REGULAR'; }
  const junta = arr => arr.length > 1 ? arr.slice(0, -1).join(', ') + ' e ' + arr[arr.length - 1] : arr[0];
  if (g <= 3) {
    const porClasse = {};
    for (const n of ['a', 'b', 'c']) (porClasse[cls[n] || 'INAPTA'] = porClasse[cls[n] || 'INAPTA'] || []).push(n.toUpperCase());
    const ordem = ['BOA', 'REGULAR', 'RESTRITA', 'INAPTA'].filter(k => porClasse[k]);
    const partes = ordem.map((k, i) => `${i ? (k === 'INAPTA' ? 'e INAPTA' : k) : 'Aptidão ' + k}${i === 0 ? ' para lavouras' : ''} ${porClasse[k].length > 1 ? 'nos níveis de manejo' : 'no nível de manejo'} ${junta(porClasse[k])}`);
    return { grupo: g, simbolo: s, texto: partes.join(', ').replace(', e INAPTA', ', e INAPTA') + '.', uso: 'lavouras' };
  }
  if (g === 4) { const c = cls.p || 'RESTRITA'; return { grupo: g, simbolo: s, texto: `Aptidão ${c} para pastagem plantada; inapta para lavouras.`, uso: 'pastagem plantada' }; }
  const t = [];
  if (cls.s) t.push(`${cls.s} para silvicultura`);
  if (cls.n) t.push(`${cls.n} para pastagem natural`);
  return { grupo: g, simbolo: s, texto: `Aptidão ${t.join(' e ') || 'para silvicultura e/ou pastagem natural'}; inapta para lavouras e pastagem plantada.`, uso: 'silvicultura / pastagem natural' };
}

async function aptidaoAgricola(F) {
  const nome = await acharCamadaAptidao();
  const b = turf.bbox(F);
  const url = `${GEOINFO}/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=${encodeURIComponent(nome)}&outputFormat=application/json&srsName=EPSG:4326&bbox=${b.join(',')}`;
  const fc = await getGeo(url);
  if (!fc.features.length) throw new Error('o mapa da Embrapa não tem classe para esta área (áreas de floresta da Amazônia Legal, terras indígenas e UCs ficaram fora da avaliação)');
  const areaTot = turf.area(F) / 1e4, grupos = new Map();
  for (const ft of fc.features) {
    let inter = null;
    try { inter = turf.intersect(F, ft); } catch (e) { }
    if (!inter) continue;
    const ha = turf.area(inter) / 1e4; if (ha < 0.01) continue;
    const P = ft.properties || {};
    // acha o campo do símbolo (ex.: "3(bc)") e o da legenda
    let simb = null, leg = '';
    for (const [k, v] of Object.entries(P)) {
      if (typeof v !== 'string') continue;
      const s = v.trim();
      if (!simb && /^[1-6]\(?[a-zA-Z]{0,6}\)?[a-zA-Z()]*$/.test(s.replace(/\s/g, '')) && /simb|classe|aptid|cod|leg|sigla/i.test(k)) simb = s;
      if (/legend|descr|nome|aptid/i.test(k) && s.length > leg.length && s.length > 8) leg = s;
    }
    if (!simb) for (const v of Object.values(P)) if (typeof v === 'string' && /^[1-6]\(?[a-zA-Z]{1,6}/.test(v.trim())) { simb = v.trim(); break; }
    const dec = lerSimbolo(simb);
    const chave = simb || leg || 'sem classe';
    const g = grupos.get(chave) || { simbolo: simb || '—', legenda: dec ? dec.texto : leg, legendaOrig: leg, uso: dec ? dec.uso : '', ha: 0, geoms: [] };
    g.ha += ha; g.geoms.push(inter); grupos.set(chave, g);
  }
  const classes = [...grupos.values()].map(g => ({ ...g, pct: g.ha / areaTot * 100 })).sort((a, b) => b.ha - a.ha);
  if (!classes.length) throw new Error('o mapa da Embrapa não cruzou com o limite do imóvel');
  return { camada: nome, classes, haTot: classes.reduce((s, c) => s + c.ha, 0) };
}

window.geracaoDistribuida = geracaoDistribuida;
window.aptidaoAgricola = aptidaoAgricola;
window.lerSimboloAptidao = lerSimbolo;
