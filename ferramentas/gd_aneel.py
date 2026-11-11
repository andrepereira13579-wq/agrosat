#!/usr/bin/env python3
"""AgroSat — recorta a base de micro e minigeração distribuída da ANEEL (dados abertos) por estado.

Fonte: ANEEL, "Relação de empreendimentos de geração distribuída"
https://dadosabertos.aneel.gov.br/dataset/relacao-de-empreendimentos-de-geracao-distribuida

Saída: data/gd/<UF>.json, só com os campos técnicos (sem nome, CPF/CNPJ ou CEP do titular):
  {"gerado": "...", "fonte": "...", "listas": {"mun": [...], "classe": [...], "mod": [...], "ger": [...]},
   "d": [[lat, lon, iMun, iClasse, iMod, iGer, kW, ano], ...]}
Variáveis: GD_UFS (padrão "MA"), GD_CSV (arquivo local já baixado, para teste).
"""
import csv, io, json, os, sys, time, urllib.request, datetime, zipfile

PACOTE = 'relacao-de-empreendimentos-de-geracao-distribuida'
API = 'https://dadosabertos.aneel.gov.br/api/3/action/package_show?id=' + PACOTE
UA = {'User-Agent': 'Mozilla/5.0 (AgroSat; dados abertos)'}
UFS = [u.strip().upper() for u in os.environ.get('GD_UFS', 'MA').split(',') if u.strip()]
SAIDA = os.path.join(os.path.dirname(__file__), '..', 'data', 'gd')
csv.field_size_limit(10 ** 9)


def baixar(url, destino, tent=4):
    for i in range(tent):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=600) as r, open(destino, 'wb') as f:
                while True:
                    b = r.read(1 << 20)
                    if not b:
                        break
                    f.write(b)
            return destino
        except Exception as e:
            print(f'  tentativa {i + 1} falhou: {e}', flush=True)
            time.sleep(15 * (i + 1))
    raise SystemExit('Não consegui baixar ' + url)


def url_csv():
    with urllib.request.urlopen(urllib.request.Request(API, headers=UA), timeout=120) as r:
        pac = json.load(r)['result']
    cands = []
    for res in pac.get('resources', []):
        u, nome = res.get('url', ''), (res.get('name', '') + ' ' + u).lower()
        if any(x in nome for x in ('dicion', 'metadad', '.pdf')):
            continue
        if u.lower().endswith(('.csv', '.zip')) and 'empreendimento' in nome:
            cands.append(res)
    if not cands:
        raise SystemExit('Recurso CSV não encontrado no pacote da ANEEL')
    cands.sort(key=lambda r: ('zip' in r['url'].lower(), r.get('last_modified') or ''), reverse=False)
    return cands[0]['url']


def num(s):
    s = (s or '').strip().replace(' ', '')
    if not s:
        return None
    if ',' in s and '.' in s:
        s = s.replace('.', '').replace(',', '.')
    else:
        s = s.replace(',', '.')
    try:
        return float(s)
    except ValueError:
        return None


def abrir_texto(caminho):
    if zipfile.is_zipfile(caminho):
        z = zipfile.ZipFile(caminho)
        nome = max((n for n in z.namelist() if n.lower().endswith('.csv')), key=lambda n: z.getinfo(n).file_size)
        bruto = z.open(nome)
    else:
        bruto = open(caminho, 'rb')
    cab = bruto.read(4096)
    bruto.close()
    enc = 'utf-8-sig'
    try:
        cab.decode('utf-8')
    except UnicodeDecodeError:
        enc = 'latin-1'
    if zipfile.is_zipfile(caminho):
        return io.TextIOWrapper(zipfile.ZipFile(caminho).open(nome), encoding=enc, errors='replace', newline='')
    return open(caminho, encoding=enc, errors='replace', newline='')


def main():
    os.makedirs(SAIDA, exist_ok=True)
    caminho = os.environ.get('GD_CSV')
    if not caminho:
        url = url_csv()
        print('Baixando', url, flush=True)
        caminho = baixar(url, '/tmp/gd_aneel' + ('.zip' if url.lower().endswith('.zip') else '.csv'))
    txt = abrir_texto(caminho)
    amostra = txt.readline()
    sep = ';' if amostra.count(';') >= amostra.count(',') else ','
    cab = [c.strip().strip('"') for c in next(csv.reader([amostra], delimiter=sep))]
    low = {c.lower(): i for i, c in enumerate(cab)}

    def col(*nomes):
        for n in nomes:
            if n.lower() in low:
                return low[n.lower()]
        for n in nomes:
            for c, i in low.items():
                if n.lower() in c:
                    return i
        return None

    C = dict(uf=col('SigUF'), mun=col('NomMunicipio'), classe=col('DscClasseConsumo'),
             mod=col('DscModalidadeHabilitado', 'SigModalidadeEmpreendimento'), ger=col('SigTipoGeracao', 'DscFonteGeracao'),
             kw=col('MdaPotenciaInstaladaKW', 'PotenciaInstalada'), lat=col('NumCoordNEmpreendimento'), lon=col('NumCoordEEmpreendimento'),
             data=col('DthAtualizaCadastralEmpreend', 'DatConexao'))
    falta = [k for k in ('uf', 'kw', 'lat', 'lon') if C[k] is None]
    if falta:
        raise SystemExit(f'Colunas não encontradas: {falta}. Cabeçalho: {cab}')
    print('Colunas:', {k: (cab[v] if v is not None else None) for k, v in C.items()}, flush=True)

    out = {uf: {'listas': {'mun': [], 'classe': [], 'mod': [], 'ger': []}, 'idx': {'mun': {}, 'classe': {}, 'mod': {}, 'ger': {}}, 'd': [], 'sem': 0} for uf in UFS}

    def idx(o, k, v):
        v = (v or '').strip() or '—'
        if v not in o['idx'][k]:
            o['idx'][k][v] = len(o['listas'][k]); o['listas'][k].append(v)
        return o['idx'][k][v]

    n = 0
    for row in csv.reader(txt, delimiter=sep):
        n += 1
        if len(row) < len(cab) - 2:
            continue
        uf = (row[C['uf']] or '').strip().upper()
        if uf not in out:
            continue
        o = out[uf]
        lat, lon, kw = num(row[C['lat']]), num(row[C['lon']]), num(row[C['kw']])
        if lat is None or lon is None or not (-35 < lat < 6 and -75 < lon < -30):
            o['sem'] += 1; continue
        g = lambda k: row[C[k]] if C[k] is not None and C[k] < len(row) else ''
        ano = ''.join(ch for ch in g('data')[:10] if ch.isdigit())
        ano = int(ano[:4]) if len(ano) >= 4 and ano[:2] in ('19', '20') else (int(ano[-4:]) if len(ano) >= 8 else 0)
        o['d'].append([round(lat, 5), round(lon, 5), idx(o, 'mun', g('mun')), idx(o, 'classe', g('classe')), idx(o, 'mod', g('mod')), idx(o, 'ger', g('ger')), round(kw or 0, 2), ano])
    print(f'Linhas lidas: {n}', flush=True)
    hoje = datetime.date.today().isoformat()
    meta = {}
    for uf, o in out.items():
        doc = {'gerado': hoje, 'fonte': 'ANEEL — Relação de empreendimentos de geração distribuída (dados abertos)', 'uf': uf,
               'listas': o['listas'], 'd': o['d'], 'semCoordenada': o['sem']}
        with open(os.path.join(SAIDA, uf + '.json'), 'w', encoding='utf-8') as f:
            json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
        meta[uf] = {'registros': len(o['d']), 'semCoordenada': o['sem']}
        print(f'{uf}: {len(o["d"])} com coordenada, {o["sem"]} sem', flush=True)
    with open(os.path.join(SAIDA, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump({'gerado': hoje, 'ufs': meta}, f, ensure_ascii=False)
    if not any(m['registros'] for m in meta.values()):
        raise SystemExit('Nenhum registro com coordenada: confira as colunas')


if __name__ == '__main__':
    main()
