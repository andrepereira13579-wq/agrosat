#!/usr/bin/env python3
"""AgroSat — gera a base de crédito rural (Sicor / Banco Central) recortada por estado.

O Banco Central publica, por ano, as glebas (áreas financiadas, com coordenadas) e as
operações de crédito rural. Os arquivos são do Brasil inteiro e muito grandes para o
navegador, então este script (rodado pelo GitHub Actions uma vez por mês):

  1. lê as glebas e guarda só as que caem nos estados escolhidos;
  2. lê as operações e pega banco, datas, valor, finalidade e programa dessas glebas;
  3. grava em data/sicor/ em blocos de 0,25° (o app baixa só os blocos da fazenda).

Só biblioteca padrão do Python. Uso:
  python3 ferramentas/sicor_glebas.py            (estados de SICOR_UFS, padrão MA)
  SICOR_UFS=MA,PI,TO SICOR_ANO_INI=2016 python3 ferramentas/sicor_glebas.py
"""
import csv, gzip, io, json, math, os, re, shutil, sys, time, urllib.request, zipfile
from datetime import date

csv.field_size_limit(1 << 30)

BASE = 'https://www.bcb.gov.br/htms/sicor/'
UA = 'Mozilla/5.0 (X11; Linux x86_64) AgroSat-gerador/1.0'
SAIDA = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'sicor')
TILE = 0.25

# Retângulos aproximados dos estados (oeste, sul, leste, norte), com folga.
UF_BBOX = {
    'MA': (-48.9, -10.4, -41.6, -0.9),
    'PI': (-45.1, -10.95, -40.3, -2.7),
    'TO': (-50.8, -13.5, -45.6, -5.1),
    'PA': (-58.95, -9.9, -46.0, 2.65),
    'CE': (-41.5, -7.9, -37.2, -2.7),
    'BA': (-46.7, -18.4, -37.3, -8.5),
    'MT': (-61.7, -18.1, -50.2, -7.3),
    'GO': (-53.3, -19.55, -45.9, -12.35),
}

# Bancos mais comuns (raiz do CNPJ), usados se a lista oficial não baixar.
BANCOS = {
    '00000000': 'Banco do Brasil', '07237373': 'Banco do Nordeste (BNB)', '04902979': 'Banco da Amazônia (BASA)',
    '00360305': 'Caixa Econômica Federal', '60746948': 'Bradesco', '60701190': 'Itaú Unibanco', '90400888': 'Santander',
    '01181521': 'Banco Cooperativo Sicredi', '02038232': 'Banco Sicoob', '92702067': 'Banrisul', '33657248': 'BNDES',
    '01023570': 'Rabobank', '61533584': 'Safra', '00416968': 'Banco Inter', '17184037': 'Banco Mercantil do Brasil',
}


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def abrir(nome, tentativas=4):
    """Abre o arquivo do BCB como fluxo (sem salvar em disco). Tenta variações do nome."""
    nomes = [nome, nome.upper(), nome.lower()]
    vistos = []
    for n in nomes:
        if n in vistos:
            continue
        vistos.append(n)
        url = BASE + n
        for t in range(tentativas):
            try:
                r = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=180)
                return r, url
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    break
                log('  erro', e.code, url, '— tentando de novo')
            except Exception as e:
                log('  falha', type(e).__name__, e, url, '— tentando de novo')
            time.sleep(10 * (t + 1))
    return None, None


def linhas_texto(nome):
    """Devolve (url, iterador de linhas de texto) de um arquivo .gz/.zip/.csv do BCB."""
    r, url = abrir(nome)
    if not r:
        return None, None
    cab = r.read(4)
    if cab[:2] == b'PK':  # zip: precisa do arquivo inteiro
        buf = io.BytesIO(cab + r.read())
        z = zipfile.ZipFile(buf)
        bruto = z.open(z.namelist()[0])
    else:
        fluxo = _Prefixo(cab, r)
        bruto = gzip.GzipFile(fileobj=fluxo) if cab[:2] == b'\x1f\x8b' else fluxo
    return url, io.TextIOWrapper(bruto, encoding='cp1252', errors='replace', newline='')


class _Prefixo(io.RawIOBase):
    """Fluxo que devolve primeiro os bytes já lidos e depois o resto da resposta."""
    def __init__(self, pre, resto):
        self.pre, self.resto = pre, resto
    def readable(self):
        return True
    def readinto(self, b):
        if self.pre:
            n = min(len(b), len(self.pre)); b[:n] = self.pre[:n]; self.pre = self.pre[n:]; return n
        d = self.resto.read(len(b))
        b[:len(d)] = d
        return len(d)


def leitor_csv(texto):
    primeira = texto.readline()
    sep = ';' if primeira.count(';') >= primeira.count(',') else ','
    cab = [re.sub(r'[^a-z0-9_]', '', c.strip().strip('"').lower().lstrip('#')) for c in next(csv.reader([primeira], delimiter=sep))]
    return cab, csv.reader(texto, delimiter=sep)


# ---------- geometria ----------
NUM = re.compile(r'-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?')


def wkt_poligonos(wkt):
    """POLYGON/MULTIPOLYGON (com ou sem Z) -> lista de polígonos [[anel], ...] com [lon, lat]."""
    s = wkt.strip()
    i = s.find('(')
    if i < 0:
        return []
    corpo = s[i:]
    polys = []
    # percorre os parênteses: nível 1 = multi, nível 2 = polígono, nível 3 = anel (ou 1/2 para POLYGON)
    multi = s[:i].upper().startswith('MULTI')
    prof = 0
    aneis_txt = []
    inicio = None
    for j, ch in enumerate(corpo):
        if ch == '(':
            prof += 1
            if prof == (3 if multi else 2):
                inicio = j + 1
            if prof == (2 if multi else 1):
                aneis_txt = []
        elif ch == ')':
            if prof == (3 if multi else 2) and inicio is not None:
                aneis_txt.append(corpo[inicio:j]); inicio = None
            if prof == (2 if multi else 1):
                polys.append(aneis_txt)
            prof -= 1
    out = []
    for p in polys:
        aneis = []
        for a in p:
            pts = []
            for par in a.split(','):
                n = NUM.findall(par)
                if len(n) >= 2:
                    pts.append([float(n[0]), float(n[1])])
            if len(pts) >= 4:
                aneis.append(pts)
        if aneis:
            out.append(aneis)
    # eixos trocados (lat, lon)?
    if out:
        x, y = out[0][0][0]
        if not (-75 <= x <= -28) and (-75 <= y <= -28):
            out = [[[[q[1], q[0]] for q in a] for a in p] for p in out]
    return out


def _dp(pts, tol):
    if len(pts) < 5:
        return pts
    manter = [False] * len(pts); manter[0] = manter[-1] = True
    pilha = [(0, len(pts) - 1)]
    while pilha:
        a, b = pilha.pop()
        ax, ay = pts[a]; bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        imax, dmax = -1, 0.0
        for k in range(a + 1, b):
            px, py = pts[k]
            if L == 0:
                d = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L))
                d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d > dmax:
                imax, dmax = k, d
        if imax > 0 and dmax > tol * tol:
            manter[imax] = True
            pilha += [(a, imax), (imax, b)]
    r = [p for p, m in zip(pts, manter) if m]
    return r if len(r) >= 4 else pts


def simplificar(polys, tol=0.00002):
    out = []
    for p in polys:
        aneis = []
        for a in p:
            a2 = []
            for x, y in a:
                q = [round(x, 5), round(y, 5)]
                if not a2 or a2[-1] != q:
                    a2.append(q)
            if a2[0] != a2[-1]:
                a2.append(a2[0])
            a2 = _dp(a2, tol)
            if len(a2) >= 4:
                aneis.append(a2)
        if aneis:
            out.append(aneis)
    return out


def bbox(polys):
    xs = [c[0] for p in polys for a in p for c in a]; ys = [c[1] for p in polys for a in p for c in a]
    return min(xs), min(ys), max(xs), max(ys)


def cruza(b, r):
    return not (b[2] < r[0] or b[0] > r[2] or b[3] < r[1] or b[1] > r[3])


# ---------- tabelas auxiliares ----------
DIAG = []   # amostras gravadas em data/sicor/diagnostico.txt para conferir os formatos


def chave_norm(v):
    v = (v or '').strip().strip('"')
    return v.lstrip('0') or v


def tabela(nome, chave):
    """Lê uma tabela auxiliar; chave = nome da coluna (ou a 1ª coluna, se não existir)."""
    url, t = linhas_texto(nome)
    if not t:
        log('  não encontrei', nome); return {}
    cab, rd = leitor_csv(t)
    ik = cab.index(chave) if chave in cab else next((i for i, c in enumerate(cab) if c.startswith('cd_') or c.startswith('cod')), 0)
    out, amostra = {}, []
    for l in rd:
        if len(amostra) < 3:
            amostra.append(l)
        if len(l) <= ik:
            continue
        d = {c: (l[i].strip() if i < len(l) else '') for i, c in enumerate(cab)}
        k = chave_norm(l[ik])
        if k:
            out[k] = d
    DIAG.append(f'{nome} ({url}) chave={cab[ik]} linhas={len(out)}\n  cabeçalho: {cab}\n' + ''.join(f'  {a}\n' for a in amostra))
    log('  ', nome, len(out), 'linhas, chave', cab[ik])
    return out


def campo(d, *partes):
    """Valor da primeira coluna cujo nome contém uma das partes (ex.: 'finalidade')."""
    for p in partes:
        for k, v in d.items():
            if p in k and v:
                return v
    return ''


def num(v):
    v = (v or '').strip()
    if not v:
        return None
    if ',' in v and '.' in v:
        v = v.replace('.', '').replace(',', '.')
    elif ',' in v:
        v = v.replace(',', '.')
    try:
        return float(v)
    except ValueError:
        return None


def data(v):
    v = (v or '').strip()
    m = re.match(r'(\d{4})-(\d{2})-(\d{2})', v)
    if m:
        return m.group(0)
    m = re.match(r'(\d{1,2})/(\d{1,2})/(\d{4})', v)
    if m:
        return f'{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}'
    return v[:10]


def main():
    ufs = [u.strip().upper() for u in os.environ.get('SICOR_UFS', 'MA').split(',') if u.strip()]
    regioes = [UF_BBOX[u] for u in ufs if u in UF_BBOX]
    if not regioes:
        sys.exit('Nenhum estado válido em SICOR_UFS')
    ano_ini = int(os.environ.get('SICOR_ANO_INI', '2016'))
    ano_fim = date.today().year
    log('Estados:', ufs, '| anos', ano_ini, 'a', ano_fim)

    # 1) glebas
    glebas = {}   # (ref, ordem) -> [(indice, polys)]
    anos_g = []
    for ano in range(ano_ini, ano_fim + 1):
        url, t = linhas_texto(f'DadosBrutos/sicor_glebas_wkt_{ano}.gz')
        if not t:
            log('glebas', ano, ': sem arquivo'); continue
        log('glebas', ano, url)
        cab, rd = leitor_csv(t)
        try:
            iR, iO, iI = cab.index('ref_bacen'), cab.index('nu_ordem'), cab.index('nu_indice')
            iG = next(i for i, c in enumerate(cab) if 'geometria' in c or c in ('wkt', 'geom'))
        except (ValueError, StopIteration):
            log('  cabeçalho inesperado:', cab); continue
        lidas = achadas = 0
        for l in rd:
            lidas += 1
            if len(l) <= iG:
                continue
            g = l[iG]
            # filtro rápido pelo primeiro par de coordenadas antes de montar a geometria
            n = NUM.findall(g[:120])
            if len(n) >= 2:
                x, y = float(n[0]), float(n[1])
                if not (-75 <= x <= -28):
                    x, y = y, x
                if not any(r[0] - 0.5 <= x <= r[2] + 0.5 and r[1] - 0.5 <= y <= r[3] + 0.5 for r in regioes):
                    continue
            try:
                polys = wkt_poligonos(g)
            except Exception:
                continue
            if not polys:
                continue
            b = bbox(polys)
            if not any(cruza(b, r) for r in regioes):
                continue
            polys = simplificar(polys)
            if not polys:
                continue
            glebas.setdefault((l[iR].strip(), l[iO].strip()), []).append((l[iI].strip(), polys))
            achadas += 1
        log(f'  {lidas} glebas lidas, {achadas} na região')
        anos_g.append(ano)
    if not glebas:
        sys.exit('Nenhuma gleba encontrada (o site do BCB respondeu?)')
    log('operações com gleba na região:', len(glebas))

    # 2) operações
    ops = {}
    campos = ['cnpj_if', 'dt_emissao', 'dt_vencimento', 'cd_empreendimento', 'cd_programa', 'cd_subprograma', 'cd_fonte_recurso',
              'vl_parc_credito', 'vl_area_financ', 'vl_juros', 'cd_estado']
    for ano in range(ano_ini, ano_fim + 1):
        url, t = linhas_texto(f'DadosBrutos/SICOR_OPERACAO_BASICA_ESTADO_{ano}.gz')
        if not t:
            log('operações', ano, ': sem arquivo'); continue
        log('operações', ano, url)
        cab, rd = leitor_csv(t)
        if 'ref_bacen' not in cab:
            log('  cabeçalho inesperado:', cab[:12]); continue
        iR, iO = cab.index('ref_bacen'), cab.index('nu_ordem')
        idx = {c: cab.index(c) for c in campos if c in cab}
        k = 0
        for l in rd:
            if len(l) <= iO:
                continue
            ch = (l[iR].strip(), l[iO].strip())
            if ch in glebas:
                ops[ch] = {c: (l[i].strip() if i < len(l) else '') for c, i in idx.items()}
                k += 1
        log('  ', k, 'operações ligadas às glebas')

    # 3) descrições
    log('tabelas auxiliares')
    emp = tabela('Empreendimento.csv', 'cd_empreendimento')
    prog = tabela('Programa.csv', 'cd_programa')
    ifs = {}
    for n in ('DadosBrutos/SICOR_LISTA_IFS.csv', 'SICOR_LISTA_IFS.csv', 'DadosBrutos/SICOR_LISTA_IFS.gz'):
        ifs = tabela(n, 'cnpj_if')
        if ifs:
            break
    fontes = tabela('FonteRecursos.csv', 'cd_fonte_recurso') or tabela('DadosBrutos/FonteRecursos.csv', 'cd_fonte_recurso')

    def desc_emp(cd):
        e = emp.get(chave_norm(cd)) or {}
        return [campo(e, c).strip().lower() for c in ('finalidade', 'atividade', 'modalidade', 'produto')]

    def nome_if(cnpj):
        c = (cnpj or '').strip().zfill(8)
        d = ifs.get(chave_norm(c)) or {}
        return (campo(d, 'nome') or BANCOS.get(c) or f'CNPJ {c}').strip()

    def fonte_desc(cd):
        return campo(fontes.get(chave_norm(cd)) or {}, 'desc', 'nome').strip()

    def desc_prog(cd):
        return campo(prog.get(chave_norm(cd)) or {}, 'descri', 'nome').strip()

    # 4) blocos
    if os.path.isdir(SAIDA):
        shutil.rmtree(SAIDA)
    os.makedirs(os.path.join(SAIDA, 't'))
    blocos = {}
    n_g = 0
    for ch, lista in glebas.items():
        o = ops.get(ch, {})
        fin, ativ, mod, prod = desc_emp(o.get('cd_empreendimento', '')) if o else ['', '', '', '']
        oid = f'{ch[0]}-{ch[1]}'
        op = {
            'ref': ch[0], 'ord': ch[1],
            'banco': nome_if(o.get('cnpj_if')) if o else '',
            'emissao': data(o.get('dt_emissao')), 'venc': data(o.get('dt_vencimento')),
            'valor': num(o.get('vl_parc_credito')), 'area': num(o.get('vl_area_financ')), 'juros': num(o.get('vl_juros')),
            'fin': fin, 'ativ': ativ, 'mod': mod, 'prod': prod,
            'prog': desc_prog(o.get('cd_programa', '')), 'fonte': fonte_desc(o.get('cd_fonte_recurso', '')),
            'cd_emp': o.get('cd_empreendimento', ''), 'cd_prog': o.get('cd_programa', ''),
        }
        op = {k: v for k, v in op.items() if v not in ('', None)}
        for ind, polys in lista:
            b = bbox(polys)
            n_g += 1
            for ix in range(math.floor(b[0] / TILE), math.floor(b[2] / TILE) + 1):
                for iy in range(math.floor(b[1] / TILE), math.floor(b[3] / TILE) + 1):
                    bl = blocos.setdefault(f'{ix}_{iy}', {'ops': {}, 'g': []})
                    bl['ops'][oid] = op
                    bl['g'].append([oid, ind, polys])
    for k, bl in blocos.items():
        with open(os.path.join(SAIDA, 't', k + '.json'), 'w', encoding='utf-8') as fh:
            json.dump(bl, fh, ensure_ascii=False, separators=(',', ':'))
    meta = {
        'fonte': 'Banco Central do Brasil — Sicor (dados abertos de crédito rural)',
        'gerado': date.today().isoformat(), 'ufs': ufs, 'anos': anos_g, 'tile': TILE,
        'glebas': n_g, 'operacoes': len(glebas), 'operacoes_com_dados': len(ops),
        'blocos': sorted(blocos),
    }
    ex = list(ops.items())[:5]
    DIAG.append('exemplos de operações: ' + json.dumps(ex, ensure_ascii=False))
    with open(os.path.join(SAIDA, 'diagnostico.txt'), 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(DIAG))
    with open(os.path.join(SAIDA, 'meta.json'), 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)
    tam = sum(os.path.getsize(os.path.join(SAIDA, 't', f)) for f in os.listdir(os.path.join(SAIDA, 't')))
    log(f'pronto: {n_g} glebas, {len(glebas)} operações ({len(ops)} com dados), {len(blocos)} blocos, {tam / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
