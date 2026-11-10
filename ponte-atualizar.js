/* AgroSat — avisa quando o servidor-ponte (Cloudflare) está desatualizado e ajuda a atualizar:
   copia o código novo e abre o editor do worker no Cloudflare. O usuário só cola e publica (Deploy). */
'use strict';
(function () {
  const VERSAO_APP = 3;   // mesma VERSAO_PONTE de ponte/worker.js
  const EDITOR = 'https://dash.cloudflare.com/?to=/:account/workers/services/edit/agrosat-ponte/production';
  let codigo = null;

  async function carregarCodigo() {
    if (codigo) return codigo;
    const r = await fetch('ponte/worker.js?v=' + VERSAO_APP, { cache: 'no-store' });
    if (!r.ok) throw new Error('não achei o código da ponte');
    return (codigo = await r.text());
  }

  function atualizar(btn, msg) {
    const abrir = () => { window.open(EDITOR, '_blank'); };
    const pronto = () => {
      msg.innerHTML = '✅ <b>Código copiado.</b> No editor do Cloudflare que abriu: toque dentro do código, <b>Selecionar tudo</b>, <b>Colar</b> e depois <b>Deploy</b>. Volte aqui e recarregue o app.';
    };
    const falhou = () => {
      msg.innerHTML = 'Não consegui copiar sozinho. Toque e segure no quadro abaixo, Selecionar tudo, Copiar; depois abra o editor.<textarea readonly style="width:100%;height:90px;font:11px monospace;margin-top:6px">' + String(codigo || '').replace(/</g, '&lt;') + '</textarea><button type="button" class="btn">Abrir editor do Cloudflare</button>';
      msg.querySelector('button').onclick = abrir;
    };
    try {
      // copiar precisa acontecer dentro do toque (Safari): usa o texto já baixado
      if (codigo && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(codigo).then(pronto, falhou); abrir(); return;
      }
      if (navigator.clipboard && window.ClipboardItem) {
        navigator.clipboard.write([new ClipboardItem({ 'text/plain': carregarCodigo().then(t => new Blob([t], { type: 'text/plain' })) })]).then(pronto, () => carregarCodigo().then(falhou));
        abrir(); return;
      }
    } catch (e) { console.warn(e); }
    carregarCodigo().then(falhou, e => { msg.textContent = 'Erro: ' + e.message; });
  }

  function aviso(versaoPonte) {
    if (document.getElementById('ponteAviso')) return;
    const d = document.createElement('div');
    d.id = 'ponteAviso';
    d.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:9999;background:#fff8e1;color:#4a3b00;border:1px solid #f2c14e;border-radius:10px;padding:10px 12px;font:14px/1.4 system-ui;box-shadow:0 4px 16px rgba(0,0,0,.25)';
    d.innerHTML = `<b>Atualize o servidor-ponte</b> (versão ${versaoPonte || 'antiga'} → ${VERSAO_APP}). A nova libera o TerraClass (uso do solo e vegetação de 2008).
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn primary" id="ponteBtn">📋 Copiar código e abrir Cloudflare</button><button type="button" class="btn" id="ponteDepois">Depois</button></div><div id="ponteMsg" style="margin-top:6px;font-size:13px"></div>`;
    document.body.appendChild(d);
    document.getElementById('ponteBtn').onclick = e => atualizar(e.target, document.getElementById('ponteMsg'));
    document.getElementById('ponteDepois').onclick = () => d.remove();
  }

  async function verificar() {
    if (typeof CONF === 'undefined' || !CONF.proxy) return;
    try {
      const r = await fetch(CONF.proxy.replace(/\/+$/, '') + '/saude', { cache: 'no-store' });
      const j = await r.json();
      if (!(+j.versao >= VERSAO_APP)) { carregarCodigo().catch(() => { }); aviso(j.versao); }
    } catch (e) { /* ponte fora do ar: os outros avisos já tratam */ }
  }

  window.atualizarPonte = () => { carregarCodigo().catch(() => { }); aviso(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(verificar, 1500));
  else setTimeout(verificar, 1500);
})();
