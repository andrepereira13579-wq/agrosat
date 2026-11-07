/* AgroSat — Relatório completo da propriedade (no estilo "Farm Scan"):
   roda todas as consultas de uma vez e monta um documento por temas, com sumário de conformidade,
   mapa de cada tema sobre imagem de satélite, tabelas, gráficos e metodologia. */
'use strict';
(function () {
  const TILE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const merc = (lon, lat, z) => { const n = 256 * 2 ** z, r = lat * Math.PI / 180; return [(lon + 180) / 360 * n, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n]; };
  const carregar = src => new Promise(ok => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = () => ok(null); im.src = src; });
  const COR = { ok: '#1a9850', alerta: '#e0a800', grave: '#d73027', erro: '#8a8f8c', info: '#2f6fb3' };
  const ROT = { ok: 'Sem pendências', alerta: 'Atenção', grave: 'Crítico', erro: 'Não consultado', info: 'Informativo' };
  const semTag = s => String(s == null ? '' : s).replace(/<[^>]+>/g, '');
  const n1 = (v, d = 1) => Number.isFinite(v) ? fmt(v, d) : '—';

  // ---------- Mapa estático: satélite + camadas + contorno ----------
  async function mapa(f, o = {}) {
    const W = o.W || 1000, H = o.H || 600;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#dfe6e0'; ctx.fillRect(0, 0, W, H);
    let b = bboxOf(f.polys);
    if (o.raioKm) b = turf.bbox(turf.buffer(farmFeature(f), o.raioKm, { units: 'kilometers' }));
    const pX = (b[2] - b[0]) * 0.08, pY = (b[3] - b[1]) * 0.08;
    b = [b[0] - pX, b[1] - pY, b[2] + pX, b[3] + pY];
    let z = 17;
    for (; z > 3; z--) { const a = merc(b[0], b[3], z), c = merc(b[2], b[1], z); if (c[0] - a[0] <= W && c[1] - a[1] <= H) break; }
    const a = merc(b[0], b[3], z), c = merc(b[2], b[1], z);
    const k = Math.min(W / (c[0] - a[0]), H / (c[1] - a[1])), cx = (a[0] + c[0]) / 2, cy = (a[1] + c[1]) / 2;
    const P = (lon, lat) => { const m = merc(lon, lat, z); return [W / 2 + (m[0] - cx) * k, H / 2 + (m[1] - cy) * k]; };
    const tiles = [];
    for (let x = Math.floor((cx - W / 2 / k) / 256); x <= Math.floor((cx + W / 2 / k) / 256); x++)
      for (let y = Math.floor((cy - H / 2 / k) / 256); y <= Math.floor((cy + H / 2 / k) / 256); y++) tiles.push([x, y]);
    await Promise.all(tiles.map(async ([x, y]) => {
      const im = await carregar(TILE.replace('{z}', z).replace('{x}', x).replace('{y}', y));
      if (im) ctx.drawImage(im, W / 2 + (x * 256 - cx) * k, H / 2 + (y * 256 - cy) * k, 256 * k + 1, 256 * k + 1);
    }));
    if (o.escurecer) { ctx.fillStyle = `rgba(0,0,0,${o.escurecer})`; ctx.fillRect(0, 0, W, H); }
    for (const r of o.rasters || []) {
      const im = await carregar(r.url); if (!im) continue;
      const [[s, w], [n, e]] = r.bounds, p1 = P(w, n), p2 = P(e, s);
      ctx.globalAlpha = r.alpha == null ? 0.9 : r.alpha; ctx.imageSmoothingEnabled = !!r.suave;
      ctx.drawImage(im, p1[0], p1[1], p2[0] - p1[0], p2[1] - p1[1]); ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = true;
    }
    const anel = r => { ctx.beginPath(); r.forEach((pt, i) => { const q = P(pt[0], pt[1]); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath(); };
    const geom = (g, st) => {
      if (!g) return;
      const pol = rings => { ctx.beginPath(); rings.forEach(r => r.forEach((pt, i) => { const q = P(pt[0], pt[1]); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); })); if (st.fill) { ctx.fillStyle = st.fill; ctx.fill('evenodd'); } ctx.strokeStyle = st.cor; ctx.lineWidth = st.larg || 2; ctx.setLineDash(st.tracejado || []); ctx.stroke(); ctx.setLineDash([]); };
      if (g.type === 'Polygon') pol(g.coordinates);
      else if (g.type === 'MultiPolygon') g.coordinates.forEach(pol);
      else if (g.type === 'Point') ponto(g.coordinates[0], g.coordinates[1], st);
      else if (g.type === 'MultiPoint') g.coordinates.forEach(c => ponto(c[0], c[1], st));
      else if (g.type === 'GeometryCollection') g.geometries.forEach(x => geom(x, st));
    };
    const ponto = (lon, lat, st) => {
      const q = P(lon, lat); ctx.beginPath(); ctx.arc(q[0], q[1], st.r || 7, 0, 2 * Math.PI);
      ctx.fillStyle = st.cor; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
    };
    for (const L of o.camadas || []) (L.feats || []).forEach(ft => geom(ft.geometry || ft, L));
    for (const p of o.pontos || []) ponto(p.lon, p.lat, p);
    (f.divs || []).forEach(d => { anel(d.rings[0] || d.rings); ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1.3; ctx.stroke(); });
    f.polys.forEach(p => p.forEach(r => { anel(r); ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 5; ctx.stroke(); anel(r); ctx.strokeStyle = o.contorno || '#ffffff'; ctx.lineWidth = 2.4; ctx.stroke(); }));
    // escala e norte
    const latC = (b[1] + b[3]) / 2, mPorPx = 156543.03392 * Math.cos(latC * Math.PI / 180) / 2 ** z / k;
    const alvo = mPorPx * W * 0.18, pot = 10 ** Math.floor(Math.log10(alvo)), passo = [1, 2, 5, 10].map(x => x * pot).filter(x => x <= alvo).pop() || pot;
    const px = passo / mPorPx, ex = W - px - 26, ey = H - 22;
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(ex - 10, ey - 24, px + 20, 34);
    ctx.fillStyle = '#fff'; ctx.fillRect(ex, ey, px, 4);
    ctx.font = 'bold 13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(passo >= 1000 ? `${passo / 1000} km` : `${passo} m`, ex + px / 2, ey - 8);
    ctx.beginPath(); ctx.moveTo(W - 30, 18); ctx.lineTo(W - 38, 40); ctx.lineTo(W - 22, 40); ctx.closePath(); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.fillText('N', W - 30, 56);
    return cv.toDataURL('image/jpeg', 0.86);
  }

  // ---------- Gráfico (Chart.js) em imagem ----------
  function grafico(cfg, W = 900, H = 300) {
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; cv.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.appendChild(cv);
    cfg.options = Object.assign({ animation: false, responsive: false, devicePixelRatio: 1 }, cfg.options || {});
    cfg.options.plugins = Object.assign({ legend: { labels: { color: '#333', boxWidth: 14 } } }, cfg.options.plugins || {});
    cfg.plugins = [{ id: 'fundo', beforeDraw: c => { const x = c.ctx; x.save(); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.restore(); } }];
    let url = null; try { const ch = new Chart(cv, cfg); url = cv.toDataURL('image/png'); ch.destroy(); } catch (e) { console.warn('gráfico', e); }
    cv.remove(); return url;
  }

  // ---------- Coleta de todas as consultas ----------
  const ETAPAS = [
    ['car', 'CAR (SICAR)'], ['sigef', 'SIGEF / INCRA'], ['emb', 'Embargos IBAMA'], ['prodes', 'PRODES (INPE)'], ['deter', 'Alertas DETER (INPE)'],
    ['prot', 'Áreas protegidas e territórios'], ['fogo', 'Focos de queimada'], ['credito', 'Crédito rural (Sicor)'], ['aq', 'Áreas queimadas (5 anos)'], ['bioma', 'Bioma'],
    ['uso', 'Uso e cobertura do solo'], ['u08', 'Vegetação nativa em 2008'], ['idade', 'Idade da pastagem'], ['cena', 'Imagem de satélite recente'], ['cbers', 'Imagem de 2 m (CBERS-4A)'], ['cob', 'Condição da cobertura (12 meses)'],
    ['relevo', 'Relevo'], ['solo', 'Solo'], ['clima', 'Climatologia'], ['entorno', 'Entorno, água e infraestrutura'],
  ];
  async function coletar(f, aviso) {
    const F = farmFeature(f), fb = turf.bbox(F), viz = turf.bbox(turf.buffer(F, CONF.raioKm, { units: 'kilometers' }));
    const centro = turf.centroid(F).geometry.coordinates, uf = f.uf || 'MA';
    const D = { f, F, centro, uf, R: {}, E: {} };
    const rodar = async (k, fn) => {
      aviso(k, 'wait');
      try { D.R[k] = await fn(); aviso(k, 'ok'); }
      catch (e) { console.warn(k, e); D.E[k] = e.message || String(e); aviso(k, 'erro'); }
    };
    const gov = Promise.all([
      rodar('car', () => carNaArea(fb, uf)), rodar('sigef', () => sigefNaArea(fb, uf)), rodar('emb', () => embargosNaArea(viz)),
      rodar('prodes', () => prodesNaArea(fb)), rodar('deter', () => deterNaArea(fb)), rodar('prot', () => protegidasNaArea(viz)),
      rodar('fogo', () => focosNaArea(viz, CONF.diasFocos)), rodar('credito', () => creditoNaArea(fb)), rodar('bioma', () => biomaNoPonto(centro[0], centro[1])),
      rodar('solo', () => soloNoPonto(centro[0], centro[1])), rodar('clima', () => climatologia(centro[0], centro[1])),
      rodar('entorno', () => consultarEntorno(f, F)),
    ]);
    const mapas = (async () => {
      await rodar('uso', async () => { try { return await MB.ler('m10', MB.COL.m10.anos[1]); } catch (e) { return await MB.ler('m30', MB.COL.m30.anos[1]); } });
      await rodar('u08', () => MB.ler('m30', 2008));
      await rodar('idade', () => idadePastagem(f));
      await rodar('aq', () => queimadasNaFazenda(f));
      await rodar('cena', () => cenaRecente(f));
      await rodar('cbers', () => cenaCBERS(f));
      await rodar('cob', () => classificarCobertura(f));
      await rodar('relevo', () => TD.calcular());
    })();
    await Promise.all([gov, mapas]);
    return D;
  }

  // ---------- Análises a partir dos dados ----------
  function analisar(D) {
    const { f, F, R } = D, A = {};
    limparDiag(); DL.group = L.layerGroup().addTo(map);
    S.diag = { data: new Date().toISOString(), itens: {} };
    const tit = { car: 'CAR e sobreposições', sigef: 'SIGEF / INCRA', emb: 'Embargos IBAMA', prodes: 'Desmatamento PRODES', prot: 'Áreas protegidas e territórios', fogo: `Focos de queimada (${CONF.diasFocos} dias)`, credito: 'Crédito rural (Sicor / Banco Central)' };
    for (const k of ['car', 'sigef', 'emb', 'prodes', 'prot', 'fogo', 'credito']) {
      if (R[k] === undefined) { A[k] = { nivel: 'erro', resumo: 'Não consegui consultar agora: ' + esc(D.E[k] || ''), detalhes: '' }; continue; }
      try { A[k] = RENDER[k](R[k], F, f); } catch (e) { A[k] = { nivel: 'erro', resumo: 'Erro ao analisar: ' + esc(e.message), detalhes: '' }; }
      S.diag.itens[k] = { titulo: tit[k], ...A[k] };
    }
    // CAR do imóvel
    const areaF = turf.area(F) / 1e4;
    if (R.car) {
      const rows = R.car.map(ft => ({ ft, p: ft.properties, oh: interHa(F, ft) })).filter(r => r.oh > 0.01).sort((a, b) => b.oh - a.oh);
      const pr = (f.car && rows.find(r => pick(r.p, 'cod_imovel') === f.car)) || rows.find(r => r.oh / areaF > 0.8) || null;
      A.carDados = pr && {
        ft: pr.ft, cod: pick(pr.p, 'cod_imovel'), st: pick(pr.p, 'status_imovel'), area: +pick(pr.p, 'area', 'num_area') || turf.area(pr.ft) / 1e4,
        mun: pick(pr.p, 'municipio', 'nom_munici'), uf: pick(pr.p, 'uf', 'cod_estado') || D.uf, tipo: pick(pr.p, 'tipo_imovel'), cond: pick(pr.p, 'condicao', 'des_condic'),
        mf: +pick(pr.p, 'm_fiscal', 'mod_fiscal', 'modulos_fiscais', 'num_modulo_fiscal', 'qtd_modulo_fiscal') || NaN, criado: dataISO(pick(pr.p, 'dat_criacao', 'data_criacao')),
      };
      A.carOutros = rows.filter(r => r !== pr && r.oh > 0.5).map(r => r.ft);
    }
    // DETER
    if (R.deter) {
      const rows = R.deter.map(ft => { const p = ft.properties; return { ft, cls: pick(p, 'classname', 'class_name', 'classe'), data: dataISO(pick(p, 'view_date', 'date', 'data')), sat: [pick(p, 'satellite', 'satelite'), pick(p, 'sensor')].filter(Boolean).join(' / '), fonte: p._fonte, oh: interHa(F, ft) }; })
        .filter(r => r.oh > 0.01).sort((a, b) => String(b.data).localeCompare(String(a.data)));
      const graves = rows.filter(r => deterGrave(r.cls) && r.data >= '2019-07-31');
      const nivel = graves.length ? 'grave' : rows.length ? 'alerta' : 'ok';
      A.deter = { rows, nivel, resumo: rows.length ? `${rows.length} alerta(s) do DETER dentro do imóvel, somando ${ha(rows.reduce((s, r) => s + r.oh, 0))}${graves.length ? `; <b>${graves.length} de desmatamento/mineração a partir de 31/07/2019</b>` : ''}.` : 'Nenhum alerta do DETER dentro do imóvel.' };
    } else A.deter = { rows: [], nivel: 'erro', resumo: 'Não consegui consultar o DETER agora: ' + esc(D.E.deter || '') };
    // Áreas queimadas
    if (R.aq) {
      const q = R.aq, comFogo = q.anos.filter(a => a.ha > 0.01);
      A.aq = { nivel: comFogo.length ? 'alerta' : 'ok', resumo: comFogo.length ? `Fogo em ${comFogo.length} dos ${q.anos.length} anos analisados (${comFogo.map(a => a.ano).join(', ')}); ${ha(q.unicoHa)} da área queimaram ao menos uma vez.` : `Nenhuma cicatriz de fogo dentro do imóvel entre ${q.anos[0].ano} e ${q.anos[q.anos.length - 1].ano}.` };
    } else A.aq = { nivel: 'erro', resumo: 'Não consegui ler o MapBiomas Fogo agora: ' + esc(D.E.aq || '') };
    // Uso do solo
    if (R.uso) {
      const m = R.uso, Rs = MB.resumo(m);
      A.uso = {
        m, ano: m.ano, res: m.c.res, cit: m.c.cit, tot: Rs.tot * Rs.pxHa,
        classes: Object.entries(Rs.porClasse).sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ v: +v, nome: (MB.CL[v] || ['Classe ' + v])[0], cor: (MB.CL[v] || [, '#888'])[1], ha: n * Rs.pxHa, pct: n / Rs.tot * 100 })),
        grupos: Object.entries(Rs.porGrupo).sort((a, b) => b[1] - a[1]).map(([g, n]) => ({ k: g, nome: MB.GRUPO[g][0], cor: MB.GRUPO[g][1], ha: n * Rs.pxHa, pct: n / Rs.tot * 100 })),
      };
      const natHa = (A.uso.grupos.find(g => g.k === 'nat') || { ha: 0 }).ha;
      const flo = A.uso.classes.filter(c => [3, 5, 6, 49].includes(c.v)).reduce((s, c) => s + c.ha, 0), sav = A.uso.classes.filter(c => c.v === 4).reduce((s, c) => s + c.ha, 0);
      A.uso.natHa = natHa; A.uso.nativaDom = flo >= sav && flo > 0 ? 'floresta' : sav > 0 ? 'savana' : 'campo';
    }
    if (R.u08) { const Rs = MB.resumo(R.u08); A.nat08 = (Rs.porGrupo.nat || 0) * Rs.pxHa; }
    // Reserva Legal
    {
      const legal = naAmazoniaLegal(D.centro[0], D.centro[1], (A.carDados && A.carDados.uf) || D.uf);
      const bioma = R.bioma || null, regra = percentualRL(legal, bioma, A.uso && A.uso.nativaDom);
      const area = (A.carDados && A.carDados.area) || f.area, exig = area * regra.pct / 100, mf = A.carDados ? A.carDados.mf : NaN;
      const nat = A.uso ? A.uso.natHa : NaN, saldo = nat - exig;
      let nivel = 'info', resumo;
      if (!A.uso) resumo = `Exigência mínima de ${regra.pct}% (${regra.regra}): ${ha(exig)}. Não consegui medir a vegetação nativa para comparar.`;
      else if (mf <= 4) {
        resumo = `Imóvel com ${fmt(mf, 2)} módulo(s) fiscal(is): pelo art. 67 do Código Florestal, a Reserva Legal pode ser a vegetação nativa existente em 22/07/2008${Number.isFinite(A.nat08) ? ` (≈ ${ha(A.nat08)} pelo MapBiomas)` : ''}, sem obrigação de recompor até ${regra.pct}%.`;
        if (Number.isFinite(A.nat08) && nat < A.nat08 - Math.max(0.5, A.nat08 * 0.05)) { nivel = 'alerta'; resumo += ` <b>A vegetação nativa caiu de ${ha(A.nat08)} para ${ha(nat)} depois de 2008.</b>`; }
        else nivel = 'ok';
      } else if (saldo < -Math.max(0.5, exig * 0.03)) { nivel = 'alerta'; resumo = `Exigência de ${regra.pct}% (${ha(exig)}); vegetação nativa estimada de ${ha(nat)} (${fmt(nat / area * 100, 0)}%). <b>Possível déficit de ${ha(-saldo)}</b>${Number.isFinite(mf) ? '' : '; módulos fiscais não informados (até 4 MF pode valer o art. 67)'}.`; }
      else { nivel = 'ok'; resumo = `Exigência de ${regra.pct}% (${ha(exig)}); vegetação nativa estimada de ${ha(nat)} (${fmt(nat / area * 100, 0)}%), ${saldo >= 0 ? `excedente de ${ha(saldo)}` : 'no limite'}.`; }
      A.rl = { legal, bioma, ...regra, area, exig, mf, nat, saldo, nivel, resumo };
    }
    // Pastagem: idade e vigor
    if (R.idade) A.idade = R.idade;
    if (R.cena && R.uso) { try { A.vigor = vigorPastagem(R.cena, R.uso); } catch (e) { console.warn('vigor', e); } }
    {
      const partes = []; let nivel = 'info';
      if (A.idade && A.idade.ha > 0) partes.push(`${ha(A.idade.ha)} de pastagem, idade mediana de ${A.idade.mediana} anos`);
      if (A.vigor) { const b = A.vigor.classes[0]; partes.push(`vigor ${A.vigor.classes.slice().sort((x, y) => y.pct - x.pct)[0].nome.toLowerCase()} predominante (NDVI ${fmt(A.vigor.media, 2)} em ${dBR(A.vigor.data)})`); if (b.pct >= 30) { nivel = 'alerta'; partes.push(`<b>${fmt(b.pct, 0)}% com vigor baixo</b>`); } }
      A.pasto = { nivel: partes.length ? nivel : 'erro', resumo: partes.length ? partes.join(' · ') + '.' : 'Não consegui analisar a pastagem agora.' };
    }
    // Relevo
    if (R.relevo) {
      const T = R.relevo, cont = TD.CLASSES.map(() => 0), sl = [], al = [];
      for (let i = 0; i < T.slope.length; i++) { if (!T.mask[i] || Number.isNaN(T.slope[i])) continue; const v = T.slope[i]; sl.push(v); al.push(T.elev[i]); cont[TD.CLASSES.findIndex(c => v >= c[0] && v < c[1])]++; }
      if (sl.length) {
        sl.sort((a, b) => a - b); al.sort((a, b) => a - b);
        const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))], tot = sl.length;
        const classes = TD.CLASSES.map((c, i) => ({ nome: c[2], faixa: c[1] > 999 ? `> ${c[0]}%` : `${c[0]}–${c[1]}%`, cor: c[3], pct: cont[i] / tot * 100, ha: cont[i] * T.pxHa }));
        const dom = classes.slice().sort((a, b) => b.pct - a.pct)[0];
        A.relevo = { T, classes, media: sl.reduce((s, v) => s + v, 0) / tot, altMin: q(al, .01), altMax: q(al, .99), altMed: al.reduce((s, v) => s + v, 0) / al.length, dom, mec: classes.slice(0, 3).reduce((s, c) => s + c.pct, 0) };
      }
    }
    return A;
  }

  // ---------- Montagem do documento ----------
  const barras = itens => itens.filter(i => i.pct >= 0.1).map(i => `<div class="barra"><span class="bn"><s style="background:${i.cor}"></s>${esc(i.nome)}</span><i><b style="width:${Math.min(100, i.pct).toFixed(1)}%;background:${i.cor}"></b></i><span class="bv">${fmt(i.pct, 1)}%${i.ha != null ? ` · ${fmt(i.ha, i.ha < 10 ? 2 : 1)} ha` : ''}</span></div>`).join('');
  const tab = (cab, linhas) => `<table><tr>${cab.map(c => `<th>${c}</th>`).join('')}</tr>${linhas.map(l => `<tr>${l.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
  const kpis = arr => `<div class="kpis">${arr.map(([v, t]) => `<div class="kpi"><b>${v}</b><span>${t}</span></div>`).join('')}</div>`;
  const fig = (src, cap) => src ? `<figure><img src="${src}" alt=""><figcaption>${cap || ''}</figcaption></figure>` : '';
  const selo = n => `<span class="tag" style="background:${COR[n] || COR.info}">${ROT[n] || ''}</span>`;

  async function montar(D, A, aviso) {
    const { f, R } = D, cons = CONF.consultor, id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).slice(0, 8).toUpperCase();
    const agora = new Date(), quando = `${dBR(isoDay(agora))} às ${agora.toTimeString().slice(0, 5)}`;
    const cd = A.carDados || {}, mun = cd.mun || f.municipio || '', uf = cd.uf || D.uf;
    const pags = []; const pg = (titulo, lead, corpo) => pags.push({ titulo, lead, corpo });
    aviso('doc', 'wait');

    // mapas
    const contornoCAR = A.carDados ? [{ feats: [A.carDados.ft], cor: '#ffd400', larg: 2, tracejado: [8, 5] }] : [];
    const M = {};
    M.geral = await mapa(f, { camadas: contornoCAR });
    if (R.emb || R.prot) M.entorno = await mapa(f, { raioKm: CONF.raioKm, camadas: [
      { feats: (R.prot && !R.prot.erro ? Object.values(R.prot).flatMap(v => Array.isArray(v) ? v : []) : []), cor: '#c084fc', fill: 'rgba(192,132,252,.25)', larg: 2 },
      { feats: R.emb || [], cor: '#ff3b3b', fill: 'rgba(255,59,59,.35)', larg: 2 },
    ], pontos: ((R.fogo && R.fogo.focos) || []).map(o => ({ lon: +o.lon, lat: +o.lat, cor: '#ff7a00', r: 6 })) });
    if (R.prodes) M.prodes = await mapa(f, { camadas: [{ feats: R.prodes, cor: '#ff9800', fill: 'rgba(255,152,0,.45)', larg: 1.5 }] });
    if (A.deter && A.deter.rows) M.deter = await mapa(f, { camadas: [{ feats: A.deter.rows.map(r => r.ft), cor: '#ff2d55', fill: 'rgba(255,45,85,.35)', larg: 1.5 }] });
    if (R.aq) {
      const q = R.aq, paleta = ['#ffe08a', '#ffb347', '#ff7f2a', '#e8452c', '#a8121c', '#6b0a10'], cores = {};
      q.anos.forEach((a, i) => cores[a.ano] = paleta[Math.min(paleta.length - 1, i)]);
      const anos = q.anos.map(a => a.ano), classe = new Uint8Array(q.queimado.length); for (let i = 0; i < classe.length; i++) if (q.queimado[i]) classe[i] = anos.indexOf(q.queimado[i]) + 1;
      M.aq = await mapa(f, { rasters: [{ url: desenharClasse(q.g, classe, anos.map(a => cores[a])), bounds: q.g.bounds, alpha: .85 }] });
      M.aqCores = cores;
    }
    if (A.uso) M.uso = await mapa(f, { rasters: [{ url: MB.desenhar(A.uso.m), bounds: A.uso.m.g.bounds, alpha: .9 }] });
    if (A.idade && A.idade.ha > 0) M.idade = await mapa(f, { escurecer: .15, rasters: [{ url: desenharIdade(A.idade), bounds: A.idade.g.bounds, alpha: .9 }] });
    if (A.vigor) M.vigor = await mapa(f, { escurecer: .15, rasters: [{ url: desenharClasse(A.vigor.g, A.vigor.classe, VIGOR.map(v => v[3])), bounds: A.vigor.g.bounds, alpha: .9 }] });
    if (R.cena) {
      try { M.rgb = await mapa(f, { W: 1200, H: 760, rasters: [{ url: renderCanvas(R.cena, 'rgb', true), bounds: R.cena.g.bounds, alpha: 1, suave: true }] }); } catch (e) { }
      try { M.ndvi = await mapa(f, { rasters: [{ url: renderCanvas(R.cena, 'ndvi', true), bounds: R.cena.g.bounds, alpha: 1, suave: true }] }); } catch (e) { }
    }
    if (A.relevo) {
      const T = A.relevo.T, cv = document.createElement('canvas'); cv.width = T.W; cv.height = T.H;
      const x = cv.getContext('2d'), img = x.createImageData(T.W, T.H), d = img.data, hx = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
      for (let i = 0; i < T.slope.length; i++) { if (!T.mask[i] || Number.isNaN(T.slope[i])) continue; const c = hx(TD.classe(T.slope[i])[3]), o = i * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 230; }
      x.putImageData(img, 0, 0);
      M.relevo = await mapa(f, { rasters: [{ url: cv.toDataURL('image/png'), bounds: T.bounds, alpha: .85, suave: true }] });
    }

    // gráficos
    const G = {};
    const eixo = { ticks: { color: '#555' }, grid: { color: '#e6e9e7' } };
    if (R.clima) {
      const C = R.clima;
      G.temp = grafico({ type: 'line', data: { labels: MESES, datasets: [
        { label: 'Máxima média (°C)', data: C.meses.map(m => m.tmax), borderColor: '#e8452c', backgroundColor: 'rgba(232,69,44,.12)', fill: '+2', tension: .35, pointRadius: 2 },
        { label: 'Média (°C)', data: C.meses.map(m => m.tmed), borderColor: '#555', tension: .35, pointRadius: 2 },
        { label: 'Mínima média (°C)', data: C.meses.map(m => m.tmin), borderColor: '#2f6fb3', tension: .35, pointRadius: 2 },
      ] }, options: { scales: { y: eixo, x: eixo } } });
      G.chuva = grafico({ data: { labels: MESES, datasets: [
        { type: 'bar', label: 'Chuva média (mm)', data: C.meses.map(m => m.chuva), backgroundColor: '#5aa9ff' },
        { type: 'line', label: 'Ano seco (p10)', data: C.meses.map(m => m.p10), borderColor: '#c0392b', borderDash: [5, 4], pointRadius: 0, tension: .3 },
        { type: 'line', label: 'Ano chuvoso (p90)', data: C.meses.map(m => m.p90), borderColor: '#1f5f99', borderDash: [5, 4], pointRadius: 0, tension: .3 },
      ] }, options: { scales: { y: { ...eixo, title: { display: true, text: 'mm', color: '#555' } }, x: eixo } } });
      G.veran = grafico({ data: { labels: MESES, datasets: [
        { type: 'bar', label: 'Veranico médio (dias)', data: C.meses.map(m => m.veranMed), backgroundColor: '#f2c14e' },
        { type: 'line', label: 'Pior registro (dias)', data: C.meses.map(m => m.veranMax), borderColor: '#7a4b00', showLine: false, pointRadius: 5, pointStyle: 'line', borderWidth: 3 },
      ] }, options: { scales: { y: { ...eixo, title: { display: true, text: 'dias seguidos sem chuva', color: '#555' } }, x: eixo } } });
    }
    if (R.aq) G.aq = grafico({ type: 'bar', data: { labels: R.aq.anos.map(a => a.ano), datasets: [{ label: 'Área queimada no imóvel (ha)', data: R.aq.anos.map(a => +a.ha.toFixed(2)), backgroundColor: R.aq.anos.map(a => M.aqCores[a.ano]) }] }, options: { scales: { y: eixo, x: eixo }, plugins: { legend: { display: false } } } }, 900, 240);

    // ---- Capa ----
    const chips = ['Fundiário', 'Ambiental', 'Infraestrutura', 'Desmatamento', 'Fogo', 'Uso do solo', 'Cobertura', 'Lotação', 'Pastagem', 'Relevo', 'Solo', 'Clima'];
    pags.push({ capa: true, corpo: `
      <div class="capa">
        <div class="marca">AgroSat · Relatório da Propriedade</div>
        <h1>${esc(f.name)}</h1>
        ${cd.cod ? `<div class="car">CAR ${esc(cd.cod)} ${cd.st ? `<span class="st">${esc(STATUS_CAR[cd.st] || cd.st)}</span>` : ''}</div>` : ''}
        ${f.owner ? `<div class="car">Proprietário/cliente: ${esc(f.owner)}</div>` : ''}
        ${M.geral ? `<img class="capaimg" src="${M.geral}" alt="">` : ''}
        <div class="kpis k4">
          <div class="kpi"><b>${fmt(f.area, f.area < 100 ? 2 : 1)} ha</b><span>área do perímetro</span></div>
          <div class="kpi"><b>${esc(mun ? `${mun} - ${uf}` : uf)}</b><span>município</span></div>
          <div class="kpi"><b>${Number.isFinite(cd.mf) ? fmt(cd.mf, 2) : '—'}</b><span>módulos fiscais</span></div>
          <div class="kpi"><b>${esc(A.rl.bioma || '—')}</b><span>bioma${A.rl.legal ? ' · Amazônia Legal' : ''}</span></div>
        </div>
        <div class="chips"><span>Tipos de análise</span>${chips.map(c => `<i>${c}</i>`).join('')}</div>
        <div class="assina">${cons.nome ? `<b>${esc(cons.nome)}</b>` : ''}${cons.empresa ? ` · ${esc(cons.empresa)}` : ''}${cons.contato ? `<br>${esc(cons.contato)}` : ''}<br>Gerado em ${quando} · ID ${id}</div>
      </div>` });

    // ---- Identificação ----
    pg('Dados do imóvel', 'Identificação cadastral e limite analisado.', `
      ${fig(M.geral, 'Contorno branco: limite analisado. Tracejado amarelo: imóvel no CAR.' + ((f.divs || []).length ? ' Linhas finas: divisões/piquetes.' : ''))}
      ${tab(['Campo', 'Valor'], [
        ['Nome', esc(f.name)], ['Área do perímetro', ha(f.area)],
        ['CAR', cd.cod ? esc(cd.cod) : (f.car ? esc(f.car) : 'não localizado sobre a área')],
        ...(cd.cod ? [['Situação do CAR', esc(STATUS_CAR[cd.st] || cd.st || '—')], ['Área declarada no CAR', ha(cd.area)], ['Município / UF', esc(`${cd.mun || '—'} / ${cd.uf || ''}`)], ['Tipo / condição', esc([cd.tipo, cd.cond].filter(Boolean).join(' · ') || '—')], ['Módulos fiscais', Number.isFinite(cd.mf) ? `${fmt(cd.mf, 2)} (módulo de ≈ ${fmt(cd.area / cd.mf, 0)} ha)` : '—']] : []),
        ['Bioma', esc(A.rl.bioma || 'não identificado')], ['Amazônia Legal', A.rl.legal ? 'sim' : 'não'],
        ['Divisões cadastradas', String((f.divs || []).length)],
        ['Centro (lat, lon)', `${fmt(D.centro[1], 5)}, ${fmt(D.centro[0], 5)}`],
      ])}
      <h3>CAR e sobreposições</h3><p>${selo(A.car.nivel)} ${A.car.resumo}</p>${A.car.detalhes || ''}
      <h3>Certificação SIGEF / INCRA</h3><p>${selo(A.sigef.nivel)} ${A.sigef.resumo}</p>${A.sigef.detalhes || ''}`);

    // ---- Sumário ----
    const S_ = [
      ['CAR (SICAR)', A.car], ['SIGEF / INCRA', A.sigef], ['Embargos IBAMA', A.emb], ['Desmatamento PRODES', A.prodes], ['Alertas DETER', A.deter],
      ['Áreas queimadas (5 anos)', A.aq], [`Focos de queimada (${CONF.diasFocos} dias)`, A.fogo], ['Áreas protegidas e territórios', A.prot], ['Crédito rural (Sicor)', A.credito], ['Reserva Legal', A.rl],
      ['Entorno e infraestrutura', R.entorno ? (() => { const L = linhasEntorno(R.entorno), al = L.filter(l => l.nivel === 'alerta' || l.nivel === 'grave'); const er = L.filter(l => l.nivel === 'erro'); if (er.length >= L.length - 1) return { nivel: 'erro', resumo: 'As bases de entorno não responderam agora' }; return { nivel: al.length ? 'alerta' : er.length ? 'info' : 'ok', resumo: (al.length ? al.map(l => `${l.nome}: ${semTag(l.texto)}`).join(' · ') : 'Nada sobre o imóvel nas bases consultadas (mineração, floresta pública, sítio arqueológico); fora da faixa de fronteira') + (er.length ? ` · ${er.length} base(s) não consultada(s): ${er.map(l => l.nome.split(' (')[0]).join(', ')}` : '') }; })() : { nivel: 'erro', resumo: esc(D.E.entorno || '') }],
      ['Uso do solo', A.uso ? { nivel: 'info', resumo: A.uso.grupos.slice(0, 3).map(g => `${g.nome} ${fmt(g.pct, 0)}%`).join(' · ') } : { nivel: 'erro', resumo: esc(D.E.uso || '') }],
      ['Condição da cobertura', R.cob ? (() => { const c = k => (R.cob.classes.find(x => x.k === k) || { pct: 0 }).pct; const sujo = c(2) + c(3), deg = c(5) + c(6); return { nivel: sujo + deg >= 25 ? 'alerta' : 'info', resumo: `Pasto formado ${fmt(c(4), 0)}% · degradado/solo ${fmt(deg, 0)}% · juquira ${fmt(sujo, 0)}%${c(3) >= 1 ? ` (${fmt(c(3), 0)}% avançou sobre pasto desde ${R.cob.anoAntigo})` : ''} · mata ${fmt(c(1), 0)}%` }; })() : { nivel: 'erro', resumo: esc(D.E.cob || '') }],
      ['Capacidade de suporte', (R.cob && R.clima) ? (() => { try { const L = calcularLotacao(f, R.cob, R.clima, f.lot); return { nivel: L.ua && L.ua > L.capAno * 1.05 ? 'alerta' : 'info', resumo: `Sustenta cerca de ${fmt(L.capAno, 0)} UA no ano (${fmt(L.capAno / Math.max(L.haPasto, 0.01), 2)} UA/ha de pasto)${L.ua ? ` · rebanho ${fmt(L.ua, 0)} UA` : ''}${L.deficitT > 0 ? ` · déficit de ${fmt(L.deficitT, 1)} t MS em ${L.mesesDeficit.join(', ')}` : ''}` }; } catch (e) { return { nivel: 'erro', resumo: esc(e.message) }; } })() : { nivel: 'erro', resumo: 'depende da condição da cobertura e do clima' }],
      ['Pastagem (idade e vigor)', A.pasto],
      ['Relevo', A.relevo ? { nivel: 'info', resumo: `Declividade média ${fmt(A.relevo.media, 1)}% · predomínio ${A.relevo.dom.nome.toLowerCase()} · altitude ${fmt(A.relevo.altMin, 0)}–${fmt(A.relevo.altMax, 0)} m` } : { nivel: 'erro', resumo: esc(D.E.relevo || '') }],
      ['Solo', R.solo ? { nivel: 'info', resumo: `Textura ${R.solo.textura.toLowerCase()} · argila ${fmt(R.solo.argila, 0)}% · pH ${n1(R.solo.ph)}${R.solo.wrb && R.solo.wrb[0] ? ' · ' + R.solo.wrb[0].sibcs : ''}` } : { nivel: 'erro', resumo: esc(D.E.solo || '') }],
      ['Clima', R.clima ? { nivel: 'info', resumo: `Chuva média ${fmt(R.clima.chuvaAnual, 0)} mm/ano · ${R.clima.secos} mês(es) seco(s) · últimos 30 dias ${Number.isFinite(R.clima.recente.dif) ? (R.clima.recente.dif >= 0 ? '+' : '') + fmt(R.clima.recente.dif, 0) + '%' : '—'} da normal` } : { nivel: 'erro', resumo: esc(D.E.clima || '') }],
    ];
    const cont = { grave: 0, alerta: 0, ok: 0 }; S_.forEach(([, x]) => { if (x && cont[x.nivel] != null) cont[x.nivel]++; });
    pg('Sumário de conformidade', 'Cruzamento do imóvel com as bases públicas consultadas neste relatório.', `
      ${kpis([[cont.grave, 'críticos'], [cont.alerta, 'de atenção'], [cont.ok, 'sem pendências'], [S_.length, 'temas analisados']])}
      <div class="sum">${S_.map(([t, x]) => { x = x || { nivel: 'erro', resumo: '' }; return `<div class="row" style="--c:${COR[x.nivel]}"><div><b>${t}</b><small>${(t => t.length > 150 ? t.slice(0, 147) + '…' : t)(semTag(x.resumo))}</small></div>${selo(x.nivel)}</div>`; }).join('')}</div>`);

    // ---- Fiscalização e áreas protegidas ----
    pg('Fiscalização ambiental e áreas protegidas', `Embargos do IBAMA, terras indígenas, unidades de conservação, quilombos, assentamentos e focos de calor em até ${CONF.raioKm} km.`, `
      ${fig(M.entorno, `Vermelho: embargos IBAMA. Lilás: áreas protegidas e territórios. Pontos laranja: focos de queimada dos últimos ${CONF.diasFocos} dias. Raio de ${CONF.raioKm} km.`)}
      <h3>Embargos IBAMA</h3><p>${selo(A.emb.nivel)} ${A.emb.resumo}</p>${A.emb.detalhes || ''}
      <h3>Áreas protegidas e territórios</h3><p>${selo(A.prot.nivel)} ${A.prot.resumo}</p>${A.prot.detalhes || ''}
      <h3>Focos de queimada (INPE)</h3><p>${selo(A.fogo.nivel)} ${A.fogo.resumo}</p>${A.fogo.detalhes || ''}`);

    // ---- Crédito rural ----
    if (A.credito) {
      const glebasF = R.credito && R.credito.feats ? R.credito.feats.filter(ft => interHa(D.F, ft) >= 0.5) : [];
      const mCred = glebasF.length ? await mapa(f, { camadas: [{ feats: glebasF, cor: '#0288d1', fill: 'rgba(2,136,209,.25)', larg: 2, tracejado: [6, 4] }] }) : null;
      pg('Crédito rural registrado (Sicor)', 'Áreas financiadas com crédito rural que os bancos georreferenciaram no Sicor, do Banco Central, e que se sobrepõem ao imóvel.', `
      ${fig(mCred, 'Azul tracejado: glebas financiadas registradas no Sicor.')}
      <p>${selo(A.credito.nivel)} ${A.credito.resumo}</p>${A.credito.detalhes || ''}
      <p class="nota">Cobertura parcial: só aparecem operações com a área informada em coordenadas (sobretudo custeio agrícola). Ausência de registro não comprova que o imóvel está livre de financiamento. Para garantias (penhor, hipoteca, alienação), consulte a certidão de ônus reais da matrícula no cartório.</p>`);
    }

    // ---- PRODES e DETER ----
    pg('Desmatamento: PRODES e DETER (INPE)', 'Supressão anual de vegetação nativa (PRODES) e alertas quase diários (DETER) que tocam o imóvel.', `
      <div class="duas">${fig(M.prodes, 'Laranja: PRODES.')}${fig(M.deter, 'Vermelho: alertas DETER.')}</div>
      <h3>PRODES</h3><p>${selo(A.prodes.nivel)} ${A.prodes.resumo}</p>${A.prodes.detalhes || ''}
      <h3>DETER</h3><p>${selo(A.deter.nivel)} ${A.deter.resumo}</p>
      ${A.deter.rows && A.deter.rows.length ? tab(['Data', 'Classe', 'Na fazenda', 'Satélite', 'Bioma'], A.deter.rows.slice(0, 40).map(r => [r.data ? dBR(r.data) : '—', esc(deterNome(r.cls)), ha(r.oh), esc(r.sat || '—'), esc(r.fonte || '')])) : ''}
      <p class="nota">Desmatamento depois de 22/07/2008 sem autorização pode gerar passivo ambiental. As regras de crédito rural usam as detecções a partir de 31/07/2019 como referência; confirme com o banco. O DETER é um sistema de alerta (não mede área exata) e não enxerga através de nuvens.</p>`);

    // ---- Áreas queimadas ----
    if (R.aq) {
      const q = R.aq, linhas = [];
      q.anos.forEach(a => a.meses.forEach(m => linhas.push([a.ano, MESES[m.mes - 1], ha(m.ha)])));
      pg('Áreas queimadas', q.grosso ? `Cicatrizes de fogo do MODIS (NASA, 500 m), mês a mês, de ${q.anos[0].ano} a ${q.anos[q.anos.length - 1].ano}. O MapBiomas Fogo (30 m) está com downloads suspensos; o MODIS só enxerga queimadas maiores, de cerca de 20 ha ou mais.` : `Cicatrizes de fogo mapeadas mês a mês por satélite (MapBiomas Fogo, Landsat 30 m), de ${q.anos[0].ano} a ${q.anos[q.anos.length - 1].ano}.`, `
        ${fig(M.aq, `Cor = ano mais recente em que o pixel queimou: ${Object.entries(M.aqCores).map(([a, c]) => `<s style="background:${c}"></s>${a}`).join(' ')}.`)}
        <p>${selo(A.aq.nivel)} ${A.aq.resumo} Soma das áreas por ano: ${ha(q.somaHa)} (a mesma área pode queimar em mais de um ano).</p>
        ${G.aq ? `<img class="graf" src="${G.aq}" alt="">` : ''}
        ${linhas.length ? tab(['Ano', 'Mês', 'Área no imóvel'], linhas) : ''}
        ${q.falhas.length ? `<p class="nota">Anos não lidos: ${q.falhas.join(', ')}.</p>` : ''}
        <p class="nota">Fogo em pastagem pode ser manejo; em vegetação nativa, exige autorização (queima controlada). O mapa mensal do MapBiomas registra o mês da detecção.</p>`);
    }

    // ---- Uso do solo e Reserva Legal ----
    if (A.uso) {
      const rl = A.rl;
      pg('Uso e cobertura do solo', `Classificação por satélite recortada no imóvel · ${A.uso.cit}, ${A.uso.ano} (${A.uso.res} m).`, `
        ${fig(M.uso, 'Classes de uso do solo dentro do limite analisado.')}
        ${barras(A.uso.classes.filter(c => c.pct >= 0.3))}
        <h3>Reserva Legal (estimativa)</h3>
        ${kpis([[`${rl.pct}%`, rl.regra], [ha(rl.exig), 'exigência mínima'], [ha(rl.nat), 'vegetação nativa hoje'], [Number.isFinite(A.nat08) ? ha(A.nat08) : '—', 'nativa em 2008 (MapBiomas 30 m)']])}
        <p>${selo(rl.nivel)} ${rl.resumo}</p>
        ${A.uso.m.alt ? `<p class="nota"><b>Base substituta:</b> o MapBiomas suspendeu os downloads de mapas. Este uso do solo vem do ${CIT_IO}, ano ${A.uso.ano}; a classe "Pastagem" corresponde a campo/pasto (rangeland), que também inclui campos naturais, e "Formação florestal" a árvores. A vegetação de 2008 depende do MapBiomas e fica sem leitura até eles reabrirem.</p>` : ''}
        <p class="nota">Estimativa pela regra geral do Código Florestal (art. 12), sobre a área ${A.carDados ? 'declarada no CAR' : 'do perímetro'}. Não desconta APP nem considera compensação, servidão ou RL averbada fora do imóvel. A RL oficial é a declarada e aprovada no SICAR; a vegetação nativa aqui vem de imagens de satélite. Não substitui análise técnica do CAR.</p>`);
    }

    // ---- Condição da cobertura ----
    if (R.cob) {
      const m = R.cob, vis = m.classes.filter(c => c.pct >= 0.3);
      const mc = await mapa(f, { rasters: [{ url: desenharCobertura(m), bounds: m.g.bounds, alpha: .88 }] });
      const cols = COB.filter(([k]) => vis.some(v => v.k === k));
      pg('Condição da cobertura do solo', `Classificação pela série de ${m.nCenas} imagens Sentinel-2 (10 m) de ${dBR(m.datas[0])} a ${dBR(m.datas[m.datas.length - 1])}${m.anoAntigo ? `, comparada com ${m.anoAntigo}` : ''}.`, `
        ${fig(mc, vis.map(c => `<s style="background:${c.cor}"></s>${c.nome}`).join(' '))}
        ${barras(vis)}
        ${m.divs.length ? `<h3>Por divisão</h3>${tab(['Divisão', 'Área', ...cols.map(([, n]) => n)], m.divs.map(d => [esc(d.nome), ha(d.ha), ...cols.map(([k]) => fmt(d.pct[COB.findIndex(c => c[0] === k)], 0) + '%')]))}` : ''}
        <p class="nota">${NOTA_COBERTURA}</p>`);
    }

    // ---- Capacidade de suporte e balanço forrageiro ----
    let LOT = null;
    if (R.cob && R.clima) { try { LOT = calcularLotacao(f, R.cob, R.clima, f.lot); } catch (e) { console.warn('lotação', e); } }
    if (LOT) {
      const L = LOT, { sit, eq, fmtT } = lotacaoHTML(L), por = v => fmt(v / Math.max(L.haPasto, 0.01), 2);
      const gl = grafico({ data: { labels: MESES, datasets: [
        { type: 'bar', label: 'Capim disponível (t MS)', data: L.meses.map(x => +x.ofertaT.toFixed(2)), backgroundColor: '#5cb85c' },
        ...(L.ua ? [{ type: 'line', label: 'Consumo do rebanho (t MS)', data: L.meses.map(x => +x.demT.toFixed(2)), borderColor: '#14532d', borderWidth: 3, pointRadius: 0 },
                    { type: 'bar', label: 'Déficit (t MS)', data: L.meses.map(x => +x.deficitT.toFixed(2)), backgroundColor: '#e8452c' }] : []),
      ] }, options: { scales: { y: { ticks: { color: '#555' }, grid: { color: '#e6e9e7' }, title: { display: true, text: 't de matéria seca', color: '#555' } }, x: { ticks: { color: '#555' }, grid: { display: false } } } } });
      pg('Capacidade de suporte e balanço forrageiro', `${CAPINS[L.op.capim][0]} · ${ADUB[L.op.adub][0].toLowerCase()} · ${SISTEMA[L.op.sistema][0].toLowerCase()} · ${CENARIO[L.op.cenario][0].toLowerCase()}${f.lot ? '' : ' (valores padrão: informe capim e rebanho na aba Lotação)'}.`, `
        ${kpis([[`${fmt(L.capAno, 0)} UA`, `sustenta no ano (${por(L.capAno)} UA/ha)`], [por(L.capAguas), 'UA/ha no pico das águas'], [por(L.capSeca), 'UA/ha no pior mês da seca'], [L.ua ? `${fmt(L.ua, 0)} UA` : '—', L.ua ? `rebanho atual (${por(L.ua)} UA/ha)` : 'rebanho não informado']])}
        <p>${sit}. Pasto: ${fmt(L.haPasto, 1)} ha (${fmt(L.haEf, 1)} ha efetivos pela condição vista no satélite); produção estimada de ${fmt(L.kgHaAno / 1000, 1)} t de MS/ha/ano.</p>
        ${gl ? `<img class="graf" src="${gl}" alt="">` : ''}
        ${eq}
        ${tab(['Mês', 'Chuva', 'Produção', 'Aproveitável', 'Consumo', 'Déficit'], L.meses.map(x => [x.nome, fmt(x.chuva, 0) + ' mm', fmtT(x.prodT) + ' t', fmtT(x.ofertaT) + ' t', L.ua ? fmtT(x.demT) + ' t' : '—', x.deficitT > 0.05 ? `<b>${fmtT(x.deficitT)} t</b>` : '—']))}
        ${L.divs.length ? `<h3>Por piquete</h3>${tab(['Divisão', 'Pasto', 'Pasto efetivo', 'UA nas águas', 'UA na seca'], L.divs.map(d => [esc(d.nome), ha(d.pasto), ha(d.ef), fmt(d.uaAguas, 1), fmt(d.uaSeca, 1)]))}` : ''}
        <p class="nota">${NOTA_LOTACAO}</p>`);
    }

    // ---- Pastagem ----
    if ((A.idade && A.idade.ha > 0) || A.vigor) {
      const I = A.idade, V = A.vigor;
      pg('Pastagem: idade e vigor', 'Tempo de formação das pastagens e condição atual da cobertura dentro das áreas de pasto.', `
        ${I && I.ha > 0 ? `<h3>Idade da pastagem</h3>${fig(M.idade, 'Anos seguidos como pastagem até ' + I.ano + ' (MapBiomas 30 m).')}
          ${kpis([[ha(I.ha), 'de pastagem'], [`${fmt(I.media, 1)} anos`, 'idade média'], [`${I.mediana} anos`, 'mediana'], [`${fmt(I.classes[0].pct, 0)}%`, 'formada há até 5 anos']])}
          ${barras(I.classes)}
          <p class="nota">Calculada pela sequência de anos em que o pixel aparece como pastagem no MapBiomas (${MB.COL.m30.anos[0]}–${I.ano}). "Desde 1985 ou antes" reúne áreas que já eram pasto no início da série. Pasto recém-formado pode indicar abertura ou reforma; pasto muito antigo sem reforma tende a degradar.</p>` : ''}
        ${!(I && I.ha > 0) && D.E.idade ? `<p class="nota"><b>Idade da pastagem:</b> ${esc(D.E.idade)}.</p>` : ''}
        ${V ? `<h3>Vigor da pastagem</h3>${fig(M.vigor, `NDVI do Sentinel-2 (${R.cena && R.cena.composto ? `imagem limpa até ${dBR(V.data)}` : dBR(V.data)}) sobre as áreas de pastagem do mapa de uso do solo.`)}
          ${barras(V.classes)}
          <p>NDVI médio da pastagem: <b>${fmt(V.media, 2)}</b> (baixo < 0,35 · médio 0,35–0,55 · alto ≥ 0,55).</p>
          <p class="nota">${R.cena && R.cena.composto ? 'Leitura dos últimos 90 dias (mediana das passagens sem nuvem)' : 'Leitura de uma única data'}: no período seco o NDVI cai naturalmente. Use como triagem para priorizar vistoria; a condição real (cobertura, invasoras, cupins, erosão) se confirma em campo.</p>` : ''}`);
    }

    // ---- Imagem recente ----
    if (R.cena) {
      const c = R.cena, st = c.stats || {};
      pg('Imagem de satélite recente', `${c.composto ? `Imagem limpa do Sentinel-2: ${c.composto.n} passagens de ${dBR(c.composto.de)} a ${dBR(c.composto.ate)}, usando em cada ponto só as passagens sem nuvem e sem sombra` : `Sentinel-2 de ${dBR(c.it.properties.datetime)}`} · ${fmt((c.nCloud / Math.max(1, c.nIn)) * 100, 0)}% da área sem imagem limpa.`, `
        ${fig(M.rgb, 'Cor real (contraste ajustado e bordas realçadas; pixel original de 10 m).')}
        ${fig(M.ndvi, 'NDVI: vermelho = pouca vegetação ativa; verde = vegetação vigorosa; cinza = nenhuma passagem sem nuvem no período.')}
        ${kpis([[n1(st.mean, 2), 'NDVI médio'], [c.statsRE ? n1(c.statsRE.mean, 2) : '—', 'NDRE médio'], [n1(st.p10, 2), 'pior 10%'], [n1(st.p90, 2), 'melhor 10%']])}
        ${c.divStats ? tab(['Divisão', 'Área', 'NDVI', 'NDRE', 'Nuvem'], c.divStats.map(d => [esc(d.nome), ha(d.area), n1(d.ndvi, 2), n1(d.ndre, 2), fmt(d.nuvem * 100, 0) + '%'])) : ''}`);
    }

    // ---- Imagem de 2 m (CBERS-4A) ----
    if (R.cbers) {
      const mc = await mapa(f, { rasters: [{ url: renderCanvas(R.cbers, 'rgb', true), bounds: R.cbers.g.bounds, alpha: 1, suave: true }] });
      pg('Imagem de alta resolução (CBERS-4A)', `Satélite brasileiro CBERS-4A (INPE), câmera WPM, 2 m em cor real · ${dBR(R.cbers.it.properties.datetime)}.`, `
        ${fig(mc, 'Cinco vezes mais detalhe que o Sentinel-2: dá para ver estradas, cercas largas, aguadas, manchas de juquira e babaçu.')}
        <p class="nota">O CBERS-4A passa a cada 31 dias e não tem máscara de nuvem: a imagem pode ser mais antiga que a do Sentinel-2 e ter nuvens. Serve para ver detalhes; os índices de vigor (NDVI) continuam vindo do Sentinel-2.</p>`);
    }

    // ---- Relevo ----
    if (A.relevo) {
      const r = A.relevo;
      pg('Relevo', 'Altitude e declividade dentro do limite do imóvel (base SRTM ~30 m).', `
        ${fig(M.relevo, 'Declividade: verde = plano; amarelo/laranja = ondulado a forte ondulado; vermelho = montanhoso/escarpado.')}
        ${kpis([[`${fmt(r.media, 1)}%`, 'declividade média'], [r.dom.nome, 'classe predominante'], [`${fmt(r.altMin, 0)}–${fmt(r.altMax, 0)} m`, 'altitude'], [`${fmt(r.mec, 0)}%`, 'até 20% (mecanizável)']])}
        ${barras(r.classes.map(c => ({ ...c, nome: `${c.nome} (${c.faixa})` })))}
        <p class="nota">Classes de relevo da Embrapa. Mecanização: até ~12% sem restrição, até 20% com cuidado. Acima de 45° (100%) é APP de encosta.</p>`);
    }

    // ---- Solo ----
    if (R.solo) {
      const s = R.solo, obs = [];
      if (s.ph < 5) obs.push('acidez alta: calagem provavelmente necessária');
      else if (s.ph < 5.5) obs.push('acidez moderada: calagem provável para pastagens mais exigentes');
      if (s.textura === 'Arenosa') obs.push('solo arenoso: retém pouca água e nutrientes, mais sujeito a degradação e a sentir veranicos');
      else if (s.textura === 'Média') obs.push('textura média: boa aptidão para pastagens, atenção à cobertura do solo');
      else if (/Argilosa/.test(s.textura)) obs.push('solo argiloso: boa retenção de água; atenção à compactação por pisoteio');
      if (s.ctc < 6) obs.push('CTC baixa: adubação parcelada rende mais');
      pg('Solo', 'Composição e indicadores estimados por satélite e modelos (SoilGrids/ISRIC, 250 m), no centro do imóvel.', `
        <h3>Composição (0–30 cm)</h3>
        ${barras([{ nome: 'Areia', cor: '#e8c37a', pct: s.areia }, { nome: 'Silte', cor: '#b99b73', pct: s.silte }, { nome: 'Argila', cor: '#8c5a3c', pct: s.argila }])}
        <p>Grupamento textural estimado: <b>${s.textura}</b>.</p>
        <h3>Indicadores (0–5 cm)</h3>
        ${kpis([[n1(s.ph, 1), 'pH em água'], [`${n1(s.co, 1)} g/kg`, 'carbono orgânico'], [`${n1(s.ctc, 1)} cmol<sub>c</sub>/kg`, 'CTC'], [`${n1(s.n, 2)} g/kg`, 'nitrogênio']])}
        ${s.wrb && s.wrb.length ? `<h3>Pedologia (classe mais provável)</h3>${tab(['Classe (WRB)', 'Equivalente aproximado (SiBCS)', 'Probabilidade'], s.wrb.map(w => [esc(w.nome), esc(w.sibcs), w.p + '%']))}` : ''}
        ${obs.length ? `<p><b>Leitura para pastagem:</b> ${obs.join('; ')}.</p>` : ''}
        <p class="nota">Estimativas de modelo global (resolução de 250 m) em um ponto: servem para orientar, não substituem análise de solo em laboratório nem o levantamento pedológico.</p>`);
    }

    // ---- Clima ----
    if (R.clima) {
      const C = R.clima, rc = C.recente;
      pg('Climatologia e risco climático', `Série diária de ${C.anos} anos (${C.ini.slice(0, 4)} a ${C.fim.slice(0, 4)}) no centro do imóvel · reanálise ERA5 (Open-Meteo).`, `
        ${kpis([[`${fmt(C.chuvaAnual, 0)} mm`, 'chuva média anual'], [`${C.chuvoso.nome} (${fmt(C.chuvoso.chuva, 0)} mm)`, 'mês mais chuvoso'], [`${C.seco.nome} (${fmt(C.seco.chuva, 0)} mm)`, 'mês mais seco'], [`${C.secos} meses`, 'período seco (< 50 mm)']])}
        <h3>Chuva ao longo do ano</h3>${G.chuva ? `<img class="graf" src="${G.chuva}" alt="">` : ''}
        <p class="nota">Barras: média mensal. Tracejados: em 8 de cada 10 anos a chuva do mês ficou entre as duas linhas.</p>
        <h3>Temperatura</h3>${G.temp ? `<img class="graf" src="${G.temp}" alt="">` : ''}
        <p>Faixa anual típica: ${fmt(C.tAnual[0], 1)} °C a ${fmt(C.tAnual[1], 1)} °C.</p>
        <h3>Chuva recente</h3>
        <p>${dBR(rc.ini)} a ${dBR(rc.fim)}: <b>${fmt(rc.mm, 1)} mm</b>; a média desses mesmos dias é ${fmt(rc.normal, 1)} mm${Number.isFinite(rc.dif) ? ` (<b>${rc.dif >= 0 ? '+' : ''}${fmt(rc.dif, 0)}%</b>)` : ''}. Comparação indicativa, sem valor de previsão.</p>`);
      pg('Secas e veranicos', 'Maior sequência de dias sem chuva (menos de 1 mm) dentro de cada mês, na série histórica.', `
        ${G.veran ? `<img class="graf" src="${G.veran}" alt="">` : ''}
        ${kpis([[`${fmt(C.maiorMedio.veranMed, 1)} dias`, `maior veranico médio (${C.maiorMedio.nome})`], [C.piorVeranico ? `${C.piorVeranico.dias} dias` : '—', C.piorVeranico ? `pior veranico na estação chuvosa (${C.piorVeranico.mes}/${C.piorVeranico.ano})` : 'estação chuvosa'], [C.chuvosos.length ? C.chuvosos.join(', ') : '—', 'meses chuvosos (≥ 100 mm)'], [`${C.secos}`, 'meses secos']])}
        ${tab(['Mês', 'Chuva média', 'Ano seco (p10)', 'Ano chuvoso (p90)', 'Veranico médio', 'Pior veranico'], C.meses.map(m => [m.nome, `${fmt(m.chuva, 0)} mm`, `${fmt(m.p10, 0)} mm`, `${fmt(m.p90, 0)} mm`, `${fmt(m.veranMed, 1)} d`, `${m.veranMax} d (${m.veranAno})`]))}
        <p class="nota">Veranicos na estação chuvosa reduzem o crescimento do pasto e o rendimento de lavouras e silagem. O período seco orienta o planejamento de suplementação e volumoso. Leitura regional (reanálise de ~10 km), não medição na fazenda.</p>`);
    }

    // ---- Entorno, água e infraestrutura ----
    if (R.entorno) {
      const EN = R.entorno, L = linhasEntorno(EN), o = EN.R.osm, M = EN.R.mun;
      const perto = L.flatMap(l => l.itens.filter(i => i.km <= 5).map(i => i.ft));
      const me = await mapa(f, { raioKm: 3, camadas: [
        { feats: perto.filter(ft => !/Point/.test(ft.geometry.type)), cor: '#ffb000', fill: 'rgba(255,176,0,.18)', larg: 2 },
        ...(o && o.app && o.app.geom ? [{ feats: [o.app.geom], cor: '#4fc3f7', fill: 'rgba(79,195,247,.45)', larg: 1 }] : []),
        { feats: perto.filter(ft => /Point/.test(ft.geometry.type)), cor: '#ffb000', r: 6 },
      ] });
      pg('Entorno, água e infraestrutura', 'Energia, mineração, água, patrimônio e logística no imóvel e no entorno.', `
        ${fig(me, 'Amarelo: rios, linhas de energia, processos minerários e outras feições até 5 km. Azul: APP estimada de rios e nascentes dentro do imóvel.')}
        ${tab(['Tema', 'Situação'], L.map(l => [`${selo(l.nivel)} ${esc(l.nome)}`, l.texto + (l.itens[0] && l.itens[0].nome !== '—' ? `<br><small>${esc(l.itens[0].nome)}${l.itens[0].det ? ' · ' + esc(l.itens[0].det) : ''}</small>` : '')]))}
        ${o && o.app ? `<p><b>APP de cursos d'água e nascentes (estimativa):</b> ${ha(o.app.ha)}, considerando 30 m de cada lado dos rios mapeados no OpenStreetMap (largura até 10 m) e 50 m em volta das nascentes. Rios mais largos têm faixa maior; córregos não mapeados ficam de fora.</p>` : ''}
        ${M ? `<p><b>Município:</b> ${esc(M.nome)} - ${M.uf} (código IBGE ${M.id})${M.bovinos && M.bovinos.length ? `. Rebanho bovino (IBGE/PPM): ${M.bovinos.map(x => `${x.ano}: ${fmt(x.cab, 0)}`).join(' · ')} cabeças.` : '.'}</p>` : ''}
        <h3>Certidões e documentos</h3>
        ${tab(['Documento', 'Onde emitir'], CERTIDOES.map(([n, u, d]) => [`<b>${n}</b><br><small>${d}</small>`, `<a href="${u}">${u.replace(/^https?:\/\//, '').split('/')[0]}</a>`]))}
        <p class="nota">Bases de energia (ANEEL/SIGEL), mineração (ANM/SIGMINE), água (ANA/SNIRH), florestas públicas (SFB), patrimônio (IPHAN) e OpenStreetMap. As camadas dos órgãos são encontradas automaticamente pelo nome no catálogo de cada um; se um órgão mudar a camada, o tema aparece como "Não consultado". Matrícula e CCIR não têm consulta aberta: use os links acima.</p>`);
    }

    // ---- Metodologia ----
    pg('Metodologia e fontes', 'Como este relatório foi produzido.', `
      <p>O relatório é gerado automaticamente a partir do limite do imóvel cadastrado no AgroSat. O desenho é cruzado com bases públicas oficiais para identificar o que se sobrepõe a ele ou está no entorno. Áreas e percentuais são calculados sobre o limite analisado.</p>
      ${tab(['Tema', 'Fonte', 'Critério'], [
        ['CAR', 'SICAR / Serviço Florestal Brasileiro', 'imóveis que se sobrepõem ao limite'],
        ['SIGEF', 'INCRA (base nacional Infra S.A. e Acervo Fundiário)', 'parcelas certificadas sobrepostas'],
        ['Embargos', 'IBAMA (PAMGIA / SISCOM)', `sobreposição e entorno de ${CONF.raioKm} km`],
        ['Áreas protegidas', 'IBAMA/MMA, FUNAI, INCRA', `sobreposição e entorno de ${CONF.raioKm} km`],
        ['PRODES e DETER', 'INPE / TerraBrasilis', 'polígonos que tocam o imóvel'],
        ['Focos de queimada', 'INPE (Programa Queimadas)', `últimos ${CONF.diasFocos} dias, até ${CONF.raioKm} km`],
        ['Crédito rural', 'Banco Central do Brasil (Sicor, dados abertos)', 'glebas financiadas que se sobrepõem ao limite'],
        ['Áreas queimadas', R.aq && R.aq.fonte ? R.aq.fonte : 'MapBiomas Fogo, Coleção 5 (30 m); se fora do ar, MODIS MCD64A1 (NASA)', 'pixels dentro do limite, por mês'],
        ['Uso do solo e pastagem', A.uso ? A.uso.cit + (A.uso.m.alt ? ' (MapBiomas com downloads suspensos)' : '') : 'MapBiomas (10 m e 30 m)', 'pixels dentro do limite'],
        ['Imagem e vigor', 'Sentinel-2 (ESA/Copernicus, Earth Search)', 'imagem mais limpa dos últimos 4 meses'],
        ['Imagem de 2 m', 'CBERS-4A WPM (INPE, Brazil Data Cube)', 'imagem mais recente com pouca nuvem que cobre a área'],
        ['Condição da cobertura', 'Sentinel-2, série de 12 meses (10 m)', 'NDVI na seca e nas águas, por pixel; comparação com 3 anos antes'],
        ['Bioma', 'IBGE via INPE/TerraBrasilis', 'centro do imóvel'],
        ['Relevo', 'SRTM (Terrain Tiles, ~30 m)', 'declividade de Horn, classes Embrapa'],
        ['Solo', 'SoilGrids 2.0 (ISRIC, 250 m)', 'centro do imóvel'],
        ['Clima', 'ERA5 via Open-Meteo', 'série diária desde 1991 no centro do imóvel'],
        ['Entorno e infraestrutura', 'ANEEL, ANM, ANA, SFB, IPHAN, OpenStreetMap, IBGE', 'sobreposição e distância até cada feição (raios de 5 a 50 km)'],
      ])}
      <p class="nota">As bases oficiais podem ter lacunas regionais ou atualizações pendentes. Este relatório mostra o estado das bases públicas no momento da geração e não substitui consulta direta aos órgãos, certidões oficiais nem vistoria em campo. Bases que não responderam aparecem como "Não consultado".</p>`);

    aviso('doc', 'ok');
    const total = pags.length;
    const corpo = pags.map((p, i) => p.capa ? `<section class="pg capa-pg">${p.corpo}</section>` : `<section class="pg">
      <div class="cab"><span>${esc(f.name)} · Relatório da Propriedade</span><span>Pág. ${i + 1} de ${total}</span></div>
      <h2>${p.titulo}</h2>${p.lead ? `<p class="lead">${p.lead}</p>` : ''}${p.corpo}
      <div class="rod"><span>Dados públicos consolidados pelo AgroSat${cons.empresa ? ' · ' + esc(cons.empresa) : ''}</span><span>${quando} · ID ${id}</span></div></section>`).join('');
    return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relatório completo — ${esc(f.name)}</title><style>${CSS}</style></head><body>
      ${corpo}</body></html>`;
  }

  const CSS = `
    @page{size:A4;margin:12mm}
    *{box-sizing:border-box}
    body{font:12.5px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1d2a22;margin:0;background:#e9eeea}
    .barra-topo{position:sticky;top:0;z-index:5;text-align:right;padding:8px 12px;background:#e9eeea}
    .barra-topo button{padding:9px 16px;border:0;border-radius:8px;background:#14532d;color:#fff;font-weight:700}
    .pg{background:#fff;max-width:840px;margin:14px auto;padding:24px 30px;box-shadow:0 1px 5px #0002;page-break-after:always;break-after:page}
    .pg:last-child{page-break-after:auto;break-after:auto}
    .cab{display:flex;justify-content:space-between;gap:10px;font-size:10.5px;color:#6a7a70;border-bottom:1px solid #e3e8e4;padding-bottom:6px;margin-bottom:14px}
    h2{font-size:19px;margin:0 0 3px;color:#14532d} h3{font-size:14px;margin:16px 0 6px;color:#1f3a2a}
    .lead{color:#56665c;margin:0 0 12px}
    figure{margin:0 0 10px} figure img,.graf{width:100%;border-radius:6px;display:block} figcaption{font-size:10.5px;color:#6a7a70;margin-top:4px}
    figcaption s,.bn s{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 3px 0 6px;vertical-align:-1px;text-decoration:none}
    .duas{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:8px 0 10px}
    .kpi{border:1px solid #e3e8e4;border-radius:8px;padding:8px 10px} .kpi b{display:block;font-size:16px;color:#14532d;line-height:1.25} .kpi span{font-size:10.5px;color:#6a7a70}
    table{width:100%;border-collapse:collapse;font-size:11.5px;margin:6px 0 10px} th,td{border:1px solid #e1e6e2;padding:4px 7px;text-align:left;vertical-align:top} th{background:#f1f5f2}
    .tag{display:inline-block;color:#fff;border-radius:4px;padding:1px 7px;font-size:10.5px;font-weight:700;white-space:nowrap}
    .sum .row{display:flex;justify-content:space-between;align-items:center;gap:10px;border:1px solid #e3e8e4;border-left:5px solid var(--c);border-radius:6px;padding:4px 10px;margin-bottom:4px;break-inside:avoid;font-size:12px}
    .sum small{display:block;color:#56665c;font-size:10.5px;line-height:1.3}
    .barra{display:grid;grid-template-columns:minmax(120px,32%) 1fr auto;align-items:center;gap:8px;margin:4px 0;font-size:11.5px}
    .barra i{height:11px;background:#eef2ef;border-radius:6px;overflow:hidden} .barra i b{display:block;height:100%}
    .bv{color:#56665c;white-space:nowrap}
    .nota{font-size:10.5px;color:#6a7a70}
    details summary{display:none} details{display:block}
    .rod{margin-top:16px;border-top:1px solid #e3e8e4;padding-top:6px;font-size:9.5px;color:#7a887f;display:flex;justify-content:space-between;gap:10px}
    .capa-pg{padding:0;overflow:hidden}
    .capa{padding:34px 34px 26px;background:linear-gradient(160deg,#0f3d24,#14532d 55%,#1a6b3c);color:#fff}
    .capa .marca{font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.8}
    .capa h1{font-size:30px;margin:6px 0 6px}
    .capa .car{font-size:13px;opacity:.92;margin-bottom:4px} .capa .st{background:#ffd400;color:#14532d;border-radius:4px;padding:1px 6px;font-weight:700;font-size:11px;margin-left:6px}
    .capaimg{width:100%;border-radius:8px;margin:14px 0;display:block;border:2px solid rgba(255,255,255,.25)}
    .capa .kpi{border-color:rgba(255,255,255,.25);background:rgba(255,255,255,.07)} .capa .kpi b{color:#fff} .capa .kpi span{color:#cfe3d6}
    .chips{margin:12px 0} .chips span{display:block;font-size:11px;opacity:.8;margin-bottom:5px} .chips i{display:inline-block;font-style:normal;border:1px solid rgba(255,255,255,.4);border-radius:20px;padding:2px 10px;margin:0 5px 5px 0;font-size:11px}
    .assina{margin-top:14px;font-size:11.5px;opacity:.9}
    @media (max-width:640px){.pg{padding:16px;margin:8px}.kpis{grid-template-columns:1fr 1fr}.duas{grid-template-columns:1fr}.barra{grid-template-columns:1fr auto}.barra i{grid-column:1/-1;order:3}.capa{padding:22px}}
    @media print{body{background:#fff}.noprint{display:none}.pg{box-shadow:none;margin:0;max-width:none;padding:0 2mm}.capa-pg{padding:0}.capa{-webkit-print-color-adjust:exact;print-color-adjust:exact}.tag,.barra b,.kpi,s{-webkit-print-color-adjust:exact;print-color-adjust:exact}}`;

  // ---------- Progresso na janela ----------
  function progresso(w) {
    const itens = [...ETAPAS, ['doc', 'Montando o documento']];
    const est = {};
    const html = () => `<div style="font:15px/1.5 system-ui;padding:22px;max-width:520px;margin:auto;color:#1d2a22"><h2 style="color:#14532d;margin:0 0 4px">Gerando o relatório completo…</h2><p style="color:#666;margin:0 0 14px">Consultando as bases públicas. Leva de 30 s a 2 min.</p>${itens.map(([k, t]) => { const s = est[k]; const ic = s === 'ok' ? '✅' : s === 'erro' ? '⚠️' : s === 'wait' ? '⏳' : '▫️'; return `<div>${ic} ${t}</div>`; }).join('')}</div>`;
    const pintar = () => {
      if (w && !w.closed) { try { w.document.body.innerHTML = html(); return; } catch (e) { } }
      const feitos = Object.values(est).filter(s => s === 'ok' || s === 'erro').length; busy(true, `Relatório completo: ${feitos} de ${itens.length} etapas…`);
    };
    if (w && !w.closed) { try { w.document.open(); w.document.write(`<!DOCTYPE html><meta name="viewport" content="width=device-width"><title>Relatório completo</title><body></body>`); w.document.close(); } catch (e) { } }
    pintar();
    return (k, s) => { est[k] = s; pintar(); };
  }

  async function gerar() {
    const f = farm(); if (!f) return;
    const w = abrirJanela('Relatório completo');
    const aviso = progresso(w);
    $('btnFS').disabled = true;
    try {
      const D = await coletar(f, aviso);
      const A = analisar(D);
      const html = await montar(D, A, aviso);
      S.farmScan = { data: new Date().toISOString(), D, A };
      busy(false);
      mostrarDocumento(w, html);
    } catch (e) {
      console.error(e); busy(false);
      toast('Não consegui gerar o relatório completo: ' + e.message, 7000);
      if (w && !w.closed) try { w.document.body.innerHTML = `<p style="font:15px system-ui;padding:22px">Não consegui gerar o relatório: ${esc(e.message)}</p>`; } catch (x) { }
    } finally { $('btnFS').disabled = false; }
  }
  window.gerarFarmScan = gerar;
  $('btnFS').onclick = gerar;
})();
