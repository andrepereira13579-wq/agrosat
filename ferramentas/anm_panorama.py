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
URL_MUN = f'https://servicodados.ibge.gov.br/api/v3/malhas/estados/{COD}?formato=application/vnd.geo%2Bjson&intrarregiao=municipio&qualidade=intermediaria'
URL_NOMES = f'https://servicodados.ibge.gov.br/api/v1/localidades/estados/{COD}/municipios'
PONTE = 'https://agrosat-ponte.andrepereira13579.workers.dev'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
SAIDA = os.path.join(os.path.dirname(__file__), '..', 'data', 'anm')


def baixar(url, destino):
    import urllib.parse
    for u in (url, PONTE + '/?url=' + urllib.parse.quote(url, safe='')):
        for i in range(2):
            try:
                subprocess.run(['curl', '-fL', '--retry', '2', '--connect-timeout', '60', '-A', UA, '-o', destino, u], check=True)
                if os.path.getsize(destino) > 500:
                    return destino
            except Exception as e:
                print('falhou', u[:90], e, flush=True); time.sleep(8)
    raise SystemExit('Não consegui baixar ' + url)


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
    baixar(URL_ANM, '/tmp/anm.zip'); baixar(URL_MUN, '/tmp/mun.json'); baixar(URL_NOMES, '/tmp/nomes.json')
    nomes = {str(m['id']): m['nome'] for m in json.load(open('/tmp/nomes.json', encoding='utf-8'))}
    mun = json.load(open('/tmp/mun.json', encoding='utf-8'))
    tr = Transformer.from_crs('EPSG:4674', 'EPSG:5880', always_xy=True).transform  # SIRGAS -> Policônica (área em m²)
    mgeo, mcod = [], []
    for ft in mun['features']:
        mgeo.append(transform(tr, shape(ft['geometry']).buffer(0))); mcod.append(str(ft['properties'].get('codarea')))
    arv = STRtree(mgeo)
    z = zipfile.ZipFile('/tmp/anm.zip'); base = [n[:-4] for n in z.namelist() if n.lower().endswith('.shp')][0]
    sf = shapefile.Reader(shp=io.BytesIO(z.read(base + '.shp')), dbf=io.BytesIO(z.read(base + '.dbf')), shx=io.BytesIO(z.read(base + '.shx')), encoding='latin-1')
    campos = [f[0] for f in sf.fields[1:]]
    print('Campos:', campos, flush=True)
    porMun = collections.defaultdict(lambda: collections.Counter()); porMunN = collections.defaultdict(lambda: collections.Counter())
    porMunSubs = collections.defaultdict(lambda: collections.Counter())
    porSubs = collections.Counter(); porSubsN = collections.Counter(); porFase = collections.Counter(); porFaseN = collections.Counter()
    porFaseDet = collections.Counter(); porAno = collections.Counter(); maiores = []; titulares = collections.Counter()
    n = 0
    for sr in sf.iterShapeRecords():
        r = dict(zip(campos, sr.record)); n += 1
        try:
            g = transform(tr, shape(sr.shape.__geo_interface__).buffer(0))
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
