/* Configuração do AgroSat. Edite aqui depois de criar o servidor-ponte no Cloudflare,
   assim todos os aparelhos (você e seus clientes) já abrem configurados. */
window.AGROSAT_PROXY = 'https://agrosat-ponte.andrepereira13579.workers.dev';   // ex.: 'https://agrosat-ponte.seuusuario.workers.dev'
window.AGROSAT_CONSULTOR = { nome: '', empresa: '', contato: '' };

// KMLs guardados no site (pasta kml/): aparecem para baixar ou cadastrar com um toque.
window.AGROSAT_KMLS = [
  { nome: 'Zome', arquivo: 'kml/Zome.kml' },
  { nome: 'Ailton', arquivo: 'kml/Ailton.kml' },
  { nome: 'Rikelme', arquivo: 'kml/Rikelme.kml' },
];
