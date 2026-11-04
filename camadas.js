/* AgroSat — camadas extras no mapa (uso do solo, declividade) e legenda usada também no "Gerar imagem". */
'use strict';
function mostrarCamadaExtra(dataURL, bounds, legenda) {
  if (S.overlay) S.overlay.remove();
  S.overlay = L.imageOverlay(dataURL, bounds, { opacity: 0.9, className: 'pix' }).addTo(map);
  if (S.outline) S.outline.bringToFront();
  S.extra = { dataURL, bounds, legenda };
  $('layerbar').hidden = true;
  $('legend').hidden = false;
  $('legend').innerHTML = `<b>${legenda.titulo}</b>` + (legenda.itens || []).map(i =>
    `<div class="ends"><span><i style="display:inline-block;width:10px;height:10px;background:${i.cor};border-radius:2px;border:1px solid #0003"></i> ${i.nome}</span><span>${i.valor || ''}</span></div>`).join('');
}
// volta para a imagem de satélite ao sair das abas de uso do solo / terreno
function voltarParaSatelite() {
  if (!S.extra) return;
  S.extra = null;
  if (S.result) showLayer(); else { if (S.overlay) { S.overlay.remove(); S.overlay = null; } $('legend').hidden = true; }
}
// legenda atual (para o "Gerar imagem")
function legendaAtual() {
  if (S.extra) return S.extra.legenda;
  const r = S.result; if (!r) return null;
  if (S.layer === 'rgb') return { titulo: `Cor real · ${fonteDe(r.it).curto}`, itens: [] };
  if (S.layer === 'diff') return { titulo: 'Variação do NDVI', grad: RAMP_DIFF, ponta: ['caiu −0,3', 'subiu +0,3'] };
  if (S.layer === 'zonas') return { titulo: 'Zonas de atenção', itens: [{ cor: '#ff28c8', nome: 'NDVI bem abaixo da média da área' }] };
  const nd = S.layer === 'ndre';
  return { titulo: `${nd ? 'NDRE' : 'NDVI'} — vigor da vegetação`, grad: nd ? RAMP_NDRE : RAMP_NDVI, ponta: ['pouca', 'muita'], itens: [{ cor: '#c8c8c8', nome: 'nuvem/sombra' }] };
}
// tabela simples por divisão
function tabelaHTML(cab, linhas) { return `<table class="tb"><tr>${cab.map(c => `<th>${c}</th>`).join('')}</tr>${linhas.map(l => `<tr>${l.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`; }
// barra horizontal de porcentagem
function barrasHTML(itens) {
  return `<div class="bars">${itens.map(i => `<div class="bar"><span>${i.nome}</span><div class="trk"><i style="width:${Math.min(100, i.pct)}%;background:${i.cor}"></i></div><span>${fmt(i.pct, i.pct < 10 ? 1 : 0)}%</span></div>`).join('')}</div>`;
}
