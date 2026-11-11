#!/usr/bin/env python3
"""AgroSat — recorta a base de micro e minigeração distribuída da ANEEL (dados abertos) por estado.

Fonte: ANEEL, "Relação de empreendimentos de geração distribuída"
https://dadosabertos.aneel.gov.br/dataset/relacao-de-empreendimentos-de-geracao-distribuida

Saída: data/gd/<UF>.json, só com os campos técnicos (sem nome, CPF/CNPJ ou CEP do titular):
  {"gerado": "...", "fonte": "...", "listas": {"mun": [...], "classe": [...], "mod": [...], "ger": [...]},
   "d": [[lat, lon, iMun, iClasse, iMod, iGer, kW, ano], ...]}
Variáveis: GD_UFS (padrão "MA"), GD_CSV (arquivo local já baixado, para teste).
"""
import csv, io, json, os, sys, time, urllib.request, urllib.parse, datetime, zipfile, subprocess

PACOTE = 'relacao-de-empreendimentos-de-geracao-distribuida'
API = 'https://dadosabertos.aneel.gov.br/api/3/action/package_show?id=' + PACOTE
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'}
ZIP_FIXO = 'https://dadosabertos.aneel.gov.br/dataset/5e0fafd2-21b9-4d5b-b622-40438d40aba2/resource/b1bd71e7-d0ad-4214-9053-cbd58e9564a7/download/empreendimento-geracao-distribuida.zip'
SEDES = 'https://raw.githubusercontent.com/kelvins/municipios-brasileiros/main/csv/municipios.csv'  # sede de cada município (código IBGE, lat, lon)
PONTE = os.environ.get('GD_PONTE', 'https://agrosat-ponte.andrepereira13579.workers.dev')
UFS = [u.strip().upper() for u in os.environ.get('GD_UFS', 'MA').split(',') if u.strip()]
SAIDA = os.path.join(os.path.dirname(__file__), '..', 'data', 'gd')
csv.field_size_limit(10 ** 9)


def _urllib(url, destino):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=900) as r, open(destino, 'wb') as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)


def _curl(url, destino):
    subprocess.run(['curl', '-fL', '--retry', '3', '--retry-delay', '10', '--connect-timeout', '60', '-A', UA['User-Agent'], '-o', destino, url], check=True)


def baixar(url, destino):
    """ANEEL às vezes corta conexões vindas de fora do Brasil: tenta direto, com curl e pela ponte do Cloudflare."""
    rotas = [('direto', _urllib, url), ('curl', _curl, url)]
    if PONTE:
        rotas.append(('ponte', _curl, PONTE.rstrip('/') + '/?url=' + urllib.parse.quote(url, safe='')))
    for nome, fn, u in rotas:
        for i in range(2):
            try:
                print(f'  {nome} (tentativa {i + 1})...', flush=True)
                fn(u, destino)
                if os.path.getsize(destino) > 1000:
                    return destino
                raise IOError('arquivo vazio')
            except Exception as e:
                print(f'  {nome} falhou: {e}', flush=True)
                time.sleep(10)
    raise SystemExit('Não consegui baixar ' + url)


def url_csv():
    try:
        baixar(API, '/tmp/gd_pacote.json')
        pac = json.load(open('/tmp/gd_pacote.json'))['result']
    except (Exception, SystemExit) as e:
        print('Catálogo da ANEEL indisponível, uso o endereço fixo do ZIP:', e, flush=True)
        return ZIP_FIXO
    cands = []
    for res in pac.get('resources', []):
        u = res.get('url', ''); nome = (res.get('name', '') + ' ' + u).lower()
        if any(x in nome for x in ('dicion', 'metadad', '.pdf')):
            continue
        if u.lower().endswith(('.csv', '.zip')) and 'empreendimento-geracao-distribuida' in nome:
            cands.append(res)
    if not cands:
        return ZIP_FIXO
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
             kw=col('MdaPotenciaInstaladaKW', 'PotenciaInstalada'), lat=col('NumCoordNEmpreendimento', 'NumCoordNSub'), lon=col('NumCoordEEmpreendimento', 'NumCoordESub'), sub=col('NomSubEstacao'),
             data=col('DthAtualizaCadastralEmpreend', 'DatConexao'))
    C['codmun'] = col('CodMunicipioIbge')
    # a ANEEL deixou de publicar a coordenada de cada instalação; a da subestação quase nunca vem preenchida.
    # Por isso cada instalação é posicionada na sede do seu município (código IBGE).
    sedes = {}
    try:
        baixar(SEDES, '/tmp/sedes.csv')
        for r in csv.DictReader(open('/tmp/sedes.csv', encoding='utf-8')):
            sedes[r['codigo_ibge'].strip()] = (float(r['latitude']), float(r['longitude']))
        print('Sedes municipais:', len(sedes), flush=True)
    except (Exception, SystemExit) as e:
        print('Sem a lista de sedes municipais:', e, flush=True)
    usar_sede = bool(sedes) and C['codmun'] is not None and not (C['lat'] is not None and cab[C['lat']] == 'NumCoordNEmpreendimento')
    falta = [k for k in ('uf', 'kw') + (() if usar_sede else ('lat', 'lon')) if C[k] is None]
    if falta:
        raise SystemExit(f'Colunas não encontradas: {falta}. Cabeçalho: {cab}')
    print('Colunas:', {k: (cab[v] if v is not None else None) for k, v in C.items()}, flush=True)

    out = {uf: {'listas': {'mun': [], 'classe': [], 'mod': [], 'ger': [], 'sub': []}, 'idx': {'mun': {}, 'classe': {}, 'mod': {}, 'ger': {}, 'sub': {}}, 'd': [], 'sem': 0} for uf in UFS}

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
        kw = num(row[C['kw']])
        if usar_sede:
            sd = sedes.get((row[C['codmun']] or '').strip().split('.')[0])
            lat, lon = sd if sd else (None, None)
        else:
            lat, lon = num(row[C['lat']]), num(row[C['lon']])
        if lat is None or lon is None or not (-35 < lat < 6 and -75 < lon < -30):
            o['sem'] += 1; continue
        g = lambda k: row[C[k]] if C[k] is not None and C[k] < len(row) else ''
        ano = ''.join(ch for ch in g('data')[:10] if ch.isdigit())
        ano = int(ano[:4]) if len(ano) >= 4 and ano[:2] in ('19', '20') else (int(ano[-4:]) if len(ano) >= 8 else 0)
        o['d'].append([round(lat, 5), round(lon, 5), idx(o, 'mun', g('mun')), idx(o, 'classe', g('classe')), idx(o, 'mod', g('mod')), idx(o, 'ger', g('ger')), round(kw or 0, 2), ano, idx(o, 'sub', g('sub'))])
    print(f'Linhas lidas: {n}', flush=True)
    hoje = datetime.date.today().isoformat()
    meta = {}
    for uf, o in out.items():
        if usar_sede:   # todas no mesmo ponto por município: agrega (município, classe, modalidade, fonte) com soma de kW e contagem
            ag = {}
            for r in o['d']:
                k = (r[2], r[3], r[4], r[5])
                a = ag.setdefault(k, [r[0], r[1], r[2], r[3], r[4], r[5], 0.0, 0, r[8], 0])
                a[6] += r[6]; a[9] += 1; a[7] = max(a[7], r[7])
            o['d'] = [a[:6] + [round(a[6], 1)] + a[7:] for a in ag.values()]
        doc = {'gerado': hoje, 'fonte': 'ANEEL — Relação de empreendimentos de geração distribuída (dados abertos)', 'uf': uf,
               'listas': o['listas'], 'd': o['d'], 'semCoordenada': o['sem'],
               'local': 'municipio' if usar_sede else ('empreendimento' if cab[C['lat']] == 'NumCoordNEmpreendimento' else 'subestacao')}
        with open(os.path.join(SAIDA, uf + '.json'), 'w', encoding='utf-8') as f:
            json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
        tot = sum((r[9] if len(r) > 9 else 1) for r in o['d'])
        meta[uf] = {'registros': tot, 'linhas': len(o['d']), 'semCoordenada': o['sem']}
        print(f'{uf}: {tot} com coordenada ({len(o["d"])} linhas), {o["sem"]} sem', flush=True)
    with open(os.path.join(SAIDA, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump({'gerado': hoje, 'ufs': meta}, f, ensure_ascii=False)
    if not any(m['registros'] for m in meta.values()):
        raise SystemExit('Nenhum registro com coordenada: confira as colunas')


if __name__ == '__main__':
    main()
