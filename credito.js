/* AgroSat — crédito rural registrado no Sicor (Banco Central).
   A base fica no próprio site (data/sicor/), gerada todo mês pelo GitHub Actions a partir
   dos dados abertos do BCB (ferramentas/sicor_glebas.py). O app baixa só os blocos que
   tocam a fazenda e cruza as glebas financiadas com o perímetro. */
'use strict';

const SICOR = {
  meta: null,
  blocos: new Map(),
  async carregarMeta() {
    if (this.meta) return this.meta;
    const r = await fetch('data/sicor/meta.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('a base do Banco Central ainda não foi gerada no site (veja a aba Actions do GitHub)');
    this.meta = await r.json();
    this.meta.set = new Set(this.meta.blocos);
    return this.meta;
  },
  async bloco(k) {
    if (!this.blocos.has(k)) this.blocos.set(k, fetch(`data/sicor/t/${k}.json?v=${this.meta.gerado}`).then(r => r.ok ? r.json() : null).catch(() => null));
    return this.blocos.get(k);
  },
};

// Glebas do Sicor que tocam o retângulo b = [oeste, sul, leste, norte]
async function creditoNaArea(b) {
  const m = await SICOR.carregarMeta(), t = m.tile;
  const ks = [];
  for (let ix = Math.floor(b[0] / t); ix <= Math.floor(b[2] / t); ix++)
    for (let iy = Math.floor(b[1] / t); iy <= Math.floor(b[3] / t); iy++)
      if (m.set.has(`${ix}_${iy}`)) ks.push(`${ix}_${iy}`);
  const vistos = new Set(), feats = [];
  for (const bl of await Promise.all(ks.map(k => SICOR.bloco(k)))) {
    if (!bl) continue;
    for (const [oid, ind, polys] of bl.g) {
      const id = oid + '/' + ind;
      if (vistos.has(id)) continue; vistos.add(id);
      const ft = { type: 'Feature', properties: { ...(bl.ops[oid] || {}), oid, gleba: ind }, geometry: polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys } };
      const bb = turf.bbox(ft);
      if (bb[2] < b[0] || bb[0] > b[2] || bb[3] < b[1] || bb[1] > b[3]) continue;
      feats.push(ft);
    }
  }
  return { meta: m, feats, coberto: m.ufs };
}

const moeda = v => v == null ? '—' : 'R$ ' + fmt(v, 0);
const cap1 = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
function creditoDescricao(p) {
  const fin = cap1(p.fin || ''), resto = [p.ativ, p.mod, p.prod].filter(x => x && !/não se aplica/i.test(x));
  return [fin, resto.join(' · ')].filter(Boolean).join(': ') || 'não informado';
}

// Analisa o resultado (mesmo formato dos outros cartões da aba Situação)
function analisarCredito(res, F) {
  const hoje = isoDay(new Date()), areaF = turf.area(F) / 1e4;
  const porOp = new Map();
  for (const ft of res.feats) {
    const oh = interHa(F, ft);
    const ag = turf.area(ft) / 1e4;
    // ignora toques de borda: precisa de 0,5 ha ou 10% da gleba dentro da fazenda
    if (!(oh >= 0.5 || (ag > 0 && oh / ag >= 0.1))) continue;
    const p = ft.properties, o = porOp.get(p.oid) || { p, oh: 0, ag: 0, fts: [] };
    o.oh += oh; o.ag += ag; o.fts.push(ft); porOp.set(p.oid, o);
  }
  const ops = [...porOp.values()].map(o => ({ ...o, vigor: o.p.venc ? o.p.venc >= hoje : null }))
    .sort((a, b) => String(b.p.emissao || '').localeCompare(String(a.p.emissao || '')));
  const ativas = ops.filter(o => o.vigor), vencidas = ops.filter(o => o.vigor === false);
  const anos = res.meta.anos.length ? `${res.meta.anos[0]} a ${res.meta.anos[res.meta.anos.length - 1]}` : '';
  const aviso = `Base Sicor/BCB (${anos}, atualizada em ${dBR(res.meta.gerado)}). Só aparecem operações que tiveram a área georreferenciada; muito crédito de pecuária e investimento não traz gleba. Penhor e hipoteca constam apenas na matrícula do imóvel.`;
  let nivel = 'ok', resumo;
  if (!ops.length) resumo = 'Nenhuma área financiada com crédito rural registrada no Sicor sobre a fazenda. Isso <b>não garante</b> que o imóvel não tenha financiamento.';
  else {
    nivel = ativas.length ? 'alerta' : 'info';
    const soma = l => l.reduce((s, o) => s + (o.p.valor || 0), 0);
    resumo = ativas.length
      ? `<b>${ativas.length} operação(ões) de crédito rural com vencimento futuro</b> sobre a fazenda (${moeda(soma(ativas))}), a mais recente pelo ${esc(ativas[0].p.banco || 'banco não informado')}.`
      : 'Nenhuma operação com vencimento futuro sobre a fazenda.';
    if (vencidas.length) resumo += ` ${vencidas.length} operação(ões) já vencida(s) no histórico (${moeda(soma(vencidas))}).`;
    resumo += ' O valor é o contratado; a base não mostra quanto já foi pago.';
  }
  const linhas = ops.map(o => [
    o.p.emissao ? dBR(o.p.emissao) : '—',
    o.p.venc ? `${dBR(o.p.venc)}${o.vigor ? ' <b>(em vigor)</b>' : ''}` : '—',
    esc(o.p.banco || '—'),
    esc(creditoDescricao(o.p)) + (o.p.prog ? `<br><small>${esc(o.p.prog)}</small>` : ''),
    moeda(o.p.valor),
    `${ha(Math.min(o.oh, areaF))}${o.p.area ? ` de ${ha(o.p.area)}` : ''}`,
  ]);
  return {
    nivel, resumo, ops,
    detalhes: (linhas.length ? tabela(['Emissão', 'Vencimento', 'Banco', 'Finalidade', 'Valor contratado', 'Gleba na fazenda'], linhas) : '') + `<p class="hint">${aviso}</p>`,
  };
}

RENDER.credito = (res, F) => {
  const out = analisarCredito(res, F);
  camada(out.ops.flatMap(o => o.fts), { color: '#4fc3f7', weight: 2, dashArray: '6 4', fillColor: '#4fc3f7', fillOpacity: .15 },
    ft => `<b>Crédito rural (Sicor)</b><br>${esc(ft.properties.banco || '')}<br>${esc(creditoDescricao(ft.properties))}<br>${ft.properties.emissao ? dBR(ft.properties.emissao) : ''}${ft.properties.venc ? ' → ' + dBR(ft.properties.venc) : ''}<br>${moeda(ft.properties.valor)}`);
  delete out.ops;
  return out;
};
