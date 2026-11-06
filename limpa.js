/* AgroSat — "Imagem limpa": junta as imagens Sentinel-2 dos últimos 60 dias e, em cada pixel,
   usa só as passagens sem nuvem e sem sombra, ficando com o valor do meio (mediana).
   Some com nuvem e sombra que aparecem em uma data só. */
'use strict';

async function compostoLimpo(f, dias = 60, maxCenas = 8, aviso) {
  const hoje = new Date(), ini = new Date(hoje - dias * 864e5);
  const cenas = (await stacSearch(f.polys, isoDay(ini), isoDay(hoje), 80, 100, 's2'))
    .sort((a, b) => b.properties.datetime.localeCompare(a.properties.datetime)).slice(0, maxCenas);
  if (!cenas.length) throw new Error(`nenhuma imagem do Sentinel-2 nos últimos ${dias} dias`);
  let feitas = 0, g = null; const rs = [];
  await pool(cenas, 3, async it => {
    try {
      const r = await processScene(it, null, true);
      aviso && aviso(`Imagem limpa: ${++feitas} de ${cenas.length} imagens`);
      if (!g) g = r.g;
      if (r.g === g && r.nIn && r.nCloud / r.nIn < 0.95) rs.push(r);
    } catch (e) { feitas++; console.warn('composto', it.id, e.message); }
  });
  if (!rs.length) throw new Error('todas as imagens do período estão cobertas de nuvem');
  rs.sort((a, b) => b.it.properties.datetime.localeCompare(a.it.properties.datetime));
  const N = g.W * g.H, ndvi = new Float32Array(N).fill(NaN), ndre = new Float32Array(N).fill(NaN), cloud = new Uint8Array(N);
  const comRGB = rs.filter(r => r.rgb && r.rgb.tci);
  const rgb = comRGB.length ? { tci: true, data: [new Uint8Array(N), new Uint8Array(N), new Uint8Array(N)] } : null;
  let nCloud = 0; const usadas = new Set(), cand = [];
  for (let i = 0; i < N; i++) {
    cand.length = 0;
    for (const r of rs) if (!r.cloud[i] && !Number.isNaN(r.ndvi[i])) cand.push(r);
    if (!cand.length) {
      if (g.mask[i]) { cloud[i] = 1; nCloud++; }
      // fora da fazenda (ou sem passagem limpa): mostra a cor da imagem mais recente que tiver
      if (rgb) { const r = comRGB.find(x => x.rgb.data[0][i] + x.rgb.data[1][i] + x.rgb.data[2][i] > 0); if (r) for (let c = 0; c < 3; c++) rgb.data[c][i] = r.rgb.data[c][i]; }
      continue;
    }
    cand.sort((a, b) => a.ndvi[i] - b.ndvi[i]);
    const m = cand[Math.floor((cand.length - 1) / 2)];          // a passagem com o NDVI do meio
    ndvi[i] = m.ndvi[i]; ndre[i] = m.ndre[i]; if (g.mask[i]) usadas.add(m);
    if (rgb) {
      const src = m.rgb && m.rgb.tci ? m : cand.find(x => x.rgb && x.rgb.tci);
      if (src) for (let c = 0; c < 3; c++) rgb.data[c][i] = src.rgb.data[c][i];
    }
  }
  const datas = rs.map(r => r.it.properties.datetime.slice(0, 10)).sort();
  const it = { ...rs[0].it, properties: { ...rs[0].it.properties } };
  return {
    it, g, ndvi, ndre, cloud, rgb, nIn: g.nIn, nCloud, stats: statsOf(ndvi, g.mask), statsRE: statsOf(ndre, g.mask), divStats: calcDivStats(f, g, ndvi, ndre, cloud),
    composto: { n: rs.length, usadas: usadas.size, de: datas[0], ate: datas[datas.length - 1] },
  };
}

(function () {
  const btn = $('btnLimpa'); if (!btn) return;
  btn.onclick = async () => {
    const f = farm(); if (!f) return;
    btn.disabled = true;
    try {
      const r = await compostoLimpo(f, 60, 8, t => busy(true, t));
      S.result = r; S.scene = null; renderScenes();
      if (S.layer === 'diff') S.layer = 'ndvi';
      showLayer(); renderStats(r);
      const sobra = r.nIn ? r.nCloud / r.nIn : 0;
      toast(`Imagem limpa: ${r.composto.n} passagens de ${dBR(r.composto.de)} a ${dBR(r.composto.ate)}${sobra > 0.02 ? `; ${fmt(sobra * 100, 0)}% da área sem nenhuma passagem limpa` : ''}.`, 6000);
    } catch (e) { toast('Não consegui montar a imagem limpa: ' + e.message, 6000); }
    finally { busy(false); btn.disabled = false; }
  };
})();
