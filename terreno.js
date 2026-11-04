/* AgroSat — declividade e altitude da fazenda (relevo: Terrain Tiles / AWS, base SRTM ~30 m). */
'use strict';
(function () {
  const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  // classes de relevo (Embrapa, % de declividade)
  const CLASSES = [
    [0, 3, 'Plano', '#1a9850'], [3, 8, 'Suave ondulado', '#91cf60'], [8, 20, 'Ondulado', '#d9ef8b'],
    [20, 45, 'Forte ondulado', '#fee08b'], [45, 75, 'Montanhoso', '#fc8d59'], [75, 1e9, 'Escarpado', '#d73027'],
  ];
  const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const cache = new Map();

  async function carregarDEM(f, z) {
    const n = 2 ** z, b = bboxOf(f.polys);
    const tx = lon => (lon + 180) / 360 * n;
    const ty = lat => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n; };
    // pixels globais (256 por bloco) com 2 px de margem
    const px0 = Math.floor(tx(b[0]) * 256) - 2, px1 = Math.ceil(tx(b[2]) * 256) + 2;
    const py0 = Math.floor(ty(b[3]) * 256) - 2, py1 = Math.ceil(ty(b[1]) * 256) + 2;
    const W = px1 - px0, H = py1 - py0;
    if (W * H > 4e6) throw new Error('área grande demais para o cálculo de declividade');
    const elev = new Float32Array(W * H).fill(NaN);
    const blocos = [];
    for (let x = Math.floor(px0 / 256); x <= Math.floor((px1 - 1) / 256); x++) for (let y = Math.floor(py0 / 256); y <= Math.floor((py1 - 1) / 256); y++) blocos.push([x, y]);
    await Promise.all(blocos.map(async ([x, y]) => {
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.src = DEM.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      await img.decode();
      const cv = document.createElement('canvas'); cv.width = cv.height = 256;
      const c = cv.getContext('2d', { willReadFrequently: true }); c.drawImage(img, 0, 0);
      const d = c.getImageData(0, 0, 256, 256).data;
      for (let j = 0; j < 256; j++) {
        const gy = y * 256 + j - py0; if (gy < 0 || gy >= H) continue;
        for (let i = 0; i < 256; i++) {
          const gx = x * 256 + i - px0; if (gx < 0 || gx >= W) continue;
          const k = (j * 256 + i) * 4; elev[gy * W + gx] = d[k] * 256 + d[k + 1] + d[k + 2] / 256 - 32768;
        }
      }
    }));
    const lonOf = gx => (px0 + gx + 0.5) / 256 / n * 360 - 180;
    const latOf = gy => Math.atan(Math.sinh(Math.PI * (1 - 2 * (py0 + gy + 0.5) / 256 / n))) * 180 / Math.PI;
    const bounds = [[Math.atan(Math.sinh(Math.PI * (1 - 2 * py1 / 256 / n))) * 180 / Math.PI, px0 / 256 / n * 360 - 180], [Math.atan(Math.sinh(Math.PI * (1 - 2 * py0 / 256 / n))) * 180 / Math.PI, px1 / 256 / n * 360 - 180]];
    return { W, H, elev, lonOf, latOf, bounds, z };
  }

  async function calcular() {
    const f = farm(); if (!f) return;
    if (cache.has(f.id)) return cache.get(f.id);
    const z = 14, D = await carregarDEM(f, z), { W, H, elev } = D;
    const lat0 = (bboxOf(f.polys)[1] + bboxOf(f.polys)[3]) / 2;
    const pxM = 156543.03392 * Math.cos(lat0 * Math.PI / 180) / 2 ** z;   // tamanho do pixel no terreno (m)
    const slope = new Float32Array(W * H).fill(NaN), mask = new Uint8Array(W * H), div = new Uint8Array(W * H);
    const dentro = (lon, lat, polys) => polys.some(p => pip(lon, lat, p[0]) && !p.slice(1).some(h => pip(lon, lat, h)));
    for (let j = 1; j < H - 1; j++) {
      const lat = D.latOf(j);
      for (let i = 1; i < W - 1; i++) {
        const lon = D.lonOf(i);
        if (!dentro(lon, lat, f.polys)) continue;
        const k = j * W + i; mask[k] = 1;
        if (f.divs) for (let q = 0; q < f.divs.length; q++) if (dentro(lon, lat, [f.divs[q].rings])) { div[k] = q + 1; break; }
        const e = (di, dj) => elev[(j + dj) * W + i + di];
        // Horn (3x3)
        const dzdx = ((e(1, -1) + 2 * e(1, 0) + e(1, 1)) - (e(-1, -1) + 2 * e(-1, 0) + e(-1, 1))) / (8 * pxM);
        const dzdy = ((e(-1, 1) + 2 * e(0, 1) + e(1, 1)) - (e(-1, -1) + 2 * e(0, -1) + e(1, -1))) / (8 * pxM);
        slope[k] = Math.hypot(dzdx, dzdy) * 100;
      }
    }
    const R = { ...D, slope, mask, div, pxHa: pxM * pxM / 1e4 };
    cache.set(f.id, R); return R;
  }
  function classe(v) { return CLASSES.find(c => v >= c[0] && v < c[1]); }

  async function verDeclividade() {
    const f = farm(); if (!f) return;
    $('tdBtn').disabled = true; busy(true, 'Calculando declividade…');
    try {
      const R = await calcular(), { W, H, slope, mask, elev } = R;
      const cont = CLASSES.map(() => 0), alts = [], sl = [];
      const nd = f.divs ? f.divs.length : 0, porDiv = Array.from({ length: nd }, () => ({ s: 0, n: 0, forte: 0 }));
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d'), img = ctx.createImageData(W, H), d = img.data;
      for (let k = 0; k < W * H; k++) {
        if (!mask[k] || Number.isNaN(slope[k])) continue;
        const v = slope[k], ci = CLASSES.findIndex(c => v >= c[0] && v < c[1]);
        cont[ci]++; sl.push(v); alts.push(elev[k]);
        if (R.div[k]) { const p = porDiv[R.div[k] - 1]; p.s += v; p.n++; if (v >= 20) p.forte++; }
        const c = hex(CLASSES[ci][3]), o = k * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      const tot = sl.length; if (!tot) throw new Error('sem dados de relevo');
      sl.sort((a, b) => a - b); alts.sort((a, b) => a - b);
      const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
      const media = sl.reduce((s, v) => s + v, 0) / tot, app = sl.filter(v => v >= 100).length * R.pxHa;
      const itens = CLASSES.map((c, i) => ({ nome: c[1] > 999 ? `${c[2]} (acima de ${c[0]}%)` : `${c[2]} (${c[0]}–${c[1]}%)`, cor: c[3], pct: cont[i] / tot * 100 }));
      // amplia com suavização (relevo ~30 m)
      const big = document.createElement('canvas'); big.width = W * 4; big.height = H * 4;
      const bx = big.getContext('2d'); bx.imageSmoothingEnabled = true; bx.drawImage(cv, 0, 0, big.width, big.height);
      mostrarCamadaExtra(big.toDataURL('image/png'), R.bounds, { titulo: 'Declividade do terreno (%)', itens: itens.filter(i => i.pct >= 0.5).map(i => ({ cor: i.cor, nome: i.nome, valor: fmt(i.pct, 0) + '%' })) });
      S.terreno = { media, p90: q(sl, .9), max: q(sl, .99), altMin: q(alts, .01), altMax: q(alts, .99), altMed: alts.reduce((s, v) => s + v, 0) / alts.length, itens, app };
      $('tdRes').hidden = false;
      $('tdRes').innerHTML = `<h4>${esc(f.name)} · relevo</h4>
        <div class="kpis">
          <div class="kpi"><b>${fmt(media, 1)}%</b><span>declividade média</span></div>
          <div class="kpi"><b>${fmt(q(sl, .9), 1)}%</b><span>10% mais íngremes acima de</span></div>
          <div class="kpi"><b>${fmt(q(alts, .99) - q(alts, .01), 0)} m</b><span>desnível</span></div>
          <div class="kpi"><b>${fmt(q(alts, .01), 0)} m</b><span>altitude mínima</span></div>
          <div class="kpi"><b>${fmt(q(alts, .99), 0)} m</b><span>altitude máxima</span></div>
          <div class="kpi"><b>${fmt(app, 1)} ha</b><span>acima de 45° (APP)</span></div>
        </div>
        ${barrasHTML(itens)}
        ${nd ? '<h4 style="margin-top:12px">Por divisão</h4>' + tabelaHTML(['Divisão', 'Declividade média', 'Acima de 20%'], f.divs.map((dv, k) => { const p = porDiv[k]; return [esc(dv.nome), p.n ? fmt(p.s / p.n, 1) + '%' : '—', p.n ? fmt(p.forte / p.n * 100, 0) + '%' : '—']; })) : ''}
        <p class="hint">Mecanização: até ~12% sem restrição, até 20% com cuidado; acima de 45° (100%) é APP de encosta pelo Código Florestal. Relevo de base SRTM (~30 m): bom para visão geral, não substitui levantamento topográfico.</p>`;
    } catch (e) { console.error(e); $('tdRes').hidden = false; $('tdRes').innerHTML = `<p class="hint">Não consegui calcular a declividade: ${esc(e.message)}</p>`; }
    finally { $('tdBtn').disabled = false; busy(false); }
  }
  window.TD = { calcular, CLASSES, classe };
  $('tdBtn').onclick = verDeclividade;
  const _ofc = window.onFarmChange;
  window.onFarmChange = f => { _ofc && _ofc(f); S.terreno = null; $('tdRes').hidden = true; $('tdRes').innerHTML = ''; };
})();
