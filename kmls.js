/* AgroSat — KMLs guardados no site: baixar ou cadastrar com um toque. */
'use strict';
(function () {
  const lista = window.AGROSAT_KMLS || [];
  if (!lista.length) return;
  const html = titulo => `<h4>${titulo}</h4>` + lista.map((k, i) => `<div class="kmlrow"><span>📍 ${esc(k.nome)}</span>
    <a class="btn ghost sm" href="${k.arquivo}" download>⬇ Baixar</a>
    <button type="button" class="btn sm" data-k="${i}">Cadastrar</button></div>`).join('');
  $('kmlsVazio').innerHTML = html('KMLs salvos no site');
  $('kmlsModal').innerHTML = html('Ou use um KML salvo no site');
  async function cadastrar(i) {
    const k = lista[i];
    try {
      busy(true, `Carregando ${k.nome}…`);
      const r = await fetch(k.arquivo); if (!r.ok) throw new Error('arquivo não encontrado');
      const file = new File([await r.blob()], k.arquivo.split('/').pop());
      const polys = await readPerimeter(file);
      const ja = S.farms.find(f => f.name === k.nome);
      if (ja) { $('farmModal').hidden = true; selectFarm(ja.id); toast(`${k.nome} já estava cadastrada.`); return; }
      $('farmModal').hidden = true;
      criarFazenda({ name: k.nome, owner: '', uf: ($('fmUF') && $('fmUF').value) || 'MA' }, polys);
    } catch (e) { toast('Não consegui carregar ' + k.nome + ': ' + e.message, 6000); }
    finally { busy(false); }
  }
  document.addEventListener('click', e => { const b = e.target.closest('.kmls button[data-k]'); if (b) cadastrar(+b.dataset.k); });
})();
