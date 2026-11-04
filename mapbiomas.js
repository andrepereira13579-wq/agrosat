/* AgroSat — uso e cobertura do solo (MapBiomas), por ano e por divisão, e mudanças desde 2008. */
'use strict';
(function () {
  const COL = {
    m10: { nome: '10 m · 2017 a 2025', anos: [2017, 2025], res: 10, url: a => `https://storage.googleapis.com/mapbiomas-public/initiatives/brasil/lulc_10m/collection4/coverage/brazil_coverage/brazil_coverage-col4_10m_${a}.tif`, cit: 'MapBiomas 10 m, Coleção 4' },
    m30: { nome: '30 m · 1985 a 2024', anos: [1985, 2024], res: 30, url: a => `https://storage.googleapis.com/mapbiomas-public/initiatives/brasil/collection_10/lulc/coverage/brazil_coverage_${a}.tif`, cit: 'MapBiomas Coleção 10' },
  };
  // legenda (Coleção 10)
  const CL = {
    3: ['Formação florestal', '#1f8d49', 'nat'], 4: ['Formação savânica', '#7dc975', 'nat'], 5: ['Mangue', '#04381d', 'nat'], 6: ['Floresta alagável', '#026975', 'nat'],
    49: ['Restinga arbórea', '#02d659', 'nat'], 11: ['Campo alagado', '#519799', 'nat'], 12: ['Formação campestre', '#d6bc74', 'nat'], 32: ['Apicum', '#fc8114', 'nat'],
    29: ['Afloramento rochoso', '#ffaa5f', 'nat'], 50: ['Restinga herbácea', '#ad5100', 'nat'], 13: ['Outra formação não florestal', '#d89f5c', 'nat'],
    15: ['Pastagem', '#edde8e', 'pas'], 18: ['Agricultura', '#e974ed', 'agr'], 19: ['Lavoura temporária', '#c27ba0', 'agr'], 39: ['Soja', '#f5b3c8', 'agr'],
    20: ['Cana', '#db7093', 'agr'], 40: ['Arroz', '#c71585', 'agr'], 62: ['Algodão', '#ff69b4', 'agr'], 41: ['Outras lavouras temporárias', '#f54ca9', 'agr'],
    36: ['Lavoura perene', '#d082de', 'agr'], 46: ['Café', '#d68fe2', 'agr'], 47: ['Citrus', '#9932cc', 'agr'], 35: ['Dendê', '#9065d0', 'agr'], 48: ['Outras lavouras perenes', '#e6ccff', 'agr'],
    9: ['Silvicultura', '#7a5900', 'sil'], 21: ['Mosaico de usos', '#ffefc3', 'mos'], 22: ['Área não vegetada', '#d4271e', 'nv'], 23: ['Praia, duna e areal', '#ffa07a', 'nv'],
    24: ['Área urbanizada', '#d4271e', 'nv'], 30: ['Mineração', '#9c0027', 'nv'], 75: ['Usina fotovoltaica', '#c12100', 'nv'], 25: ['Outra área não vegetada', '#db4d4f', 'nv'],
    26: ['Corpo d\'água', '#2532e4', 'agu'], 33: ['Rio, lago e oceano', '#2532e4', 'agu'], 31: ['Aquicultura', '#091077', 'agu'], 27: ['Não observado', '#ffffff', 'nv'],
  };
  const GRUPO = { nat: ['Vegetação nativa', '#1f8d49'], pas: ['Pastagem', '#edde8e'], agr: ['Agricultura', '#e974ed'], sil: ['Silvicultura', '#7a5900'], mos: ['Mosaico de usos', '#ffefc3'], nv: ['Não vegetada', '#db4d4f'], agu: ['Água', '#2532e4'] };
  const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const cache = new Map();

  function preencherAnos() {
    const c = COL[$('mbCol').value], sel = $('mbAno'), atual = sel.value;
    let o = ''; for (let a = c.anos[1]; a >= c.anos[0]; a--) o += `<option>${a}</option>`;
    sel.innerHTML = o; if (atual && +atual >= c.anos[0] && +atual <= c.anos[1]) sel.value = atual;
    $('mb2008').hidden = $('mbCol').value !== 'm30';
  }
  async function ler(colK, ano) {
    const f = farm(), c = COL[colK], k = `${f.id}|${colK}|${ano}`;
    if (cache.has(k)) return cache.get(k);
    const resDeg = c.res / 111320;
    const g = grid(f.polys, 4326, resDeg);
    const r = await lerRasters(c.url(ano), { bbox: g.bbox, width: g.W, height: g.H, resampleMethod: 'nearest', fillValue: 0, samples: [0] });
    const out = { g, cod: r[0], c, ano, colK };
    cache.set(k, out); return out;
  }
  function resumo(m) {
    const { g, cod } = m, f = farm();
    const lat = (g.bbox[1] + g.bbox[3]) / 2, pxHa = Math.pow(g.res * 111320, 2) * Math.cos(lat * Math.PI / 180) / 1e4;
    const porClasse = {}, porGrupo = {}; let tot = 0;
    const nd = f.divs ? f.divs.length : 0, divs = Array.from({ length: nd }, () => ({}));
    for (let i = 0; i < cod.length; i++) {
      if (!g.mask[i] || !cod[i]) continue; tot++;
      const v = cod[i]; porClasse[v] = (porClasse[v] || 0) + 1;
      const gr = (CL[v] || [, , 'nv'])[2]; porGrupo[gr] = (porGrupo[gr] || 0) + 1;
      if (g.div && g.div[i]) { const d = divs[g.div[i] - 1]; d[gr] = (d[gr] || 0) + 1; d._t = (d._t || 0) + 1; }
    }
    return { tot, pxHa, porClasse, porGrupo, divs };
  }
  function desenhar(m, destaque) {
    const { g, cod } = m, cv = document.createElement('canvas'); cv.width = g.W; cv.height = g.H;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(g.W, g.H), d = img.data;
    for (let i = 0; i < cod.length; i++) {
      if (!g.mask[i] || !cod[i]) continue;
      let c = hex((CL[cod[i]] || [, '#888888'])[1]);
      if (destaque) c = destaque[i] ? [230, 30, 30] : c.map(x => Math.round(x * 0.45 + 140 * 0.55));
      const o = i * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL('image/png');
  }
  async function verUso() {
    const f = farm(); if (!f) return;
    const colK = $('mbCol').value, ano = +$('mbAno').value;
    $('mbBtn').disabled = true; busy(true, `Lendo MapBiomas ${ano}…`);
    try {
      const m = await ler(colK, ano), R = resumo(m);
      if (!R.tot) throw new Error('sem dados do MapBiomas para esta área');
      const classes = Object.entries(R.porClasse).sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ v: +v, n, nome: (CL[v] || ['Classe ' + v])[0], cor: (CL[v] || [, '#888'])[1], pct: n / R.tot * 100, ha: n * R.pxHa }));
      const grupos = Object.entries(R.porGrupo).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ nome: GRUPO[k][0], cor: GRUPO[k][1], pct: n / R.tot * 100, ha: n * R.pxHa }));
      mostrarCamadaExtra(desenhar(m), m.g.bounds, { titulo: `Uso do solo ${ano} · MapBiomas ${m.c.res} m`, itens: classes.filter(c => c.pct >= 0.5).map(c => ({ cor: c.cor, nome: c.nome, valor: fmt(c.pct, 0) + '%' })) });
      let divHTML = '';
      if (f.divs && f.divs.length) {
        divHTML = '<h4 style="margin-top:12px">Por divisão</h4>' + tabelaHTML(['Divisão', 'Uso principal', 'Pasto', 'Nativa'], f.divs.map((dv, k) => {
          const d = R.divs[k], t = d._t || 0; if (!t) return [esc(dv.nome), '—', '—', '—'];
          const top = Object.entries(d).filter(([g]) => g !== '_t').sort((a, b) => b[1] - a[1])[0];
          return [esc(dv.nome), `${GRUPO[top[0]][0]} (${fmt(top[1] / t * 100, 0)}%)`, fmt((d.pas || 0) / t * 100, 0) + '%', fmt((d.nat || 0) / t * 100, 0) + '%'];
        }));
      }
      S.usoSolo = { ano, col: m.c.cit, grupos, classes };
      $('mbRes').hidden = false;
      $('mbRes').innerHTML = `<h4>${esc(f.name)} · ${ano}</h4>${barrasHTML(grupos.map(g => ({ nome: g.nome, cor: g.cor, pct: g.pct })))}
        ${tabelaHTML(['Classe', 'ha', '%'], classes.filter(c => c.pct >= 0.2).map(c => [`<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${c.cor}"></span> ${c.nome}`, fmt(c.ha, c.ha < 10 ? 1 : 0), fmt(c.pct, 1)]))}
        ${divHTML}<p class="hint">Fonte: ${m.c.cit} (${m.c.res} m). Classificação automática por satélite: confira em campo antes de usar em laudo.</p>`;
    } catch (e) {
      console.error(e);
      $('mbRes').hidden = false;
      $('mbRes').innerHTML = `<p class="hint">Não consegui ler o MapBiomas: ${esc(e.message)}. ${(typeof CONF !== 'undefined' && CONF.proxy) ? '' : 'Se continuar, o servidor-ponte resolve (⚙ Configurações).'}</p>`;
    } finally { $('mbBtn').disabled = false; busy(false); }
  }
  async function desde2008() {
    const f = farm(); if (!f) return;
    const fim = COL.m30.anos[1];
    $('mb2008').disabled = true; busy(true, `Comparando 2008 com ${fim}…`);
    try {
      const [a, b] = await Promise.all([ler('m30', 2008), ler('m30', fim)]);
      const R = resumo(a), nat = v => (CL[v] || [, , ''])[2] === 'nat';
      let nat08 = 0, natHoje = 0, perdida = 0, ganho = 0; const dest = new Uint8Array(a.cod.length);
      for (let i = 0; i < a.cod.length; i++) {
        if (!a.g.mask[i] || !a.cod[i] || !b.cod[i]) continue;
        const n0 = nat(a.cod[i]), n1 = nat(b.cod[i]);
        if (n0) nat08++; if (n1) natHoje++;
        if (n0 && !n1) { perdida++; dest[i] = 1; }
        if (!n0 && n1) ganho++;
      }
      const h = n => n * R.pxHa;
      mostrarCamadaExtra(desenhar(b, dest), b.g.bounds, { titulo: `Vegetação nativa perdida de 2008 a ${fim}`, itens: [{ cor: '#e61e1e', nome: 'nativa em 2008, outro uso hoje', valor: `${fmt(h(perdida), 1)} ha` }] });
      $('mbRes').hidden = false;
      $('mbRes').innerHTML = `<h4>Mudanças desde 22/07/2008 (marco do Código Florestal)</h4>
        <div class="kpis">
          <div class="kpi"><b>${fmt(h(nat08), 1)} ha</b><span>nativa em 2008</span></div>
          <div class="kpi"><b>${fmt(h(natHoje), 1)} ha</b><span>nativa em ${fim}</span></div>
          <div class="kpi"><b>${fmt(h(perdida), 1)} ha</b><span>nativa convertida</span></div>
        </div>
        <p class="hint">${perdida > 0 ? `Em vermelho no mapa: áreas que eram vegetação nativa em 2008 e hoje têm outro uso. Supressão depois de 2008 sem autorização pode gerar passivo ambiental; confira com o PRODES (aba Situação) e com as autorizações do órgão ambiental.` : 'Nenhuma conversão de vegetação nativa detectada depois de 2008.'} ${ganho > 0 ? `Regeneração detectada: ${fmt(h(ganho), 1)} ha.` : ''} Fonte: MapBiomas Coleção 10 (30 m).</p>`;
      S.usoSolo = Object.assign(S.usoSolo || {}, { desde2008: { nat08: h(nat08), natHoje: h(natHoje), perdida: h(perdida), fim } });
    } catch (e) { console.error(e); toast('Não consegui comparar: ' + e.message, 6000); }
    finally { $('mb2008').disabled = false; busy(false); }
  }
  window.MB = { COL, CL, GRUPO, ler, resumo, desenhar };
  $('mbCol').onchange = preencherAnos;
  $('mbBtn').onclick = verUso;
  $('mb2008').onclick = desde2008;
  preencherAnos();
  const _ofc = window.onFarmChange;
  window.onFarmChange = f => { _ofc && _ofc(f); S.usoSolo = null; $('mbRes').hidden = true; $('mbRes').innerHTML = ''; };
})();
