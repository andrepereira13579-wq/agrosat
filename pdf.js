/* AgroSat — gera PDF de um documento (relatório, memorial) no próprio aparelho.
   Roda no app principal (bibliotecas carregadas aqui) e desenha o documento da janela do relatório. */
'use strict';
(function () {
  const carregar = src => new Promise((ok, erro) => {
    const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => erro(new Error('não consegui carregar ' + src)); document.head.appendChild(s);
  });
  async function libs() {
    if (!window.html2canvas) await carregar('lib/html2canvas.min.js');
    if (!window.jspdf) await carregar('lib/jspdf.umd.min.js');
  }
  window.agvGerarPDF = async function (doc, aviso) {
    await libs();
    const pdf = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4', compress: true });
    let pags = [...doc.querySelectorAll('.pg')];
    if (!pags.length) {
      const w = doc.createElement('div'); w.className = 'pg';
      [...doc.body.childNodes].forEach(n => { if (!(n.classList && (n.classList.contains('agv-barra') || n.classList.contains('agv-msg'))) && n.nodeName !== 'SCRIPT' && n.nodeName !== 'STYLE') w.appendChild(n); });
      doc.body.appendChild(w); pags = [w];
    }
    doc.body.classList.add('agv-pdf');
    let primeira = true;
    try {
      for (let i = 0; i < pags.length; i++) {
        aviso && aviso(`Gerando PDF… página ${i + 1} de ${pags.length}`);
        const cv = await window.html2canvas(pags[i], { scale: 2, backgroundColor: '#ffffff', useCORS: true, windowWidth: 900, logging: false });
        const pxPorMm = cv.width / 210, altPg = Math.floor(297 * pxPorMm);
        for (let y = 0; y < cv.height; y += altPg) {
          const h = Math.min(altPg, cv.height - y); if (h < 20 && y > 0) break;
          const c2 = document.createElement('canvas'); c2.width = cv.width; c2.height = h;
          const x = c2.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c2.width, h); x.drawImage(cv, 0, y, cv.width, h, 0, 0, cv.width, h);
          if (!primeira) pdf.addPage(); primeira = false;
          pdf.addImage(c2.toDataURL('image/jpeg', 0.82), 'JPEG', 0, 0, 210, h / pxPorMm, undefined, 'FAST');
        }
      }
    } finally { doc.body.classList.remove('agv-pdf'); }
    const nome = (doc.title || 'relatorio').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) + '.pdf';
    return { nome, buf: pdf.output('arraybuffer') };
  };
})();
