/* AgroSat — classificação da cobertura do solo pela série de 12 meses do Sentinel-2 (10 m).
   Separa mata, pasto formado, pasto degradado, juquira/pasto sujo, juquira em avanço (era pasto há 3 anos),
   solo exposto e água pelo comportamento do NDVI entre as águas e a seca. Triagem para orientar vistoria. */
'use strict';

const COB = [
  [1, 'Vegetação nativa (mata)', '#1f7a3a'],
  [2, 'Juquira / pasto sujo', '#9cc65a'],
  [3, 'Juquira em avanço (era pasto)', '#f08c2e'],
  [4, 'Pastagem formada', '#f3e27a'],
  [5, 'Pastagem degradada', '#c99a6b'],
  [6, 'Solo exposto', '#d63b3b'],
  [7, 'Água', '#2f6fb3'],
  [8, 'Sem imagens suficientes', '#b9b9b9'],
];
// limites de NDVI (Sentinel-2 L2A); p10 ≈ seca, p90 ≈ pico das águas
const LIM = { agua: 0.05, solo: 0.30, mataP10: 0.60, mataP50: 0.72, sujoP10: 0.42, pastoP90: 0.62, eraPastoP90: 0.50 };

async function serieNDVI(f, ini, fim, porMes, maxCenas, aviso, rotulo) {
  const cenas = await stacSearch(f.polys, isoDay(ini), isoDay(fim), 80, 300, 's2');   // nuvem por pixel é tirada depois (máscara SCL)
  const mes = {};
  cenas.forEach(it => { const m = it.properties.datetime.slice(0, 7); (mes[m] = mes[m] || []).push(it); });
  let esc = [];
  Object.values(mes).forEach(l => esc.push(...l.sort((a, b) => (a.properties['eo:cloud_cover'] || 0) - (b.properties['eo:cloud_cover'] || 0)).slice(0, porMes)));
  esc = esc.sort((a, b) => a.properties.datetime.localeCompare(b.properties.datetime)).slice(-maxCenas);
  if (!esc.length) throw new Error('nenhuma imagem do Sentinel-2 no período');
  let g = null, feitas = 0; const camadas = [], datas = [];
  await pool(esc, 2, async it => {
    try {
      const r = await processScene(it, 10, false);
      feitas++; aviso && aviso(`${rotulo}: ${feitas} de ${esc.length} imagens`);
      if (!g) g = r.g;
      if (r.g !== g) return;                     // outra projeção (fazenda na divisa de zonas): ignora
      if (r.nIn && r.nCloud / r.nIn > 0.85) return;
      camadas.push(r.ndvi); datas.push(it.properties.datetime.slice(0, 10));
    } catch (e) { feitas++; console.warn('cena', it.id, e.message); }
  });
  if (!camadas.length) throw new Error('as imagens do período vieram todas cobertas de nuvem');
  return { g, camadas, datas: datas.sort() };
}

function percentis(camadas, N, mask) {
  const p10 = new Float32Array(N).fill(NaN), p50 = new Float32Array(N).fill(NaN), p90 = new Float32Array(N).fill(NaN), n = new Uint8Array(N);
  const v = [];
  for (let k = 0; k < N; k++) {
    if (!mask[k]) continue;
    v.length = 0;
    for (const c of camadas) { const x = c[k]; if (!Number.isNaN(x)) v.push(x); }
    n[k] = Math.min(255, v.length); if (!v.length) continue;
    v.sort((a, b) => a - b);
    const q = p => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))];
    p10[k] = q(0.1); p50[k] = q(0.5); p90[k] = q(0.9);
  }
  return { p10, p50, p90, n };
}

async function classificarCobertura(f, aviso) {
  const hoje = new Date(), ini = new Date(hoje - 365 * 864e5);
  const atual = await serieNDVI(f, ini, hoje, 3, 30, aviso, 'Último ano');
  const g = atual.g, N = g.W * g.H, P = percentis(atual.camadas, N, g.mask);
  // mesmo período 3 anos antes, para achar pasto que virou juquira
  let A = null, anoAntigo = null, nAntigas = 0;
  try {
    const i0 = new Date(hoje - 4 * 365 * 864e5), f0 = new Date(hoje - 3 * 365 * 864e5);
    const ant = await serieNDVI(f, i0, f0, 1, 12, aviso, 'Três anos atrás');
    if (ant.g === g && ant.camadas.length >= 4) { A = percentis(ant.camadas, N, g.mask); anoAntigo = ant.datas[ant.datas.length - 1].slice(0, 4); nAntigas = ant.camadas.length; }
  } catch (e) { console.warn('série antiga', e.message); }
  aviso && aviso('Classificando a cobertura…');
  let cls = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    if (!g.mask[k]) continue;
    if (P.n[k] < 4) { cls[k] = 8; continue; }
    const a = P.p10[k], m = P.p50[k], b = P.p90[k];
    let c;
    if (m < LIM.agua) c = 7;
    else if (b < LIM.solo) c = 6;
    else if (a >= LIM.mataP10 && m >= LIM.mataP50) c = 1;
    else if (a >= LIM.sujoP10) c = 2;
    else if (b >= LIM.pastoP90) c = 4;
    else c = 5;
    if (c === 2 && A && A.n[k] >= 3 && A.p10[k] < LIM.sujoP10 && A.p90[k] >= LIM.eraPastoP90) c = 3;
    cls[k] = c;
  }
  cls = maioria(cls, g);
  const pxHa = g.res * g.res / 1e4, cont = new Array(9).fill(0), nd = (f.divs || []).length;
  const porDiv = Array.from({ length: nd }, () => new Array(9).fill(0));
  for (let k = 0; k < N; k++) { if (!cls[k]) continue; cont[cls[k]]++; if (g.div && g.div[k]) porDiv[g.div[k] - 1][cls[k]]++; }
  const tot = cont.reduce((s, v) => s + v, 0) || 1;
  const classes = COB.map(([k, nome, cor]) => ({ k, nome, cor, ha: cont[k] * pxHa, pct: cont[k] / tot * 100 }));
  const divs = (f.divs || []).map((d, i) => { const t = porDiv[i].reduce((s, v) => s + v, 0) || 1; return { nome: d.nome || d.name || `Divisão ${i + 1}`, ha: t * pxHa, pct: COB.map(([k]) => porDiv[i][k] / t * 100) }; });
  const out = { g, cls, classes, divs, datas: atual.datas, nCenas: atual.camadas.length, anoAntigo, nAntigas, data: new Date().toISOString() };
  S.cobertura = out;
  return out;
}

// filtro de maioria 3x3: tira o "salpicado" de pixels isolados
function maioria(cls, g) {
  const out = new Uint8Array(cls.length), W = g.W, H = g.H, c = new Uint8Array(9);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i; if (!cls[k]) continue;
    c.fill(0);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const x = i + di, y = j + dj; if (x < 0 || y < 0 || x >= W || y >= H) continue; const v = cls[y * W + x]; if (v) c[v]++; }
    let best = cls[k], bn = c[best]; for (let v = 1; v < 9; v++) if (c[v] > bn) { best = v; bn = c[v]; }
    out[k] = bn >= 5 ? best : cls[k];
  }
  return out;
}

function desenharCobertura(m) {
  const { g, cls } = m, cv = document.createElement('canvas'); cv.width = g.W; cv.height = g.H;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(g.W, g.H), d = img.data;
  const hx = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const C = {}; COB.forEach(([k, , cor]) => C[k] = hx(cor));
  for (let i = 0; i < cls.length; i++) { if (!cls[i]) continue; const c = C[cls[i]], o = i * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 235; }
  ctx.putImageData(img, 0, 0); return cv.toDataURL('image/png');
}

const NOTA_COBERTURA = 'Classificação automática pelo NDVI do Sentinel-2 (10 m) ao longo de 12 meses: mata fica verde o ano todo; pasto formado é forte nas águas e seca no verão; pasto degradado é fraco até nas águas; juquira (arbusto, rebrota, babaçu/pindova) segue mais verde que o pasto na seca. "Juquira em avanço" era pasto no mesmo período de 3 anos atrás. Juquira muito nova ou rala se confunde com pasto, mata secundária alta com mata nativa e babaçu adensado com juquira. É uma triagem para orientar a vistoria; confirme em campo.';

(function () {
  const btn = $('cobBtn'); if (!btn) return;
  const _ofc = window.onFarmChange;
  window.onFarmChange = f => { _ofc && _ofc(f); S.cobertura = null; $('cobRes').hidden = true; $('cobRes').innerHTML = ''; };
  btn.onclick = async () => {
    const f = farm(); if (!f) return;
    btn.disabled = true;
    try {
      const m = await classificarCobertura(f, t => busy(true, t));
      busy(false);
      const vis = m.classes.filter(c => c.pct >= 0.3);
      mostrarCamadaExtra(desenharCobertura(m), m.g.bounds, { titulo: 'Cobertura do solo · Sentinel-2 12 meses', itens: vis.map(c => ({ cor: c.cor, nome: c.nome, valor: fmt(c.pct, 0) + '%' })) });
      const r = $('cobRes'); r.hidden = false;
      r.innerHTML = `<h4>${esc(f.name)} · cobertura nos últimos 12 meses</h4>
        ${barrasHTML(vis)}
        ${tabelaHTML(['Classe', 'ha', '%'], vis.map(c => [`<i style="display:inline-block;width:10px;height:10px;background:${c.cor};border-radius:2px"></i> ${c.nome}`, fmt(c.ha, c.ha < 10 ? 2 : 1), fmt(c.pct, 1)]))}
        ${m.divs.length ? `<h4>Por divisão</h4>${tabelaHTML(['Divisão', 'ha', ...COB.filter(([k]) => vis.some(v => v.k === k)).map(([, n]) => n.split(' (')[0])], m.divs.map(d => [esc(d.nome), fmt(d.ha, 1), ...COB.filter(([k]) => vis.some(v => v.k === k)).map(([k]) => fmt(d.pct[COB.findIndex(c => c[0] === k)], 0) + '%')]))}` : ''}
        <p class="hint">Meses com imagem aproveitável: ${[...new Set(m.datas.map(d => d.slice(5, 7)))].sort().map(x => MESES[+x - 1]).join(', ')}.${[...new Set(m.datas.map(d => d.slice(5, 7)))].length < 6 ? ' <b>Poucos meses com imagem limpa: a separação entre pasto e juquira fica menos segura.</b>' : ''}</p>
        <p class="hint">${m.nCenas} imagens de ${dBR(m.datas[0])} a ${dBR(m.datas[m.datas.length - 1])}${m.anoAntigo ? `; comparação com ${m.nAntigas} imagens de ${m.anoAntigo}` : '; sem imagens antigas para comparar'}.</p>
        <p class="hint">${NOTA_COBERTURA}</p>`;
    } catch (e) { busy(false); toast('Não consegui classificar: ' + e.message, 6000); }
    finally { btn.disabled = false; }
  };
})();
