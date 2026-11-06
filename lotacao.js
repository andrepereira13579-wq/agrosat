/* AgroSat — Capacidade de suporte (UA/ha) e balanço forrageiro mês a mês.
   Produção de capim = taxa de acúmulo do capim nas águas × adubação × chuva do mês (climatologia de 35 anos)
   × área efetiva de pasto de cada piquete (classificação da cobertura pelo Sentinel-2).
   Capacidade = produção aproveitada (eficiência de pastejo) ÷ consumo da UA (450 kg, 2,5% do peso em MS/dia). */
'use strict';

const CAPINS = {
  marandu: ['Braquiarão / Marandu (B. brizantha)', 55],
  xaraes: ['Xaraés / Piatã / Paiaguás', 60],
  decumbens: ['Braquiarinha (B. decumbens)', 45],
  humidicola: ['Humidícola / Quicuio-da-amazônia', 35],
  mombaca: ['Mombaça / Tanzânia (Panicum)', 75],
  massai: ['Massai / Zuri / Quênia', 60],
  andropogon: ['Andropogon', 45],
  nativo: ['Pasto nativo ou misturado', 20],
};
const ADUB = { nenhuma: ['Sem adubação de manutenção', 1], moderada: ['Adubação moderada', 1.4], alta: ['Adubação alta (intensivo)', 1.9] };
const SISTEMA = { continuo: ['Pastejo contínuo', 0.5], rotacionado: ['Pastejo rotacionado', 0.65] };
const CENARIO = { normal: ['Ano normal (média)', 'chuva'], seco: ['Ano seco (2 em cada 10 anos)', 'p10'], chuvoso: ['Ano chuvoso', 'p90'] };
const CATEGORIAS = [['vacas', 'Vacas', 420], ['touros', 'Touros', 650], ['novilhas', 'Novilhas', 300], ['bois', 'Garrotes / bois', 350], ['bezerros', 'Bezerros(as)', 150]];
const UA_KG = 450, CONSUMO = UA_KG * 0.025;              // 11,25 kg MS por UA por dia
const PERDA_MES = 0.15;                                   // sobra das águas que se perde por mês (seca, pisoteio)
const DIAS_MES = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// fração de cada classe da cobertura que conta como pasto produtivo
const EFETIVA = { 4: 1, 5: 0.45, 2: 0.5, 3: 0.5 };

function lotPadrao() { return { capim: 'marandu', adub: 'nenhuma', sistema: 'continuo', cenario: 'normal', rebanho: {} }; }
function uaRebanho(reb) {
  let ua = 0, cab = 0;
  CATEGORIAS.forEach(([k, , pPad]) => { const r = reb[k] || {}; const n = +r.n || 0, p = +r.p || pPad; ua += n * p / UA_KG; cab += n; });
  return { ua, cab };
}

// área efetiva de pasto (ha) da fazenda e de cada divisão, a partir da classificação da cobertura
function pastoEfetivo(cob) {
  const pxHa = cob.g.res * cob.g.res / 1e4, nd = cob.divs.length, tot = { ef: 0, pasto: 0 }, div = Array.from({ length: nd }, () => ({ ef: 0, pasto: 0 }));
  const { cls, g } = cob;
  for (let k = 0; k < cls.length; k++) {
    const e = EFETIVA[cls[k]]; if (e == null) continue;
    tot.ef += e * pxHa; tot.pasto += pxHa;
    if (g.div && g.div[k]) { div[g.div[k] - 1].ef += e * pxHa; div[g.div[k] - 1].pasto += pxHa; }
  }
  return { tot, div: div.map((d, i) => ({ ...d, nome: cob.divs[i].nome })) };
}

function calcularLotacao(f, cob, clima, op) {
  op = Object.assign(lotPadrao(), op || {});
  const taxa = CAPINS[op.capim][1] * ADUB[op.adub][1], efic = SISTEMA[op.sistema][1], campo = CENARIO[op.cenario][1];
  const P = clima.meses.map(m => m[campo]);
  const fAgua = P.map((p, m) => Math.max(0.12, Math.min(1, (0.65 * p + 0.35 * P[(m + 11) % 12]) / 120)));
  const fTemp = clima.meses.map(m => Math.max(0, Math.min(1, (m.tmed - 15) / 10)));
  const kgHaMes = MESES.map((_, m) => taxa * fAgua[m] * fTemp[m] * DIAS_MES[m]);      // kg MS por ha efetivo
  const PE = pastoEfetivo(cob), haEf = PE.tot.ef;
  const prod = kgHaMes.map(v => v * haEf);                                             // kg MS/mês na fazenda
  const capUA = prod.map((v, m) => v * efic / (CONSUMO * DIAS_MES[m]));
  const { ua, cab } = uaRebanho(op.rebanho || {});
  // balanço com sobra que passa de um mês para o outro (roda 2 anos para estabilizar o estoque)
  const meses = MESES.map((nome, m) => ({ nome, chuva: P[m], prodT: prod[m] / 1000, capUA: capUA[m], demT: ua * CONSUMO * DIAS_MES[m] / 1000, ofertaT: 0, deficitT: 0, sobraT: 0 }));
  let est = 0;
  for (let volta = 0; volta < 2; volta++) for (let m = 0; m < 12; m++) {
    const x = meses[m], entra = x.prodT * efic, disp = est * (1 - PERDA_MES) + entra;
    x.ofertaT = disp; const saldo = disp - x.demT;
    x.deficitT = saldo < 0 ? -saldo : 0; est = saldo > 0 ? saldo : 0; x.sobraT = est;
  }
  const capMedia = capUA.reduce((s, v) => s + v, 0) / 12, capAguas = Math.max(...capUA), capSeca = Math.min(...capUA);
  const deficitT = meses.reduce((s, x) => s + x.deficitT, 0);
  const mesesDeficit = meses.filter(x => x.deficitT > 0.05).map(x => x.nome);
  // capacidade que o balanço fecha o ano sem déficit (considerando a sobra das águas)
  let lo = 0, hi = capAguas * 1.5 + 1;
  for (let it = 0; it < 30; it++) {
    const mid = (lo + hi) / 2; let e = 0, falta = false;
    for (let volta = 0; volta < 2; volta++) for (let m = 0; m < 12; m++) { const d = e * (1 - PERDA_MES) + meses[m].prodT * efic - mid * CONSUMO * DIAS_MES[m] / 1000; if (d < 0 && volta) falta = true; e = Math.max(0, d); }
    if (falta) hi = mid; else lo = mid;
  }
  const capAno = lo;
  const divs = PE.div.map(d => {
    const prodAno = kgHaMes.reduce((s, v) => s + v, 0) * d.ef;
    const ua = m => kgHaMes[m] * d.ef * efic / (CONSUMO * DIAS_MES[m]);
    const uas = MESES.map((_, m) => ua(m));
    return { nome: d.nome, pasto: d.pasto, ef: d.ef, kgHaAno: d.pasto ? prodAno / d.pasto : 0, uaAguas: Math.max(...uas), uaSeca: Math.min(...uas), haArea: null };
  });
  return {
    op, taxa, efic, haPasto: PE.tot.pasto, haEf, area: f.area, kgHaAno: haEf ? prod.reduce((s, v) => s + v, 0) / PE.tot.pasto : 0,
    capMedia, capAguas, capSeca, capAno, ua, cab, meses, deficitT, mesesDeficit, divs,
    primeiroDeficit: mesesDeficit.length ? meses.findIndex((x, i) => x.deficitT > 0.05 && meses[(i + 11) % 12].deficitT <= 0.05) : -1,
  };
}

const NOTA_LOTACAO = 'Estimativa: taxa de acúmulo típica de cada capim nas águas (valores de referência para pastagens tropicais com o manejo informado), reduzida pela chuva de cada mês (série de 35 anos da fazenda) e pela condição do pasto vista no satélite (pasto degradado conta 45%, juquira 50%). UA = 450 kg; consumo de 2,5% do peso em matéria seca por dia; aproveitamento de 50% no contínuo e 65% no rotacionado; a sobra das águas passa para o mês seguinte perdendo 15% ao mês; na seca o capim cresce no mínimo 12% do ritmo das águas. Confirme com medição de forragem (altura do pasto ou quadrado) e ajuste a lotação pelo comportamento do pasto.';

function lotacaoHTML(L, tab, barras) {
  const fmtT = v => fmt(v, v < 10 ? 1 : 0);
  const sit = L.ua ? (L.ua > L.capAno * 1.05 ? `<b style="color:#e8452c">Sobrecarga de ${fmt((L.ua / L.capAno - 1) * 100, 0)}%</b> sobre o que o pasto sustenta no ano` : L.ua < L.capAno * 0.8 ? `<b style="color:#2fd37a">Folga de ${fmt((1 - L.ua / L.capAno) * 100, 0)}%</b>: o pasto aguenta mais animais` : '<b>Rebanho dentro da capacidade</b>') : 'Informe o rebanho para ver o balanço.';
  const eq = L.deficitT > 0 ? `<p>Para cobrir o déficit de <b>${fmtT(L.deficitT)} t de matéria seca</b> (${L.mesesDeficit.join(', ')}): cerca de <b>${fmtT(L.deficitT / 0.33)} t de silagem de milho</b>, ou ${fmtT(L.deficitT / 0.30)} t de cana picada, ou ${fmtT(L.deficitT / 0.88)} t de feno. Outra saída: reduzir a carga para cerca de ${fmt(L.capAno, 0)} UA antes da seca${L.primeiroDeficit >= 0 ? `, ou começar o volumoso em <b>${MESES[L.primeiroDeficit]}</b>` : ''}.</p>` : (L.ua ? '<p>O pasto cobre o rebanho o ano todo neste cenário, contando a sobra das águas.</p>' : '');
  return { sit, eq, fmtT };
}

(function () {
  const box = $('lotForm'); if (!box) return;
  const sel = (id, obj) => { $(id).innerHTML = Object.entries(obj).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join(''); };
  sel('lotCapim', CAPINS); sel('lotAdub', ADUB); sel('lotSistema', SISTEMA); sel('lotCenario', CENARIO);
  $('lotRebanho').innerHTML = CATEGORIAS.map(([k, nome, p]) => `<div class="lotcat"><span>${nome}</span><input type="number" inputmode="numeric" min="0" placeholder="cabeças" data-cat="${k}" data-c="n"><input type="number" inputmode="numeric" min="0" placeholder="${p} kg" data-cat="${k}" data-c="p"></div>`).join('') + '<p class="hint" id="lotUA"></p>';
  const ler = () => {
    const op = { capim: $('lotCapim').value, adub: $('lotAdub').value, sistema: $('lotSistema').value, cenario: $('lotCenario').value, rebanho: {} };
    $('lotRebanho').querySelectorAll('input').forEach(i => { const c = i.dataset.cat; op.rebanho[c] = op.rebanho[c] || {}; if (i.value) op.rebanho[c][i.dataset.c] = +i.value; });
    return op;
  };
  const mostrarUA = () => { const { ua, cab } = uaRebanho(ler().rebanho); $('lotUA').textContent = cab ? `${cab} cabeças = ${fmt(ua, 1)} UA (450 kg)` : 'Deixe em branco o que não tiver. Peso médio em branco usa o valor cinza.'; };
  const preencher = f => {
    const op = Object.assign(lotPadrao(), (f && f.lot) || {});
    $('lotCapim').value = op.capim; $('lotAdub').value = op.adub; $('lotSistema').value = op.sistema; $('lotCenario').value = op.cenario;
    $('lotRebanho').querySelectorAll('input').forEach(i => { const r = (op.rebanho || {})[i.dataset.cat] || {}; i.value = r[i.dataset.c] || ''; });
    mostrarUA(); $('lotRes').hidden = true;
  };
  box.addEventListener('input', mostrarUA);
  const _ofc = window.onFarmChange;
  window.onFarmChange = f => { _ofc && _ofc(f); preencher(f); };
  preencher(farm());

  $('lotBtn').onclick = async () => {
    const f = farm(); if (!f) return;
    f.lot = ler(); saveFarms();
    $('lotBtn').disabled = true;
    try {
      const cob = S.cobertura && S.cobertura.fazenda === f.id ? S.cobertura : await classificarCobertura(f, t => busy(true, 'Condição do pasto · ' + t));
      cob.fazenda = f.id;
      busy(true, 'Chuva dos últimos 35 anos…');
      const c = turf.centroid(farmFeature(f)).geometry.coordinates;
      S.climaLot = S.climaLot && S.climaLot.id === f.id ? S.climaLot : { id: f.id, C: await climatologia(c[0], c[1]) };
      const L = calcularLotacao(f, cob, S.climaLot.C, f.lot);
      S.lotacao = { id: f.id, L };
      busy(false);
      const { sit, eq, fmtT } = lotacaoHTML(L);
      const mx = Math.max(...L.meses.map(x => Math.max(x.ofertaT, x.demT)), 1);
      const graf = `<div class="lotgraf">${L.meses.map(x => `<div class="lotcol" title="${x.nome}"><div class="lotbar" style="height:${x.ofertaT / mx * 100}%"></div>${L.ua ? `<div class="lotdem" style="bottom:${x.demT / mx * 100}%"></div>` : ''}${x.deficitT > 0.05 ? '<i class="lotdef"></i>' : ''}<span>${x.nome[0].toUpperCase()}</span></div>`).join('')}</div><p class="hint">Barra verde: capim aproveitável no mês (t MS: a parte que o gado consegue colher, mais a sobra do mês anterior). Linha branca: consumo do rebanho. Ponto vermelho: mês com déficit.</p>`;
      $('lotRes').hidden = false;
      $('lotRes').innerHTML = `<h4>${esc(f.name)} · ${CAPINS[L.op.capim][0]} · ${CENARIO[L.op.cenario][0].toLowerCase()}</h4>
        <div class="kpis">
          <div class="kpi"><b>${fmt(L.capAno, 0)} UA</b><span>sustenta no ano (${fmt(L.capAno / Math.max(L.haPasto, 0.01), 2)} UA/ha de pasto)</span></div>
          <div class="kpi"><b>${fmt(L.capAguas / Math.max(L.haPasto, 0.01), 2)}</b><span>UA/ha no pico das águas</span></div>
          <div class="kpi"><b>${fmt(L.capSeca / Math.max(L.haPasto, 0.01), 2)}</b><span>UA/ha no pior mês da seca</span></div>
          <div class="kpi"><b>${L.ua ? fmt(L.ua, 0) + ' UA' : '—'}</b><span>rebanho atual${L.ua ? ` (${fmt(L.ua / Math.max(L.haPasto, 0.01), 2)} UA/ha)` : ''}</span></div>
          <div class="kpi"><b>${fmt(L.haPasto, 1)} ha</b><span>de pasto (${fmt(L.haEf, 1)} ha efetivos)</span></div>
          <div class="kpi"><b>${fmt(L.kgHaAno / 1000, 1)} t</b><span>MS/ha/ano estimadas</span></div>
        </div>
        <p>${sit}</p>
        <h4>Balanço forrageiro</h4>${graf}${eq}
        ${tabelaHTML(['Mês', 'Chuva', 'Produção', 'Aproveitável', 'Consumo', 'Déficit'], L.meses.map(x => [x.nome, fmt(x.chuva, 0) + ' mm', fmtT(x.prodT) + ' t', fmtT(x.ofertaT) + ' t', L.ua ? fmtT(x.demT) + ' t' : '—', x.deficitT > 0.05 ? `<b style="color:#e8452c">${fmtT(x.deficitT)} t</b>` : '—']))}
        ${L.divs.length ? `<h4>Por piquete</h4>${tabelaHTML(['Divisão', 'Pasto', 'Efetivo', 'UA águas', 'UA seca'], L.divs.map(d => [esc(d.nome), fmt(d.pasto, 1) + ' ha', fmt(d.ef, 1) + ' ha', fmt(d.uaAguas, 1), fmt(d.uaSeca, 1)]))}` : ''}
        <p class="hint">${NOTA_LOTACAO}</p>`;
    } catch (e) { busy(false); toast('Não consegui calcular: ' + e.message, 6000); }
    finally { $('lotBtn').disabled = false; }
  };
})();
