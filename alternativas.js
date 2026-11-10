/* AgroSat — bases reais substitutas quando o MapBiomas está fora do ar (downloads suspensos/403):
   • Uso do solo: Esri / Impact Observatory 10 m anual (Sentinel-2), via Microsoft Planetary Computer, 2017 em diante.
   • Áreas queimadas: MODIS MCD64A1 (NASA, 500 m, mensal), via Microsoft Planetary Computer. */
'use strict';
(function () {
  const PC = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';
  const IO_COL = 'io-lulc-annual-v02', MODIS_COL = 'modis-64A1-061';
  // classes Esri/IO -> códigos MapBiomas (para usar a mesma legenda e os mesmos cálculos)
  const IO_PARA_MB = { 1: 33, 2: 3, 4: 11, 5: 18, 7: 24, 8: 25, 9: 27, 10: 27, 11: 15 };
  const CIT_IO = 'Esri / Impact Observatory 10 m (Sentinel-2)';

  async function pcBuscar(col, bbox, datetime, limit = 200) {
    const out = []; let body = { collections: [col], bbox, datetime, limit: 100 }, url = PC, guard = 0;
    while (url && out.length < limit && guard++ < 10) {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`Planetary Computer respondeu ${r.status}`);
      const j = await r.json(); out.push(...(j.features || []));
      const nx = (j.links || []).find(l => l.rel === 'next');
      if (nx && nx.body) { body = Object.assign(body, nx.body); url = nx.href; } else url = null;
    }
    return out;
  }
  const contem = (it, lon, lat) => !it.bbox || (it.bbox[0] <= lon && it.bbox[2] >= lon && it.bbox[1] <= lat && it.bbox[3] >= lat);

  // ---------- Uso do solo (Esri/IO 10 m) ----------
  const cacheIO = new Map();
  async function lulcAlternativo(colK, ano) {
    const f = farm(), b = bboxOf(f.polys), cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    // 1º TerraClass (oficial, INPE/Embrapa, desde 2008); 2º Esri/IO 10 m (global, 2017 em diante)
    let erroTC = null;
    if (window.TERRACLASS) {
      try { return await window.TERRACLASS(ano); }
      catch (e) { erroTC = e; console.warn('TerraClass', e.message); }
    }
    if (ano < 2017) throw new Error('MapBiomas fora do ar (downloads suspensos) e ' + (erroTC ? erroTC.message : 'não há outra base de uso do solo antes de 2017'));
    const k = `${f.id}|${ano}`; if (cacheIO.has(k)) return cacheIO.get(k);
    let cands = [], a;
    for (a = Math.min(ano, new Date().getFullYear()); a >= 2017 && !cands.length; a--) {
      const fs = await pcBuscar(IO_COL, b, `${a}-01-01T00:00:00Z/${a}-12-31T23:59:59Z`, 20);
      cands = [...fs.filter(x => contem(x, cx, cy)), ...fs.filter(x => !contem(x, cx, cy))];
    }
    if (!cands.length) throw new Error('nenhum mapa de uso do solo disponível para esta área');
    let erro = null;
    for (const it of cands.slice(0, 4)) {
      try { const out = await lerItemIO(it, f, b, cx, cy); cacheIO.set(k, out); return out; }
      catch (e) { erro = e; console.warn('uso do solo substituto', it.id, e.message); }
    }
    throw erro;
  }
  async function lerItemIO(it, f, b, cx, cy) {
    const anoReal = +String(it.properties.start_datetime || it.properties.datetime || '').slice(0, 4);
    const href = await assinarHref({ assinar: IO_COL }, it.assets.data.href);
    // projeção lida do próprio arquivo (o catálogo não informa)
    const tiff = await openTiff(href), img = await tiff.getImage(), gk = img.getGeoKeys() || {};
    let epsg = gk.ProjectedCSTypeGeoKey || gk.GeographicTypeGeoKey || it.properties['proj:epsg'] || utmEPSG(cx, cy);
    if (epsg === 32767) epsg = it.properties['proj:epsg'] || utmEPSG(cx, cy);
    const geo = epsg === 4326 || epsg === 4674, fwd = geo ? (c => c) : toUTM(epsg);
    const [rx] = img.getResolution(), passo = Math.abs(rx) || (geo ? 10 / 111320 : 10);
    const g = grid(f.polys, 4326, 10 / 111320);
    const cs = [[g.bbox[0], g.bbox[1]], [g.bbox[0], g.bbox[3]], [g.bbox[2], g.bbox[1]], [g.bbox[2], g.bbox[3]]].map(fwd);
    const m = passo * 2;
    const ib = img.getBoundingBox();
    const ub = [Math.max(ib[0], Math.min(...cs.map(c => c[0])) - m), Math.max(ib[1], Math.min(...cs.map(c => c[1])) - m), Math.min(ib[2], Math.max(...cs.map(c => c[0])) + m), Math.min(ib[3], Math.max(...cs.map(c => c[1])) + m)];
    if (ub[0] >= ub[2] || ub[1] >= ub[3]) throw new Error(`o mapa de uso do solo encontrado (${it.id}) não cobre esta área`);
    const W2 = Math.max(1, Math.round((ub[2] - ub[0]) / passo)), H2 = Math.max(1, Math.round((ub[3] - ub[1]) / passo));
    const r = await lerRasters(href, { bbox: ub, width: W2, height: H2, resampleMethod: 'nearest', fillValue: 0, samples: [0] });
    const v = r[0], cod = new Uint8Array(g.W * g.H);
    const sx = (ub[2] - ub[0]) / W2, sy = (ub[3] - ub[1]) / H2;
    let n = 0;
    for (let j = 0; j < g.H; j++) for (let i = 0; i < g.W; i++) {
      const kk = j * g.W + i; if (!g.mask[kk]) continue;
      const [x, y] = fwd([g.bbox[0] + (i + 0.5) * g.res, g.bbox[3] - (j + 0.5) * g.res]);
      const ii = Math.floor((x - ub[0]) / sx), jj = Math.floor((ub[3] - y) / sy);
      if (ii < 0 || jj < 0 || ii >= W2 || jj >= H2) continue;
      cod[kk] = IO_PARA_MB[v[jj * W2 + ii]] || 0; if (cod[kk]) n++;
    }
    if (!n) throw new Error(`o mapa de uso do solo substituto (${it.id}, EPSG ${epsg}) veio sem dados nesta área`);
    return { g, cod, ano: anoReal, colK: 'alt', alt: true, fonte: 'io', c: { nome: '10 m', res: 10, cit: CIT_IO, anos: [2017, anoReal] }, nota: `Fonte substituta: ${CIT_IO}, ano ${anoReal}. Nela, "Pastagem" é a classe campo/pasto (rangeland), que também inclui campos naturais, e "Formação florestal" é árvores.` };
  }

  // ---------- Áreas queimadas (MODIS MCD64A1, 500 m) ----------
  const R_SIN = 6371007.181;
  const sinu = (lon, lat) => [R_SIN * lon * Math.PI / 180 * Math.cos(lat * Math.PI / 180), R_SIN * lat * Math.PI / 180];
  async function queimadasModis(f) {
    const g = grid(f.polys, 4326, 50 / 111320);
    const lat0 = (g.bbox[1] + g.bbox[3]) / 2, pxHa = Math.pow(g.res * 111320, 2) * Math.cos(lat0 * Math.PI / 180) / 1e4;
    const b = bboxOf(f.polys), ano1 = new Date().getFullYear(), ano0 = ano1 - 4;
    const itens = (await pcBuscar(MODIS_COL, b, `${ano0}-01-01T00:00:00Z/${ano1}-12-31T23:59:59Z`, 300)).filter(it => it.assets && it.assets.Burn_Date);
    if (!itens.length) throw new Error('nenhum mapa de área queimada (MODIS) para esta área');
    // centro de cada célula da grade (50 m) em coordenadas senoidais
    const cel = []; for (let j = 0; j < g.H; j++) for (let i = 0; i < g.W; i++) { const k = j * g.W + i; if (g.mask[k]) cel.push([k, ...sinu(g.bbox[0] + (i + 0.5) * g.res, g.bbox[3] - (j + 0.5) * g.res)]); }
    const queimado = new Uint16Array(g.W * g.H), porAnoMes = {};
    const falhas = [];
    await pool(itens, 6, async it => {
      try {
        const t = await openTiff(await assinarHref({ assinar: MODIS_COL }, it.assets.Burn_Date.href)), img = await t.getImage();
        const [ox, oy] = img.getOrigin(), [rx, ry] = img.getResolution(), Wt = img.getWidth(), Ht = img.getHeight();
        const pos = cel.map(([k, x, y]) => [k, Math.floor((x - ox) / rx), Math.floor((y - oy) / ry)]).filter(p => p[1] >= 0 && p[2] >= 0 && p[1] < Wt && p[2] < Ht);
        if (!pos.length) return;
        const c0 = Math.min(...pos.map(p => p[1])), c1 = Math.max(...pos.map(p => p[1])) + 1, r0 = Math.min(...pos.map(p => p[2])), r1 = Math.max(...pos.map(p => p[2])) + 1;
        const [v] = await img.readRasters({ window: [c0, r0, c1, r1], samples: [0] }), w = c1 - c0;
        const dt = String(it.properties.start_datetime || it.properties.datetime), ano = +dt.slice(0, 4), mes = +dt.slice(5, 7);
        let n = 0;
        for (const [k, c, r] of pos) { const d = v[(r - r0) * w + (c - c0)]; if (d > 0 && d <= 366) { n++; if (ano > queimado[k]) queimado[k] = ano; } }
        if (n) { const key = ano + '-' + mes; porAnoMes[key] = (porAnoMes[key] || 0) + n * pxHa; }
      } catch (e) { falhas.push(String(it.properties.start_datetime || it.id).slice(0, 7)); }
    });
    const anos = [];
    for (let a = ano0; a <= ano1; a++) {
      const meses = Object.entries(porAnoMes).filter(([k]) => +k.split('-')[0] === a).map(([k, h]) => ({ mes: +k.split('-')[1], ha: h })).sort((x, y) => x.mes - y.mes);
      anos.push({ ano: a, ha: meses.reduce((s, m) => s + m.ha, 0), meses });
    }
    let unico = 0; for (let i = 0; i < queimado.length; i++) if (queimado[i]) unico++;
    return { g, anos, falhas: [...new Set(falhas)], queimado, unicoHa: unico * pxHa, somaHa: anos.reduce((s, a) => s + a.ha, 0), fonte: 'MODIS MCD64A1 (NASA, 500 m)', grosso: true };
  }

  window.LULC_ALT = lulcAlternativo;
  window.QUEIMADAS_ALT = queimadasModis;
  window.CIT_IO = CIT_IO;
})();
