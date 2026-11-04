/* AgroSat — abrir fazenda a partir de uma localização (link do Maps, WhatsApp, coordenadas ou GPS).
   Acha o imóvel do CAR que contém o ponto, cria a fazenda e já roda imagens e situação. */
'use strict';
(function () {
  // Retângulos aproximados dos estados: só para escolher em quais camadas do CAR procurar.
  const UF_BOX = {
    AC: [-74.0, -11.2, -66.6, -7.1], AL: [-38.3, -10.6, -35.1, -8.8], AM: [-73.8, -9.9, -56.0, 2.3], AP: [-54.9, -1.3, -49.8, 4.5],
    BA: [-46.7, -18.4, -37.3, -8.5], CE: [-41.5, -7.9, -37.2, -2.7], DF: [-48.3, -16.1, -47.3, -15.5], ES: [-41.9, -21.4, -39.6, -17.8],
    GO: [-53.3, -19.6, -45.9, -12.3], MA: [-48.8, -10.3, -41.7, -1.0], MG: [-51.1, -22.95, -39.8, -14.2], MS: [-58.2, -24.1, -50.9, -17.1],
    MT: [-61.7, -18.1, -50.2, -7.3], PA: [-58.9, -9.9, -46.0, 2.6], PB: [-38.8, -8.4, -34.7, -6.0], PE: [-41.4, -9.5, -34.8, -7.2],
    PI: [-45.95, -10.95, -40.3, -2.7], PR: [-54.7, -26.75, -48.0, -22.5], RJ: [-44.9, -23.4, -40.9, -20.7], RN: [-38.6, -6.99, -34.9, -4.8],
    RO: [-66.9, -13.7, -59.7, -7.9], RR: [-64.9, 0.9, -58.8, 5.3], RS: [-57.7, -33.8, -49.6, -27.0], SC: [-53.9, -29.4, -48.3, -25.9],
    SE: [-38.3, -11.6, -36.3, -9.5], SP: [-53.2, -25.4, -44.1, -19.7], TO: [-50.8, -13.5, -45.6, -5.1],
  };
  function ufsCandidatas(lon, lat) {
    return Object.entries(UF_BOX).filter(([, b]) => lon >= b[0] - .05 && lon <= b[2] + .05 && lat >= b[1] - .05 && lat <= b[3] + .05)
      .map(([uf, b]) => [uf, Math.hypot(lon - (b[0] + b[2]) / 2, lat - (b[1] + b[3]) / 2) / Math.hypot(b[2] - b[0], b[3] - b[1])])
      .sort((a, c) => a[1] - c[1]).map(x => x[0]);
  }
  const noBrasil = (lat, lon) => lat > -34.5 && lat < 6 && lon > -75 && lon < -28;

  // ---------- leitura da localização ----------
  function lerLocalizacao(txt) {
    if (!txt) return null;
    let s = String(txt).trim();
    try { s = decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { }
    const ok = (a, b) => {
      let lat = +String(a).replace(',', '.'), lon = +String(b).replace(',', '.');
      if (!isFinite(lat) || !isFinite(lon)) return null;
      if (!noBrasil(lat, lon) && noBrasil(lon, lat)) [lat, lon] = [lon, lat];
      return noBrasil(lat, lon) ? { lat, lon } : null;
    };
    let m;
    // links: ?q=lat,lon  ll=  query=  destination=  center=  @lat,lon  !3d lat !4d lon  geo:lat,lon
    const padroes = [
      /[?&](?:q|ll|sll|query|destination|daddr|center|loc)=(?:loc:)?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i,
      /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
      /@(-?\d+\.\d+),(-?\d+\.\d+)/,
      /geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i,
    ];
    for (const re of padroes) if ((m = s.match(re))) { const r = ok(m[1], m[2]); if (r) return r; }
    // graus, minutos e segundos: 3°44'04.1"S 46°03'38.2"W
    const dms = [...s.matchAll(/(\d{1,3})\s*[°º]\s*(\d{1,2})\s*['’′]\s*(\d{1,2}(?:[.,]\d+)?)\s*(?:["”″]|'')?\s*([NSLOEWnsloew])/g)];
    if (dms.length >= 2) {
      const v = x => { let g = +x[1] + +x[2] / 60 + +String(x[3]).replace(',', '.') / 3600; if (/[SOWsow]/.test(x[4])) g = -g; return { g, eixo: /[NSns]/.test(x[4]) ? 'lat' : 'lon' }; };
      const a = v(dms[0]), b = v(dms[1]);
      const lat = a.eixo === 'lat' ? a.g : b.g, lon = a.eixo === 'lon' ? a.g : b.g;
      const r = ok(lat, lon); if (r) return r;
    }
    // números decimais: "-3.7345, -46.0605"  ou  "-3,7345; -46,0605"  ou  "-3,7345 -46,0605"
    if ((m = s.match(/(-?\d{1,2}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)/))) { const r = ok(m[1], m[2]); if (r) return r; }
    if ((m = s.match(/(-?\d{1,2},\d+)\s*[;,]?\s+(-?\d{1,3},\d+)/)) || (m = s.match(/(-?\d{1,2},\d+)\s*;\s*(-?\d{1,3},\d+)/))) { const r = ok(m[1], m[2]); if (r) return r; }
    return null;
  }
  const linkCurto = s => /maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs|maps\.apple\.com\/\?.*auid/i.test(s);

  // ---------- busca do imóvel ----------
  let marcador = null;
  async function abrirPorPonto(lat, lon, origem) {
    if (marcador) marcador.remove();
    marcador = L.marker([lat, lon], { icon: L.divIcon({ className: '', html: '<div class="locpin"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }) }).addTo(map);
    map.setView([lat, lon], 15);
    const ufs = ufsCandidatas(lon, lat);
    if (!ufs.length) { toast('Esse ponto não parece estar no Brasil.'); return; }
    // já existe fazenda cadastrada nesse ponto?
    const ja = S.farms.find(f => f.polys.some(p => pip(lon, lat, p[0])));
    if (ja) { selectFarm(ja.id); toast(`Esse ponto fica na fazenda "${ja.name}", que já está cadastrada.`, 5000); rodarTudo(); return; }
    busy(true, `Procurando o imóvel no CAR (${ufs[0]})…`);
    try {
      let achou = null, uf = ufs[0], erro = null;
      for (const u of ufs) {
        busy(true, `Procurando o imóvel no CAR (${u})…`);
        try { const fs = await carNoPonto(lon, lat, u); if (fs.length) { achou = fs; uf = u; break; } }
        catch (e) { erro = e; }
      }
      if (!achou) {
        toast(erro ? 'Não consegui consultar o CAR agora: ' + erro.message : 'Nenhum imóvel do CAR contém esse ponto. Confira a localização ou cadastre por arquivo.', 7000);
        return;
      }
      const usar = ft => {
        const p = ft.properties, cod = pick(p, 'cod_imovel') || '';
        const mun = pick(p, 'municipio', 'nom_munici') || '';
        const nome = `Imóvel${mun ? ' em ' + mun : ''} · ${cod.slice(0, 16)}…`;
        const f = criarFazenda({ name: nome, owner: '', uf }, polysDoCAR(ft), cod);
        if (marcador) { marcador.remove(); marcador = null; }
        toast(`Achei o imóvel: ${fmt(f.area, 1)} ha. Buscando imagens e verificando a situação…`, 5000);
        rodarTudo();
      };
      if (achou.length === 1) return usar(achou[0]);
      $('pickList').innerHTML = achou.map((ft, k) => {
        const p = ft.properties;
        return `<button class="scene pick" data-k="${k}"><div><div class="d">${esc(pick(p, 'cod_imovel') || 'CAR')}</div><div class="m">${STATUS_CAR[pick(p, 'status_imovel')] || ''} · ${ha(+pick(p, 'area') || turf.area(ft) / 1e4)} · ${esc(pick(p, 'municipio') || '')}</div></div></button>`;
      }).join('');
      $('pickModal').hidden = false;
      $('pickList').onclick = e => { const b = e.target.closest('.pick'); if (!b) return; $('pickModal').hidden = true; usar(achou[+b.dataset.k]); };
      toast(`${achou.length} imóveis do CAR se sobrepõem nesse ponto. Escolha um.`, 5000);
    } finally { busy(false); }
  }
  function rodarTudo() {
    // imagens recentes + situação, em paralelo
    switchTab('situacao');
    rodarDiagnostico();
    doSearch();
  }

  function buscarTexto(txt, errEl) {
    if (errEl) errEl.textContent = '';
    if (linkCurto(txt)) {
      const msg = 'Esse é um link curto do Google Maps, que não traz as coordenadas. Abra o link, toque e segure no ponto até aparecer o alfinete e copie os números que aparecem (ex.: -3.7345, -46.0605).';
      if (errEl) errEl.textContent = msg; else toast(msg, 9000);
      return false;
    }
    const loc = lerLocalizacao(txt);
    if (!loc) {
      const msg = 'Não reconheci a localização. Use coordenadas (ex.: -3.7345, -46.0605) ou um link do Google Maps.';
      if (errEl) errEl.textContent = msg; else toast(msg, 6000);
      return false;
    }
    abrirPorPonto(loc.lat, loc.lon);
    return true;
  }
  function gps(btn) {
    if (!navigator.geolocation) return toast('Este navegador não fornece localização.');
    const t = btn.textContent; btn.disabled = true; btn.textContent = 'Obtendo localização…';
    navigator.geolocation.getCurrentPosition(pos => {
      btn.disabled = false; btn.textContent = t; $('locModal').hidden = true;
      abrirPorPonto(pos.coords.latitude, pos.coords.longitude);
    }, err => {
      btn.disabled = false; btn.textContent = t;
      toast(err.code === 1 ? 'Permissão de localização negada. Libere nas configurações do navegador.' : 'Não consegui obter a localização: ' + err.message, 7000);
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
  }

  // ---------- interface ----------
  $('btnLoc').onclick = () => { $('locErr').textContent = ''; $('locModal').hidden = false; $('locInput').focus(); };
  $('locCancel').onclick = () => $('locModal').hidden = true;
  $('locGo').onclick = () => { if (buscarTexto($('locInput').value, $('locErr'))) $('locModal').hidden = true; };
  $('locGps').onclick = () => gps($('locGps'));
  $('locGo2').onclick = () => buscarTexto($('locInput2').value);
  $('locInput2').onkeydown = e => { if (e.key === 'Enter') buscarTexto($('locInput2').value); };
  $('locGps2').onclick = () => gps($('locGps2'));

  // ---------- localização vinda pelo endereço (?loc=…) ou pelo "Compartilhar" do Android ----------
  const q = new URLSearchParams(location.search);
  const recebido = q.get('loc') || q.get('ll') || q.get('q') || [q.get('text'), q.get('url'), q.get('title')].filter(Boolean).join(' ');
  if (recebido) {
    history.replaceState(null, '', location.pathname + (q.get('stac') ? '?stac=' + encodeURIComponent(q.get('stac')) : ''));
    setTimeout(() => buscarTexto(recebido), 400);
  }

  // instalável como app (Android: aparece no menu "Compartilhar")
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });

  window.lerLocalizacao = lerLocalizacao; // usado nos testes
})();
