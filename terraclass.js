/* AgroSat — TerraClass (INPE + Embrapa): mapeamento oficial do uso da terra nas áreas desmatadas.
   Bioma Amazônia: 2008, 2010, 2012, 2014, 2016. Amazônia + Cerrado: 2018, 2020, 2022, 2024. Resolução 30 m (Landsat).
   Leitura pelo GeoServer público do TerraClass (WMS): o mapa é pedido já recortado na grade do imóvel e as cores
   são convertidas de volta em classes com a legenda oficial do próprio servidor. */
'use strict';
(function () {
  const BASE = 'https://www.terraclass.gov.br/geoserver/TerraClass';
  const ANOS_AMZ = [2008, 2010, 2012, 2014, 2016], ANOS_AC = [2018, 2020, 2022, 2024];
  const CIT_TC = 'TerraClass (INPE / Embrapa, 30 m)';
  const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // classe TerraClass (pelo nome da legenda) -> código usado no app (mesma legenda do MapBiomas + 3 classes próprias)
  function codigoDe(label) {
    const t = semAcento(label);
    if (/desflorest|desmat/.test(t)) return 103;
    if (/secundari|regenera/.test(t)) return 101;
    if (/pastagem|pasto/.test(t)) return /arbust|arbor|suja/.test(t) ? 102 : 15;
    if (/silvicult|reflorest/.test(t)) return 9;
    if (/semi.?perene|cana/.test(t)) return 20;
    if (/perene/.test(t)) return 36;
    if (/temporari|agricult|cultura|lavoura|soja|milho|algod/.test(t)) return 19;
    if (/minera/.test(t)) return 30;
    if (/urban|edifica/.test(t)) return 24;
    if (/agua|hidrograf|\brio\b|lago|reservat/.test(t)) return 33;
    if (/nao observ|nuvem|sem dado|sem informa/.test(t)) return 27;
    if (/nao florest|campestre|savan|natural nao/.test(t)) return 12;
    if (/florest|vegetacao natural|primari|nativ/.test(t)) return 3;
    return 25;
  }

  async function baixar(url, tipo) {
    let erro = null;
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 30000);
      const r = await fetch(url, { signal: ctl.signal }); clearTimeout(t);
      if (r.ok) return tipo === 'json' ? await r.json() : await r.blob();
      erro = new Error(`o servidor do TerraClass respondeu ${r.status}`);
    } catch (e) { erro = e; }
    if (typeof CONF !== 'undefined' && CONF.proxy) {
      let r;
      try { r = await fetch(`${CONF.proxy}/?url=${encodeURIComponent(url)}`); }
      catch (e) { throw new Error('o servidor do TerraClass não respondeu (nem direto nem pela ponte)'); }
      if (r.ok) return tipo === 'json' ? await r.json() : await r.blob();
      if (r.status === 403) throw new Error('o servidor do TerraClass não aceita consulta direta do navegador e a ponte ainda não libera o endereço terraclass.gov.br (atualize o código da ponte no Cloudflare)');
      throw new Error(`o servidor do TerraClass respondeu ${r.status} pela ponte`);
    }
    throw new Error('o servidor do TerraClass não respondeu. Configure o servidor-ponte em ⚙ Configurações.');
  }

  // legenda oficial da camada (GeoServer GetLegendGraphic em JSON): [{q, cor:[r,g,b], label, cod}]
  const cacheLeg = new Map();
  async function legenda(camada) {
    if (cacheLeg.has(camada)) return cacheLeg.get(camada);
    const url = `${BASE}/wms?service=WMS&version=1.1.1&request=GetLegendGraphic&format=application/json&layer=TerraClass:${camada}`;
    const j = await baixar(url, 'json'), out = [];
    (function andar(o) {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(andar); return; }
      if (o.color && (o.label !== undefined || o.quantity !== undefined)) {
        const h = String(o.color).replace('#', '');
        if (h.length >= 6) out.push({ q: +o.quantity, cor: [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)], op: o.opacity === undefined ? 1 : +o.opacity, label: o.label || String(o.quantity), cod: codigoDe(o.label || '') });
        return;
      }
      Object.values(o).forEach(andar);
    })(j);
    if (!out.length) throw new Error('a legenda do TerraClass veio vazia');
    cacheLeg.set(camada, out); return out;
  }

  function anoDisponivel(ano) {
    const todos = [...ANOS_AMZ, ...ANOS_AC].filter(a => a <= ano);
    return todos.length ? Math.max(...todos) : null;
  }
  const camadaDe = a => ANOS_AC.includes(a) ? `tc_amazonia_cerrado_${a}_raster` : `tc_amazonia_${a}_raster`;

  const cache = new Map();
  async function lerTerraClass(ano) {
    const f = farm(), a = anoDisponivel(ano);
    if (!a) throw new Error('o TerraClass começa em 2008');
    const k = `${f.id}|${a}`; if (cache.has(k)) return cache.get(k);
    const camada = camadaDe(a), leg = await legenda(camada);
    const g = grid(f.polys, 4326, 30 / 111320);
    const url = `${BASE}/wms?service=WMS&version=1.1.1&request=GetMap&layers=TerraClass:${camada}&styles=&srs=EPSG:4326&bbox=${g.bbox.join(',')}&width=${g.W}&height=${g.H}&format=image/png&transparent=true`;
    const blob = await baixar(url, 'blob');
    if (!/image/.test(blob.type || 'image/png')) { const t = await blob.text(); throw new Error('o TerraClass recusou o pedido: ' + t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140)); }
    const bmp = await createImageBitmap(blob);
    const cv = document.createElement('canvas'); cv.width = g.W; cv.height = g.H;
    const cx = cv.getContext('2d', { willReadFrequently: true }); cx.imageSmoothingEnabled = false; cx.drawImage(bmp, 0, 0, g.W, g.H);
    const px = cx.getImageData(0, 0, g.W, g.H).data;
    const exato = new Map(leg.map(e => [(e.cor[0] << 16) | (e.cor[1] << 8) | e.cor[2], e.cod]));
    const cod = new Uint8Array(g.W * g.H), memo = new Map();
    let n = 0, dentro = 0;
    for (let i = 0; i < g.W * g.H; i++) {
      if (!g.mask[i]) continue; dentro++;
      const o = i * 4; if (px[o + 3] < 40) continue;
      // cores com transparência parcial chegam pré-multiplicadas: desfaz antes de comparar
      const al = px[o + 3] / 255, r = Math.min(255, Math.round(px[o] / al)), gg = Math.min(255, Math.round(px[o + 1] / al)), b = Math.min(255, Math.round(px[o + 2] / al));
      const key = (r << 16) | (gg << 8) | b;
      let c = exato.get(key);
      if (c === undefined) {
        if (memo.has(key)) c = memo.get(key);
        else {
          let best = 0, dmin = 1e9;
          for (const e of leg) { const d = (e.cor[0] - r) ** 2 + (e.cor[1] - gg) ** 2 + (e.cor[2] - b) ** 2; if (d < dmin) { dmin = d; best = e.cod; } }
          c = dmin <= 45 * 45 ? best : 0; memo.set(key, c);
        }
      }
      if (c && c < 256) { cod[i] = c; n++; }
    }
    if (!n) throw new Error(a <= 2016 ? `o TerraClass ${a} só mapeou o bioma Amazônia, e esta área fica fora dele (no Cerrado o mapa mais antigo é de 2018)` : `o TerraClass ${a} veio sem dados nesta área`);
    const cobre = n / Math.max(1, dentro);
    const out = {
      g, cod, ano: a, colK: 'alt', alt: true, fonte: 'tc', cobre,
      c: { nome: '30 m', res: 30, cit: CIT_TC, anos: [2008, a] },
      nota: `Fonte: TerraClass ${a} (INPE / Embrapa), mapeamento oficial do uso da terra nas áreas desmatadas, 30 m. "Vegetação secundária" é a área desmatada que voltou a crescer (juquira/capoeira) e conta como vegetação nativa; "Pastagem arbustiva" é pasto com arbustos (pasto sujo).` + (cobre < 0.9 ? ` Só ${Math.round(cobre * 100)}% da área tem leitura nesse ano.` : ''),
    };
    cache.set(k, out); return out;
  }

  window.TERRACLASS = lerTerraClass;
  window.CIT_TC = CIT_TC;
  window.TC_CODIGO = codigoDe;
})();
