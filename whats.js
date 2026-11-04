/* AgroSat — enviar resumo da fazenda pelo WhatsApp, com link que abre a mesma fazenda no app. */
'use strict';
(function () {
  // ---------- fazenda dentro do link (#fz=...) ----------
  const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const codRing = r => { let px = 0, py = 0; return r.map(([x, y]) => { const X = Math.round(x * 1e5), Y = Math.round(y * 1e5), d = [X - px, Y - py]; px = X; py = Y; return d; }).flat(); };
  const decRing = a => { const out = []; let x = 0, y = 0; for (let i = 0; i < a.length; i += 2) { x += a[i]; y += a[i + 1]; out.push([x / 1e5, y / 1e5]); } return out; };
  async function comprimir(txt) {
    const bytes = new TextEncoder().encode(txt);
    if (!window.CompressionStream) return 'j' + b64u(bytes);
    const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return 'z' + b64u(new Uint8Array(await new Response(s).arrayBuffer()));
  }
  async function descomprimir(cod) {
    const bytes = unb64u(cod.slice(1));
    if (cod[0] === 'j') return new TextDecoder().decode(bytes);
    const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(s).text();
  }
  async function linkDaFazenda(f) {
    const dados = { n: f.name, o: f.owner || '', u: f.uf || '', c: f.car || '', p: f.polys.map(p => p.map(codRing)), d: (f.divs || []).map(d => ({ n: d.nome, r: d.rings.map(codRing) })) };
    return location.origin + location.pathname + '#fz=' + await comprimir(JSON.stringify(dados));
  }
  async function abrirDoLink() {
    const m = location.hash.match(/^#fz=([jz][A-Za-z0-9_-]+)/); if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    try {
      const d = JSON.parse(await descomprimir(m[1]));
      const polys = d.p.map(p => p.map(decRing));
      const igual = S.farms.find(f => f.name === d.n && Math.abs(f.area - areaHa(polys)) < 0.05);
      if (igual) { selectFarm(igual.id); toast(`Abrindo ${igual.name}.`); }
      else {
        const f = { id: 'f' + Date.now().toString(36), name: d.n, owner: d.o, uf: d.u || 'MA', car: d.c || null, polys, divs: (d.d || []).map(x => ({ nome: x.n, rings: x.r.map(decRing) })), area: areaHa(polys), created: new Date().toISOString() };
        S.farms.push(f); selectFarm(f.id);
        toast(`${f.name} recebida: ${fmt(f.area, 1)} ha. Buscando imagens…`, 5000);
      }
      doSearch();
    } catch (e) { console.error(e); toast('Não consegui abrir a fazenda deste link.', 6000); }
  }

  // ---------- texto da mensagem ----------
  const txt = html => { const d = document.createElement('div'); d.innerHTML = html || ''; return d.textContent.replace(/\s+/g, ' ').trim(); };
  const ICONE = { ok: '✅', alerta: '⚠️', grave: '⛔', erro: '▫️', info: 'ℹ️' };
  async function mensagem(f) {
    const L = [];
    L.push(`*${f.name}*${f.owner ? ' — ' + f.owner : ''}`);
    L.push(`📐 ${fmt(f.area, f.area < 100 ? 1 : 0)} ha${f.uf ? ' · ' + f.uf : ''}${f.divs && f.divs.length ? ` · ${f.divs.length} divisões` : ''}`);
    if (f.car) L.push(`📄 CAR ${f.car}`);
    const r = S.result && !S.result.isDiff ? S.result : null;
    if (r && r.stats) {
      L.push('', `🛰️ *Vigor da vegetação (NDVI) — ${dBR(r.it.properties.datetime)}*`);
      L.push(`Média ${fmt(r.stats.mean)} · pior 10% ${fmt(r.stats.p10)} · melhor 10% ${fmt(r.stats.p90)}`);
      const ds = (r.divStats || []).filter(d => !d.fora && !Number.isNaN(d.ndvi)).sort((a, b) => a.ndvi - b.ndvi);
      if (ds.length) {
        L.push(`Mais fracas: ${ds.slice(0, 3).map(d => `${d.nome} (${fmt(d.ndvi)})`).join(', ')}`);
        if (ds.length > 3) L.push(`Mais fortes: ${ds.slice(-2).reverse().map(d => `${d.nome} (${fmt(d.ndvi)})`).join(', ')}`);
      }
    }
    if (S.seriesData && S.seriesData.length > 1) {
      const a = S.seriesData[0], z = S.seriesData[S.seriesData.length - 1];
      L.push(`📈 NDVI de ${fmt(a.ndvi)} (${dBR(a.date)}) para ${fmt(z.ndvi)} (${dBR(z.date)})`);
    }
    if (S.diag) {
      L.push('', '*Situação ambiental e fundiária*');
      for (const k of ['car', 'sigef', 'emb', 'prodes', 'fogo']) {
        const it = S.diag.itens[k]; if (!it || it.nivel === 'erro') continue;
        L.push(`${ICONE[it.nivel] || '•'} *${it.titulo}:* ${txt(it.resumo)}`);
      }
    }
    const cl = (typeof CL !== 'undefined' && CL.dados) ? CL.dados : (S.diag && S.diag.itens.clima && S.diag.itens.clima.dados);
    if (cl) {
      if (typeof CL !== 'undefined' && CL.dados) L.push('', `🌧️ Chuva de ${dBR(cl.ini)} a ${dBR(cl.fim)}: *${fmt(cl.chuva, 0)} mm* · ${cl.seco} dia(s) seguidos sem chuva · previsão 7 dias: ${fmt(cl.chuvaPrev, 0)} mm`);
      else L.push('', `🌧️ Chuva nos últimos 30 dias: *${fmt(cl.chuva30, 0)} mm* · ${cl.semChuva} dia(s) seguidos sem chuva · previsão 7 dias: ${fmt(cl.chuva7, 0)} mm`);
    }
    if (!r && !S.diag) L.push('', '_Abra o link para ver imagens de satélite e a situação da área._');
    L.push('', `🗺️ Ver a fazenda no mapa: ${await linkDaFazenda(f)}`);
    const c = CONF.consultor;
    if (c.nome || c.empresa) L.push('', `— ${[c.nome, c.empresa].filter(Boolean).join(' · ')}${c.contato ? ' · ' + c.contato : ''}`);
    L.push('_Dados públicos (Sentinel-2, CAR, SIGEF, IBAMA, INPE) consultados no AgroSat._');
    return L.join('\n');
  }

  // ---------- janela de envio ----------
  $('btnWhats').onclick = async () => {
    const f = farm(); if (!f) return;
    $('wzTexto').value = 'Montando a mensagem…'; $('wzModal').hidden = false;
    $('wzTexto').value = await mensagem(f);
  };
  $('wzCancel').onclick = () => $('wzModal').hidden = true;
  $('wzEnviar').onclick = () => {
    const num = $('wzNumero').value.replace(/\D/g, '');
    const fone = num ? (num.length <= 11 ? '55' + num : num) : '';
    const url = `https://wa.me/${fone}?text=${encodeURIComponent($('wzTexto').value)}`;
    const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
    $('wzModal').hidden = true;
  };
  $('wzCopiar').onclick = async () => {
    try { await navigator.clipboard.writeText($('wzTexto').value); toast('Mensagem copiada.'); }
    catch (e) { $('wzTexto').select(); toast('Selecione e copie o texto.'); }
  };

  abrirDoLink();
  window.addEventListener('hashchange', abrirDoLink);
  window.linkDaFazenda = linkDaFazenda;
})();
