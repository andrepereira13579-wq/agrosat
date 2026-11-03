/* AgroSat — visualização 3D da propriedade (MapLibre): relevo real, imagem de satélite,
   contorno, divisões e NDVI por cima. Altitude: Terrain Tiles (AWS, formato terrarium). */
'use strict';
(function () {
  const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  let M3 = null, marcadores = [];
  const nomesFundo = Object.keys(FUNDOS);
  $('fd3d').innerHTML = nomesFundo.filter(n => !/ruas/i.test(n)).map(n => `<option>${esc(n)}</option>`).join('');

  function geo(f) {
    return {
      per: { type: 'FeatureCollection', features: f.polys.map(p => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: p } })) },
      div: { type: 'FeatureCollection', features: (f.divs || []).map(d => ({ type: 'Feature', properties: { nome: d.nome }, geometry: { type: 'Polygon', coordinates: d.rings } })) },
    };
  }
  function cantosNDVI(res) {
    const g = res.g, ll = toLL(g.epsg), b = g.bbox;
    return [[b[0], b[3]], [b[2], b[3]], [b[2], b[1]], [b[0], b[1]]].map(ll); // NO, NE, SE, SO
  }
  function fundoUrl(nome) { return FUNDOS[nome] || FUNDOS[nomesFundo[0]]; }

  function abrir() {
    const f = farm(); if (!f) return;
    $('m3d').hidden = false; $('t3dNome').textContent = `${f.name} · 3D`; $('t3dAlt').textContent = 'Calculando altitude…';
    const atual = (fundoAtual && fundoAtual._nomeFundo && !/ruas/i.test(fundoAtual._nomeFundo)) ? fundoAtual._nomeFundo : nomesFundo[0];
    $('fd3d').value = atual;
    if (M3) { M3.remove(); M3 = null; }
    const b = bboxOf(f.polys), F = fundoUrl(atual), G = geo(f), ex = +$('ex3d').value;
    M3 = new maplibregl.Map({
      container: 'map3d',
      style: {
        version: 8,
        sources: {
          sat: { type: 'raster', tiles: [F.url], tileSize: 256, maxzoom: F.nat, attribution: F.attr },
          dem: { type: 'raster-dem', tiles: [DEM], encoding: 'terrarium', tileSize: 256, maxzoom: 15, attribution: 'Relevo: Terrain Tiles (AWS / Mapzen)' },
          dem2: { type: 'raster-dem', tiles: [DEM], encoding: 'terrarium', tileSize: 256, maxzoom: 15 },
        },
        layers: [
          { id: 'fundo', type: 'background', paint: { 'background-color': '#0d1510' } },
          { id: 'sat', type: 'raster', source: 'sat' },
          { id: 'sombra', type: 'hillshade', source: 'dem2', paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#000' } },
        ],
        terrain: { source: 'dem', exaggeration: ex },
      },
      bounds: [[b[0], b[1]], [b[2], b[3]]], fitBoundsOptions: { padding: { top: 110, bottom: 110, left: 24, right: 24 } },
      pitch: 62, bearing: -25, maxPitch: 85, attributionControl: { compact: true },
    });
    M3.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    M3.once('style.load', () => {
      const res = S.result && !S.result.isDiff ? S.result : null;
      if (res) {
        M3.addSource('ndvi', { type: 'image', url: renderCanvas(res, 'ndvi'), coordinates: cantosNDVI(res) });
        M3.addLayer({ id: 'ndvi', type: 'raster', source: 'ndvi', paint: { 'raster-opacity': 0.85, 'raster-resampling': S.suave ? 'linear' : 'nearest' }, layout: { visibility: $('nd3d').checked ? 'visible' : 'none' } });
      } else { $('nd3d').checked = false; $('nd3d').disabled = true; $('nd3d').parentElement.title = 'Abra uma imagem na aba Imagens para ver o NDVI em 3D'; }
      if (res) $('nd3d').disabled = false;
      M3.addSource('div', { type: 'geojson', data: G.div });
      M3.addLayer({ id: 'div', type: 'line', source: 'div', paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-opacity': .9 }, layout: { visibility: $('dv3d').checked ? 'visible' : 'none' } });
      M3.addSource('per', { type: 'geojson', data: G.per });
      M3.addLayer({ id: 'per', type: 'line', source: 'per', paint: { 'line-color': '#ffd400', 'line-width': 3 } });
      marcadores.forEach(m => m.remove()); marcadores = [];
      (f.divs || []).forEach(d => {
        const el = document.createElement('div'); el.className = 'lbl3d'; el.textContent = d.nome;
        marcadores.push(new maplibregl.Marker({ element: el }).setLngLat(turf.centroid(turf.polygon(d.rings)).geometry.coordinates).addTo(M3));
      });
      mostrarDivs();
    });
    altitudes(f).then(a => {
      $('t3dAlt').textContent = a ? `Altitude ${fmt(a.min, 0)}–${fmt(a.max, 0)} m · média ${fmt(a.med, 0)} m · desnível ${fmt(a.max - a.min, 0)} m` : 'Altitude indisponível';
    }).catch(() => $('t3dAlt').textContent = 'Altitude indisponível');
  }
  function mostrarDivs() {
    const v = $('dv3d').checked;
    if (M3 && M3.getLayer('div')) M3.setLayoutProperty('div', 'visibility', v ? 'visible' : 'none');
    marcadores.forEach(m => m.getElement().style.display = v ? '' : 'none');
  }

  // Altitude dentro do perímetro, lendo os blocos de relevo (zoom 14, ~9 m por pixel no Equador)
  async function altitudes(f) {
    const z = 14, n = 2 ** z, b = bboxOf(f.polys);
    const tx = lon => (lon + 180) / 360 * n;
    const ty = lat => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n; };
    const x0 = Math.floor(tx(b[0])), x1 = Math.floor(tx(b[2])), y0 = Math.floor(ty(b[3])), y1 = Math.floor(ty(b[1]));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 36) return null;
    const vals = [];
    const dentro = (lon, lat) => f.polys.some(p => pip(lon, lat, p[0]) && !p.slice(1).some(h => pip(lon, lat, h)));
    const jobs = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push((async () => {
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.src = DEM.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      await img.decode();
      const cv = document.createElement('canvas'); cv.width = cv.height = 256;
      const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, 256, 256).data;
      for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
        const lon = (x + (i + .5) / 256) / n * 360 - 180;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + (j + .5) / 256) / n))) * 180 / Math.PI;
        if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3] || !dentro(lon, lat)) continue;
        const k = (j * 256 + i) * 4; vals.push(d[k] * 256 + d[k + 1] + d[k + 2] / 256 - 32768);
      }
    })());
    await Promise.all(jobs);
    if (!vals.length) return null;
    vals.sort((a, c) => a - c);
    const q = p => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
    return { min: q(0.01), max: q(0.99), med: vals.reduce((s, v) => s + v, 0) / vals.length };
  }

  $('btn3D').onclick = abrir;
  $('c3d').onclick = () => { $('m3d').hidden = true; if (M3) { M3.remove(); M3 = null; } };
  $('ex3d').oninput = e => { $('exV').textContent = e.target.value; if (M3) M3.setTerrain({ source: 'dem', exaggeration: +e.target.value }); };
  $('nd3d').onchange = e => { if (M3 && M3.getLayer('ndvi')) M3.setLayoutProperty('ndvi', 'visibility', e.target.checked ? 'visible' : 'none'); };
  $('dv3d').onchange = mostrarDivs;
  $('fd3d').onchange = e => {
    if (!M3) return; const F = fundoUrl(e.target.value);
    M3.removeLayer('sat'); M3.removeSource('sat');
    M3.addSource('sat', { type: 'raster', tiles: [F.url], tileSize: 256, maxzoom: F.nat, attribution: F.attr });
    M3.addLayer({ id: 'sat', type: 'raster', source: 'sat' }, 'sombra');
  };
})();
