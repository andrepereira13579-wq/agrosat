/* AgroSat — "Gerar imagem": PNG do mapa atual (fundo de satélite, camada, contorno, divisões, legenda, escala e norte). */
'use strict';
(function () {
  const TILE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const merc = (lon, lat, z) => { const n = 256 * 2 ** z, r = lat * Math.PI / 180; return [(lon + 180) / 360 * n, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n]; };
  const carregar = src => new Promise(ok => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = () => ok(null); im.src = src; });

  async function gerar() {
    const f = farm(); if (!f) return;
    busy(true, 'Gerando a imagem…');
    try {
      const W = 1600, Hmapa = 1100, topo = 110, rod = 70, H = topo + Hmapa + rod;
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#0d1510'; ctx.fillRect(0, 0, W, H);
      // enquadramento (Web Mercator)
      const b = bboxOf(f.polys), padX = (b[2] - b[0]) * 0.1, padY = (b[3] - b[1]) * 0.1;
      const bb = [b[0] - padX, b[1] - padY, b[2] + padX, b[3] + padY];
      let z = 17;
      for (; z > 3; z--) { const a = merc(bb[0], bb[3], z), c = merc(bb[2], bb[1], z); if (c[0] - a[0] <= W && c[1] - a[1] <= Hmapa) break; }
      const a = merc(bb[0], bb[3], z), c = merc(bb[2], bb[1], z);
      const esc_ = Math.min(W / (c[0] - a[0]), Hmapa / (c[1] - a[1]));
      const cx = (a[0] + c[0]) / 2, cy = (a[1] + c[1]) / 2;
      const P = (lon, lat) => { const m = merc(lon, lat, z); return [W / 2 + (m[0] - cx) * esc_, topo + Hmapa / 2 + (m[1] - cy) * esc_]; };
      // fundo de satélite (Esri); se não carregar, segue sem fundo
      ctx.save(); ctx.beginPath(); ctx.rect(0, topo, W, Hmapa); ctx.clip();
      const x0 = Math.floor((cx - W / 2 / esc_) / 256), x1 = Math.floor((cx + W / 2 / esc_) / 256);
      const y0 = Math.floor((cy - Hmapa / 2 / esc_) / 256), y1 = Math.floor((cy + Hmapa / 2 / esc_) / 256);
      const tiles = [];
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push([x, y]);
      let fundoOk = 0;
      await Promise.all(tiles.map(async ([x, y]) => {
        const im = await carregar(TILE.replace('{z}', z).replace('{x}', x).replace('{y}', y));
        if (!im) return; fundoOk++;
        ctx.drawImage(im, W / 2 + (x * 256 - cx) * esc_, topo + Hmapa / 2 + (y * 256 - cy) * esc_, 256 * esc_ + 1, 256 * esc_ + 1);
      }));
      // camada atual (NDVI, uso do solo, declividade…)
      const ov = S.overlay && S.overlay._url, bnd = S.overlay && S.overlay.getBounds();
      if (ov && bnd) {
        const im = await carregar(ov);
        if (im) {
          const p1 = P(bnd.getWest(), bnd.getNorth()), p2 = P(bnd.getEast(), bnd.getSouth());
          ctx.globalAlpha = S.extra ? 0.9 : ($('opacity').value / 100); ctx.imageSmoothingEnabled = true;
          ctx.drawImage(im, p1[0], p1[1], p2[0] - p1[0], p2[1] - p1[1]); ctx.globalAlpha = 1;
        }
      }
      // divisões e contorno
      const linha = (rings, cor, larg, tracejado) => {
        ctx.strokeStyle = cor; ctx.lineWidth = larg; ctx.setLineDash(tracejado || []);
        rings.forEach(r => { ctx.beginPath(); r.forEach((pt, i) => { const q = P(pt[0], pt[1]); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath(); ctx.stroke(); });
        ctx.setLineDash([]);
      };
      (f.divs || []).forEach(d => linha(d.rings, 'rgba(255,255,255,.9)', 2));
      f.polys.forEach(p => { linha(p, 'rgba(0,0,0,.6)', 7); linha(p, '#ffd400', 3.5); });
      ctx.font = 'bold 22px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      (f.divs || []).forEach(d => {
        const cc = turf.centroid(turf.polygon(d.rings)).geometry.coordinates, q = P(cc[0], cc[1]);
        const w = ctx.measureText(d.nome).width + 14;
        ctx.fillStyle = 'rgba(10,17,13,.8)'; ctx.fillRect(q[0] - w / 2, q[1] - 15, w, 30);
        ctx.fillStyle = '#fff'; ctx.fillText(d.nome, q[0], q[1]);
      });
      ctx.restore();
      // cabeçalho
      const leg = legendaAtual(), cons = CONF.consultor;
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#e8f0ea'; ctx.font = 'bold 40px system-ui, sans-serif';
      ctx.fillText(f.name, 30, 52);
      ctx.fillStyle = '#9db3a4'; ctx.font = '24px system-ui, sans-serif';
      const data = S.extra ? '' : (S.result ? ' · ' + dBR(S.result.it.properties.datetime) : '');
      ctx.fillText(`${fmt(f.area, 1)} ha${f.owner ? ' · ' + f.owner : ''}${f.car ? ' · CAR ' + f.car.slice(0, 18) + '…' : ''} · ${leg ? leg.titulo : 'Mapa'}${data}`, 30, 90);
      // legenda (canto inferior esquerdo do mapa)
      if (leg && (leg.grad || (leg.itens && leg.itens.length))) {
        const itens = leg.itens || [], lw = 470, lh = 50 + (leg.grad ? 50 : 0) + itens.length * 30;
        const lx = 20, ly = topo + Hmapa - lh - 20;
        ctx.fillStyle = 'rgba(10,17,13,.88)'; ctx.fillRect(lx, ly, lw, lh);
        ctx.fillStyle = '#e8f0ea'; ctx.font = 'bold 22px system-ui, sans-serif'; ctx.fillText(leg.titulo, lx + 14, ly + 32);
        let yy = ly + 50;
        if (leg.grad) {
          const g = ctx.createLinearGradient(lx + 14, 0, lx + lw - 14, 0);
          leg.grad.forEach(([, cor], i) => g.addColorStop(i / (leg.grad.length - 1), `rgb(${cor})`));
          ctx.fillStyle = g; ctx.fillRect(lx + 14, yy, lw - 28, 16);
          ctx.fillStyle = '#9db3a4'; ctx.font = '18px system-ui, sans-serif';
          ctx.fillText(`${leg.ponta[0]} (${fmt(leg.grad[0][0], 1)})`, lx + 14, yy + 40);
          ctx.textAlign = 'right'; ctx.fillText(`${leg.ponta[1]} (${fmt(leg.grad[leg.grad.length - 1][0], 1)})`, lx + lw - 14, yy + 40); ctx.textAlign = 'left';
          yy += 50;
        }
        ctx.font = '19px system-ui, sans-serif';
        itens.forEach(i => {
          ctx.fillStyle = i.cor; ctx.fillRect(lx + 14, yy + 4, 18, 18);
          ctx.fillStyle = '#e8f0ea'; ctx.fillText(String(i.nome).replace(/<[^>]+>/g, ''), lx + 42, yy + 20);
          if (i.valor) { ctx.textAlign = 'right'; ctx.fillText(i.valor, lx + lw - 14, yy + 20); ctx.textAlign = 'left'; }
          yy += 30;
        });
      }
      // escala e norte
      const latC = (b[1] + b[3]) / 2, mPorPx = 156543.03392 * Math.cos(latC * Math.PI / 180) / 2 ** z / esc_;
      const alvo = mPorPx * 300, nice = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000].reduce((p, v) => v <= alvo ? v : p, 50);
      const bw = nice / mPorPx, sx = W - bw - 40, sy = topo + Hmapa - 40;
      ctx.fillStyle = 'rgba(10,17,13,.85)'; ctx.fillRect(sx - 16, sy - 40, bw + 32, 62);
      ctx.fillStyle = '#fff'; ctx.fillRect(sx, sy, bw, 8); ctx.fillStyle = '#000'; ctx.fillRect(sx, sy, bw / 2, 8);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(sx, sy, bw, 8);
      ctx.fillStyle = '#fff'; ctx.font = '18px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, sx + bw / 2, sy - 12);
      const nx = W - 60, ny = topo + 70;
      ctx.fillStyle = 'rgba(10,17,13,.85)'; ctx.beginPath(); ctx.arc(nx, ny, 34, 0, 7); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(nx, ny - 26); ctx.lineTo(nx - 12, ny + 10); ctx.lineTo(nx, ny + 2); ctx.lineTo(nx + 12, ny + 10); ctx.closePath(); ctx.fill();
      ctx.font = 'bold 18px system-ui, sans-serif'; ctx.fillText('N', nx, ny + 28);
      // rodapé
      ctx.textAlign = 'left'; ctx.fillStyle = '#9db3a4'; ctx.font = '19px system-ui, sans-serif';
      const fontes = S.extra ? (/Uso do solo|nativa/.test(leg.titulo) ? 'MapBiomas' : 'Terrain Tiles/SRTM') : (S.result ? `${fonteDe(S.result.it).curto}` : '');
      ctx.fillText(`${[cons.nome, cons.empresa, cons.contato].filter(Boolean).join(' · ') || 'AgroSat'} · gerado em ${dBR(isoDay(new Date()))}`, 30, topo + Hmapa + 30);
      ctx.fillText(`Fontes: ${[fontes, fundoOk ? 'fundo Esri World Imagery' : ''].filter(Boolean).join(', ')} · AgroSat`, 30, topo + Hmapa + 58);
      const url = cv.toDataURL('image/png');
      $('imgPrev').src = url; $('imgModal').hidden = false;
      $('imgBaixar').onclick = () => { const a = document.createElement('a'); a.href = url; a.download = `${f.name.replace(/[^\w\-]+/g, '_')}_${(leg ? leg.titulo : 'mapa').split(/[ ·—]/)[0]}.png`; document.body.appendChild(a); a.click(); a.remove(); };
      $('imgShare').hidden = !(navigator.canShare);
      $('imgShare').onclick = async () => {
        try { const blob = await (await fetch(url)).blob(); const file = new File([blob], 'agrosat.png', { type: 'image/png' }); if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: f.name }); }
        catch (e) { if (e.name !== 'AbortError') toast('Não consegui compartilhar; use Baixar.'); }
      };
    } catch (e) { console.error(e); toast('Não consegui gerar a imagem: ' + e.message, 6000); }
    finally { busy(false); }
  }
  $('btnImg').onclick = gerar;
  $('imgFechar').onclick = () => $('imgModal').hidden = true;
})();
