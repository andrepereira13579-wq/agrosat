#!/usr/bin/env python3
"""AgroSat — panorama dos processos minerários (ANM/SIGMINE) de um estado, por município, substância e fase.
Saída: data/anm/panorama_<UF>.json. Variáveis: ANM_UF (padrão MA)."""
import io, json, os, subprocess, sys, time, urllib.request, zipfile, datetime, collections
import shapefile
from shapely.geometry import shape
from shapely.strtree import STRtree
from shapely.ops import transform
from pyproj import Transformer

UF = os.environ.get('ANM_UF', 'MA').upper()
COD = {'MA': 21, 'PI': 22, 'PA': 15, 'TO': 17}[UF]
URL_ANM = f'https://app.anm.gov.br/dadosabertos/SIGMINE/PROCESSOS_MINERARIOS/{UF}.zip'
URL_MUN = f'https://raw.githubusercontent.com/tbrugz/geodata-br/master/geojson/geojs-{COD}-mun.json'  # malha municipal IBGE (cópia pública)
URL_NOMES = f'https://servicodados.ibge.gov.br/api/v1/localidades/estados/{COD}/municipios'
PONTE = 'https://agrosat-ponte.andrepereira13579.workers.dev'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
SAIDA = os.path.join(os.path.dirname(__file__), '..', 'data', 'anm')


def baixar(url, destino, obrigatorio=True):
    import urllib.parse
    variantes = [[], ['--ciphers', 'DEFAULT:@SECLEVEL=0']]
    # servidores da ANM com cadeia de certificado incompleta: só leitura de dado público, aceita sem verificar
    if 'anm.gov.br' in url:
        variantes = [['-k'], ['-k', '--ciphers', 'DEFAULT:@SECLEVEL=0'], ['-k', '--tlsv1.2', '--tls-max', '1.2', '--ciphers', 'DEFAULT:@SECLEVEL=0']]
    rotas = [(url, v) for v in variantes] + [(PONTE + '/?url=' + urllib.parse.quote(url, safe=''), [])]
    for u, extra in rotas:
        try:
            subprocess.run(['curl', '-fsSL', '--retry', '2', '--connect-timeout', '60', '-A', UA, *extra, '-o', destino, u], check=True)
            if os.path.getsize(destino) > 500:
                return destino
        except Exception as e:
            print('falhou', u[:90], extra, e.__class__.__name__, getattr(e, 'returncode', ''), flush=True); time.sleep(5)
    if obrigatorio:
        raise SystemExit('Não consegui baixar ' + url)
    return None


def anm_arcgis():
    """Reserva: baixa os processos do estado pelo ArcGIS da ANM (geo.anm.gov.br), em páginas, como GeoJSON."""
    raiz = 'https://geo.anm.gov.br/arcgis/rest/services'
    cand = []
    interessa = lambda nome: any(x in nome.lower() for x in ('sigmine', 'processo', 'direito', 'titulo', 'título'))
    def andar(pasta):
        try:
            baixar(f'{raiz}/{pasta}?f=json' if pasta else f'{raiz}?f=json', '/tmp/cat.json')
        except SystemExit:
            return
        j = json.load(open('/tmp/cat.json'))
        servs = sorted(j.get('services', []), key=lambda sv: not interessa(sv['name']))
        for sv in servs:
            if sv.get('type') not in ('MapServer', 'FeatureServer') or not interessa(sv['name']):
                continue
            try:
                baixar(f"{raiz}/{sv['name']}/{sv['type']}?f=json", '/tmp/sv.json')
                for ly in json.load(open('/tmp/sv.json')).get('layers', []):
                    if interessa(sv['name'] + ' ' + ly.get('name', '')) and not ly.get('subLayerIds'):
                        cand.append(f"{raiz}/{sv['name']}/{sv['type']}/{ly['id']}")
            except SystemExit:
                pass
        for pz in j.get('folders', []):
            if not pasta and interessa(pz): andar(pz)
    andar('')
    if not cand:
        print('Serviços no catálogo raiz:', [sv['name'] for sv in json.load(open('/tmp/cat.json')).get('services', [])][:80], json.load(open('/tmp/cat.json')).get('folders'), flush=True)
    print('Camadas candidatas:', cand, flush=True)
    for url in cand:
        feats, off = [], 0
        try:
            while True:
                q = f"{url}/query?where=UF%3D%27{UF}%27&outFields=*&returnGeometry=true&outSR=4674&f=geojson&resultOffset={off}&resultRecordCount=1000"
                baixar(q, '/tmp/pg.json')
                j = json.load(open('/tmp/pg.json'))
                fs = j.get('features', [])
                feats += fs; off += len(fs)
                if len(fs) < 1000 and not j.get('exceededTransferLimit'): break
                if not fs: break
            if feats:
                print(f'{url}: {len(feats)} processos', flush=True)
                return feats
        except (Exception, SystemExit) as e:
            print('camada falhou', url, e, flush=True)
    raise SystemExit('ANM indisponível pelo ZIP e pelo ArcGIS')


def grupo_fase(f):
    f = (f or '').upper()
    if any(x in f for x in ('CONCESSÃO DE LAVRA', 'LICENCIAMENTO', 'LAVRA GARIMPEIRA', 'REGISTRO DE EXTRA')) and 'REQUERIMENTO' not in f:
        return 'lavra'
    if 'AUTORIZAÇÃO DE PESQUISA' in f:
        return 'pesquisa'
    if 'REQUERIMENTO' in f:
        return 'requerimento'
    if 'DISPONIBILIDADE' in f:
        return 'disponibilidade'
    return 'outras'


def main():
    os.makedirs(SAIDA, exist_ok=True)
    baixar(URL_MUN, '/tmp/mun.json')
    mun = json.load(open('/tmp/mun.json', encoding='utf-8'))
    nomes = {str(ft['properties']['id']): ft['properties']['name'] for ft in mun['features']}
    tr = Transformer.from_crs('EPSG:4674', 'EPSG:5880', always_xy=True).transform  # SIRGAS -> Policônica (área em m²)
    mgeo, mcod = [], []
    for ft in mun['features']:
        mgeo.append(transform(tr, shape(ft['geometry']).buffer(0))); mcod.append(str(ft['properties'].get('id')))
    arv = STRtree(mgeo)
    registros = []   # (dict de atributos, geometria GeoJSON)
    if baixar(URL_ANM, '/tmp/anm.zip', obrigatorio=False):
        z = zipfile.ZipFile('/tmp/anm.zip'); base = [n[:-4] for n in z.namelist() if n.lower().endswith('.shp')][0]
        sf = shapefile.Reader(shp=io.BytesIO(z.read(base + '.shp')), dbf=io.BytesIO(z.read(base + '.dbf')), shx=io.BytesIO(z.read(base + '.shx')), encoding='latin-1')
        campos = [f[0] for f in sf.fields[1:]]
        registros = ((dict(zip(campos, sr.record)), sr.shape.__geo_interface__) for sr in sf.iterShapeRecords())
        print('Fonte: ZIP do SIGMINE', flush=True)
    else:
        registros = (({k.upper(): v for k, v in (ft.get('properties') or {}).items()}, ft['geometry']) for ft in anm_arcgis() if ft.get('geometry'))
        print('Fonte: ArcGIS da ANM', flush=True)
    porMun = collections.defaultdict(lambda: collections.Counter()); porMunN = collections.defaultdict(lambda: collections.Counter())
    porMunSubs = collections.defaultdict(lambda: collections.Counter())
    porSubs = collections.Counter(); porSubsN = collections.Counter(); porFase = collections.Counter(); porFaseN = collections.Counter()
    porFaseDet = collections.Counter(); porAno = collections.Counter(); maiores = []; titulares = collections.Counter()
    n = 0
    for r, geo in registros:
        n += 1
        try:
            g = transform(tr, shape(geo).buffer(0))
        except Exception:
            continue
        fase, subs = (r.get('FASE') or '').strip(), (r.get('SUBS') or '').strip().upper() or 'NÃO INFORMADA'
        gf = grupo_fase(fase); ha = g.area / 1e4
        porSubs[subs] += ha; porSubsN[subs] += 1; porFase[gf] += ha; porFaseN[gf] += 1; porFaseDet[fase] += 1
        try: porAno[int(r.get('ANO') or 0)] += 1
        except Exception: pass
        tit = (r.get('NOME') or '').strip()
        if tit: titulares[tit] += ha
        for i in arv.query(g):
            inter = g.intersection(mgeo[i]).area / 1e4
            if inter > 0.01:
                c = mcod[i]; porMun[c][gf] += inter; porMunN[c][gf] += 1; porMunSubs[c][subs] += inter
        maiores.append((ha, r.get('PROCESSO'), subs, fase, r.get('ANO')))
    areaMun = {mcod[i]: mgeo[i].area / 1e4 for i in range(len(mgeo))}
    munis = []
    for c, cont in porMun.items():
        tot = sum(cont.values())
        munis.append({'cod': c, 'nome': nomes.get(c, c), 'ha': round(tot), 'pctMunicipio': round(tot / areaMun[c] * 100, 1) if areaMun.get(c) else None,
                      'porFase': {k: round(v) for k, v in cont.items()}, 'processos': dict(porMunN[c]),
                      'substancias': [[s, round(v)] for s, v in porMunSubs[c].most_common(4)]})
    munis.sort(key=lambda m: -m['ha'])
    maiores.sort(key=lambda x: -x[0])
    doc = {'gerado': datetime.date.today().isoformat(), 'uf': UF, 'fonte': 'ANM/SIGMINE (dados abertos); malha municipal IBGE',
           'processos': n, 'haTotal': round(sum(porFase.values())),
           'porFase': {k: {'ha': round(porFase[k]), 'n': porFaseN[k]} for k in porFase},
           'fasesDetalhe': porFaseDet.most_common(),
           'substancias': [{'subs': s, 'ha': round(v), 'n': porSubsN[s]} for s, v in porSubs.most_common(25)],
           'municipios': munis,
           'maioresProcessos': [{'ha': round(a), 'processo': p, 'subs': s, 'fase': f, 'ano': y} for a, p, s, f, y in maiores[:25]],
           'porAno': sorted(porAno.items()),
           'titularesMaiorArea': [[t if any(x in t.upper() for x in ('LTDA', 'S.A', 'S/A', 'MINERA', 'EIRELI', 'MINING', 'COMPANHIA', 'CIA', 'EMPRESA', 'COOPERATIVA', 'RECURSOS', 'RESOURCES', ' ME', 'EPP', 'BRASIL')) else 'Pessoa física', round(v)] for t, v in titulares.most_common(15)]}
    with open(os.path.join(SAIDA, f'panorama_{UF}.json'), 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    print(f'{UF}: {n} processos, {doc["haTotal"]} ha; top municípios:', [(m["nome"], m["ha"]) for m in munis[:10]], flush=True)


if __name__ == '__main__':
    main()
