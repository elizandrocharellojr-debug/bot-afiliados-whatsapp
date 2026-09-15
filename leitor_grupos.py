# -*- coding: utf-8 -*-
"""
leitor_grupos.py
=================

Le mensagens de grupos "de origem" no WhatsApp Web, acha links de produto,
troca pelo SEU link de afiliado (Amazon / Mercado Livre / Shopee) e manda o
link pronto pra VOCE MESMO no privado. So depois que voce responder
aprovando, o bot posta no seu grupo de destino.

Fluxo (PY_APROVACAO_MANUAL=sim, padrao):
  1. Abre cada grupo de origem, olha as ultimas mensagens, acha links novos.
  2. Pra cada link novo: monta o link de afiliado e manda pra voce mesmo
     (seu proprio numero) uma mensagem tipo:
         "[#7] Achado no grupo Ofertas SP:
          <link com seu afiliado>
          Responda 'sim 7' pra postar ou 'nao 7' pra ignorar."
  3. Fica de olho nas SUAS respostas nesse chat. Quando voce manda "sim 7",
     o bot posta a mensagem #7 no grupo de destino. "nao 7" so descarta.
  4. Dorme X minutos e repete.

Fluxo (PY_APROVACAO_MANUAL=nao):
  Mesma coisa, mas sempre que conseguir montar um link de afiliado
  (Amazon/ML/Shopee) posta direto no grupo de destino, sem esperar sua
  aprovacao. So cai na aprovacao manual quando o site do link nao tem
  afiliado configurado (nesse caso nao ha o que decidir sozinho).

ANTES DE RODAR
---------------
1. Instale as dependencias (uma vez so):
     pip install -r requirements.txt

2. Preencha as variaveis em CONFIGURACOES abaixo (ou no .env - ver comentario
   de cada uma). Os campos de link de afiliado (AMAZON_ASSOCIATE_TAG /
   ML_SAMPLE_AFFILIATE_LINK) sao os MESMOS que ja estao no seu .env pro bot
   Node - esse script le do mesmo arquivo, nao precisa configurar de novo.

3. Rode:
     python leitor_grupos.py
   Na primeira vez vai abrir o Chrome (janela propria, separada da que voce
   usa no dia a dia) e pedir pra escanear o QR Code do WhatsApp Web. So
   precisa fazer isso uma vez - o perfil fica salvo na pasta
   "chrome-profile-python2/" e da proxima vez abre ja logado.

AVISOS IMPORTANTES
-------------------
- Isso e automacao de navegador (Selenium controlando o Chrome), diferente
  do bot Node.js que ja existe nesta pasta (que usa o protocolo do WhatsApp
  direto, sem navegador). Rodar os dois ao mesmo tempo funciona (WhatsApp
  aceita varios dispositivos conectados), mas cada um e um "dispositivo" a
  mais logado na sua conta.
- Os seletores do WhatsApp Web (nomes de classes/atributos no HTML) mudam
  de tempos em tempos. Se o script parar de achar mensagens ou nao
  conseguir enviar, o mais provavel e que a Meta mudou algo no layout -
  nesse caso e preciso inspecionar o WhatsApp Web (F12 no navegador) e
  atualizar os seletores marcados com "# SELETOR" abaixo.
- Poste com moderacao. Intervalos curtos e volume alto aumentam a chance
  do WhatsApp marcar a conta como suspeita de automacao/spam.
- So funciona em grupos onde a conta que fizer login (a sua) ja e membro.
"""

import base64
import hashlib
import json
import os
import re
import subprocess
import time
import traceback
from pathlib import Path
from urllib.parse import urlparse, urlencode, parse_qsl, urlunparse

import requests
from selenium import webdriver
from selenium.common.exceptions import NoSuchElementException, WebDriverException
from selenium.webdriver.chrome.service import Service as ChromeService
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager

try:
    from dotenv import dotenv_values
except ImportError:
    dotenv_values = None

BASE_DIR = Path(__file__).resolve().parent

# ==========================================================================
# CONFIGURACOES - ajuste aqui ou via variaveis PY_* no .env desta pasta
# ==========================================================================
_env = dotenv_values(BASE_DIR / ".env") if dotenv_values else {}


def _env_list(key, default=""):
    raw = _env.get(key, default) or ""
    return [item.strip() for item in raw.split(",") if item.strip()]


# Nome EXATO dos grupos de origem, como aparece no WhatsApp (o script busca
# por esse nome na caixa de pesquisa). Pode preencher aqui direto ou via
# PY_GRUPOS_ORIGEM=Grupo 1,Grupo 2 no .env.
GRUPOS_DE_ORIGEM = _env_list("PY_GRUPOS_ORIGEM") or [
    "Nome do grupo 1",
    "Nome do grupo 2",
]

# Nome EXATO do seu grupo de destino (onde as ofertas aprovadas sao postadas).
GRUPO_DESTINO = _env.get("PY_GRUPO_DESTINO") or "Nome do seu grupo"

# Seu proprio numero, com DDI+DDD, so numeros (ex: 5511999999999). E pra onde
# o bot manda os links achados, esperando sua aprovacao.
MEU_NUMERO = _env.get("PY_MEU_NUMERO") or "5511999999999"

# De quantos em quantos minutos o script verifica os grupos de novo (aceita
# fracao, ex: 0.25 = 15 segundos).
INTERVALO_MINUTOS = float(_env.get("PY_INTERVALO_MINUTOS") or 15)

# Quantas mensagens recentes olhar em cada grupo por ciclo.
MENSAGENS_POR_CICLO = int(_env.get("PY_MENSAGENS_POR_CICLO") or 20)

# "sim" (padrao) = todo link achado passa por aprovacao sua no privado antes
# de ir pro grupo. "nao" = posta direto no grupo de destino sem perguntar,
# SEMPRE que conseguir montar um link de afiliado (Amazon/ML/Shopee). Links
# de sites sem afiliado configurado continuam indo pra aprovacao, porque
# nesse caso nao ha decisao automatica pra tomar.
APROVACAO_MANUAL = (_env.get("PY_APROVACAO_MANUAL") or "sim").strip().lower() not in ("nao", "não", "false", "0")

# Pausa entre posts consecutivos no grupo de destino (soh usada no modo sem
# aprovacao, quando varios links sao achados no mesmo ciclo) - evita rajada
# de mensagens, que aumenta o risco do WhatsApp marcar como automacao.
DELAY_ENTRE_POSTS_SEGUNDOS = int(_env.get("PY_DELAY_ENTRE_POSTS_SEGUNDOS") or 10)

# Reaproveita as MESMAS credenciais de afiliado que o bot Node ja usa.
AMAZON_ASSOCIATE_TAG = _env.get("AMAZON_ASSOCIATE_TAG") or ""
ML_SAMPLE_AFFILIATE_LINK = _env.get("ML_SAMPLE_AFFILIATE_LINK") or ""
SHOPEE_APP_ID = _env.get("SHOPEE_APP_ID") or ""
SHOPEE_APP_SECRET = _env.get("SHOPEE_APP_SECRET") or ""

# Caminho local do chromedriver.exe (opcional). Preenchendo isso, o script
# NAO tenta baixar/checar o driver pela internet (o que pode travar sem
# aviso se a rede bloquear esse download) - usa direto o arquivo indicado.
CHROMEDRIVER_PATH = _env.get("PY_CHROMEDRIVER_PATH") or ""

ARQUIVO_ESTADO = BASE_DIR / "data" / "leitor_estado.json"
# Pasta de perfil do Chrome (separada do seu perfil normal, onde voce
# assiste filme) - o bot abre uma janela do Chrome propria, isolada da sua.
# IMPORTANTE: fica fora da pasta Desktop de proposito. O Windows Defender
# (Controle de Pastas Acessadas / "Controlled Folder Access") protege a
# Desktop por padrao, e isso pode fazer um Chrome aberto por automacao
# (chromedriver) morrer sem aviso logo depois de abrir - o mesmo processo
# aberto por voce diretamente (duplo clique) nao tem esse problema, o que
# bate com o que vimos: o teste-chrome.bat funcionou, mas via script nao.
PERFIL_NAVEGADOR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "bot-afiliados-chrome-profile"
# Logs de diagnostico do chromedriver/Chrome (ficam na pasta do projeto, pra
# poderem ser lidos direto depois de uma falha, sem precisar copiar/colar
# do terminal).
LOG_CHROMEDRIVER = BASE_DIR / "chromedriver.log"
LOG_CHROME = BASE_DIR / "chrome_debug.log"
PASTA_IMAGENS_TMP = BASE_DIR / "data" / "imagens_tmp"

# ==========================================================================
# Estado (persistido em disco, sobrevive a reinicios do script)
# ==========================================================================
ESTADO_PADRAO = {"processadas": [], "pendentes": {}, "proximo_id": 1}


def carregar_estado():
    if ARQUIVO_ESTADO.exists():
        try:
            return json.loads(ARQUIVO_ESTADO.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            print("Aviso: nao consegui ler o estado salvo, comecando do zero.")
    return dict(ESTADO_PADRAO)


def salvar_estado(estado):
    ARQUIVO_ESTADO.parent.mkdir(parents=True, exist_ok=True)
    ARQUIVO_ESTADO.write_text(json.dumps(estado, ensure_ascii=False, indent=2), encoding="utf-8")


# ==========================================================================
# Link de afiliado - mesma logica do bot Node (src/amazonLink.js e
# src/mercadolivreLink.js), portada pra Python.
# ==========================================================================
def _set_query_param(url, key, value):
    parsed = urlparse(url)
    params = dict(parse_qsl(parsed.query))
    params[key] = value
    return urlunparse(parsed._replace(query=urlencode(params)))


def _extrair_params_ml(sample_link):
    """Le o link de exemplo do .env (ML_SAMPLE_AFFILIATE_LINK) e devolve os
    parametros de rastreamento (tag OU matt_word+matt_tool) pra reaplicar em
    qualquer produto. Mesma logica do mercadolivreLink.js."""
    if not sample_link:
        return None
    parsed = urlparse(sample_link)
    if "/sec/" in parsed.path:
        return None  # link curto por produto, nao reaplicavel
    params = dict(parse_qsl(parsed.query))
    if "tag" in params:
        return {"tag": params["tag"]}
    if "matt_word" in params and "matt_tool" in params:
        return {"matt_word": params["matt_word"], "matt_tool": params["matt_tool"]}
    return None


SHOPEE_GRAPHQL_ENDPOINT = "https://open-api.affiliate.shopee.com.br/graphql"


def _assinatura_shopee(payload):
    """Mesma assinatura usada em src/sources/shopee.js:
    SHA256(AppId + Timestamp + Payload + Secret), em hexadecimal."""
    timestamp = int(time.time())
    base = f"{SHOPEE_APP_ID}{timestamp}{payload}{SHOPEE_APP_SECRET}"
    assinatura = hashlib.sha256(base.encode("utf-8")).hexdigest()
    return timestamp, assinatura


def _gerar_link_shopee(url_produto):
    """Chama a mutation generateShortLink da Affiliate Open API da Shopee
    pra transformar um link comum de produto num link com seu afiliado.
    Docs: https://www.affiliateshopee.com.br/documentacao"""
    if not (SHOPEE_APP_ID and SHOPEE_APP_SECRET):
        return None, "SHOPEE_APP_ID/SHOPEE_APP_SECRET nao configurado no .env"

    query = (
        "mutation{generateShortLink(input:{originUrl:\"%s\",subIds:[\"whatsapp\"]}){shortLink}}"
        % url_produto.replace('"', '\\"')
    )
    payload = json.dumps({"query": query, "operationName": None, "variables": {}})
    timestamp, assinatura = _assinatura_shopee(payload)
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"SHA256 Credential={SHOPEE_APP_ID}, Timestamp={timestamp}, Signature={assinatura}",
    }

    try:
        resp = requests.post(SHOPEE_GRAPHQL_ENDPOINT, data=payload, headers=headers, timeout=15)
        resp.raise_for_status()
        dados = resp.json()
    except requests.RequestException as err:
        return None, f"erro ao chamar API da Shopee: {err}"

    if dados.get("errors"):
        return None, f"API da Shopee recusou: {dados['errors']}"

    short_link = (dados.get("data") or {}).get("generateShortLink", {}).get("shortLink")
    if not short_link:
        return None, "API da Shopee nao devolveu link (resposta vazia)"
    return short_link, None


def montar_link_afiliado(url):
    """Recebe um link de produto e devolve (link_final, aviso). "aviso" vem
    preenchido quando nao foi possivel aplicar seu afiliado (ai o link
    original e devolvido do mesmo jeito, pra voce decidir na aprovacao)."""
    try:
        dominio = urlparse(url).netloc.lower()
    except ValueError:
        return url, "link invalido"

    if "amazon." in dominio:
        if not AMAZON_ASSOCIATE_TAG:
            return url, "AMAZON_ASSOCIATE_TAG nao configurado no .env"
        return _set_query_param(url, "tag", AMAZON_ASSOCIATE_TAG), None

    if "mercadolivre." in dominio or "meli.la" in dominio or "mercadolibre." in dominio:
        url_produto = url
        if "meli.la" in dominio:
            # meli.la e um link CURTO de redirecionamento. Ele so "ja vem com
            # afiliado" quando VOCE mesmo gera ele pelo app - um link
            # meli.la copiado de outro grupo vem com o afiliado de QUEM
            # mandou, nao o seu. Por isso precisa resolver o redirecionamento
            # pra pegar a URL real do produto antes de trocar o afiliado.
            try:
                resp = requests.head(url, allow_redirects=True, timeout=10)
                url_produto = resp.url or url
                if url_produto == url:
                    # alguns servidores nao respondem bem a HEAD - tenta GET.
                    resp = requests.get(url, allow_redirects=True, timeout=10)
                    url_produto = resp.url or url
            except requests.RequestException as err:
                return url, f"nao consegui resolver o link curto meli.la ({err})"

        params = _extrair_params_ml(ML_SAMPLE_AFFILIATE_LINK)
        if not params:
            return url_produto, "ML_SAMPLE_AFFILIATE_LINK nao configurado/reconhecido no .env"

        # Remove qualquer parametro de afiliado que ja tenha vindo na URL
        # (do afiliado de quem postou a promocao original) antes de aplicar
        # o seu - senao os dois ficam misturados ou o seu e ignorado.
        parsed_produto = urlparse(url_produto)
        outros_params = {
            k: v for k, v in parse_qsl(parsed_produto.query)
            if k not in ("tag", "matt_word", "matt_tool")
        }
        url_produto = urlunparse(parsed_produto._replace(query=urlencode(outros_params)))

        final = url_produto
        for chave, valor in params.items():
            final = _set_query_param(final, chave, valor)
        return final, None

    if "shopee." in dominio or "shope.ee" in dominio:
        link, erro = _gerar_link_shopee(url)
        if erro:
            return url, erro
        return link, None

    # Outros dominios: sem geracao automatica de link de afiliado por aqui.
    # Manda o link original com aviso, pra voce trocar na mao se quiser.
    return url, "sem link de afiliado configurado pra este site"


LINK_RE = re.compile(r"https?://\S+")


def extrair_links(texto):
    return LINK_RE.findall(texto or "")


# ==========================================================================
# Selenium / WhatsApp Web
# ==========================================================================
def _matar_processos_orfaos():
    """Mata chromedriver.exe e qualquer chrome.exe que tenha sobrado aberto
    usando o NOSSO perfil (PERFIL_NAVEGADOR), de uma tentativa anterior que
    falhou/travou. Isso e uma causa muito comum do erro "DevToolsActivePort
    file doesn't exist": o chromedriver tenta abrir um Chrome novo, mas ja
    existe um chrome.exe zumbi usando esse mesmo perfil, e o Chrome novo
    fecha sozinho sem nunca abrir a porta de depuracao. Nao toca em outras
    janelas do Chrome do usuario (perfil diferente = processo ignorado).
    """
    try:
        subprocess.run(
            ["taskkill", "/f", "/im", "chromedriver.exe"],
            capture_output=True, timeout=10,
        )
    except Exception:
        pass
    try:
        # Usa so o nome da pasta do perfil (nao o caminho completo) no
        # filtro - o PowerShell nao trata "\" como caractere de escape em
        # string, entao duplicar as barras (bug da versao anterior) fazia
        # esse -like nunca bater com nada, e o chrome.exe zumbi nunca era
        # morto de verdade.
        nome_pasta_perfil = PERFIL_NAVEGADOR.name
        ps_cmd = (
            "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | "
            f"Where-Object {{ $_.CommandLine -like '*{nome_pasta_perfil}*' }} | "
            "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
        )
        subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_cmd],
            capture_output=True, timeout=15,
        )
    except Exception:
        pass
    time.sleep(1)


def _evitar_dialogo_recuperacao():
    """Se o Chrome foi fechado de forma abrupta na ultima vez (Ctrl+C no
    script, taskkill, queda de energia), ele marca o perfil como "Crashed" -
    e na proxima abertura tenta mostrar um aviso "Restaurar paginas?" ANTES
    de terminar de inicializar. O chromedriver fica esperando o arquivo
    DevToolsActivePort aparecer, ele nunca aparece (o Chrome esta parado
    nesse aviso interno), e o erro que aparece e o mesmo "DevToolsActivePort
    file doesn't exist / Chrome failed to start: crashed" - mesmo o Chrome
    nao tendo de fato crashado agora, so na vez anterior. Aqui a gente edita
    o arquivo de preferencias do perfil e marca a saida anterior como
    "normal" pra pular esse aviso.
    """
    caminho = PERFIL_NAVEGADOR / "Default" / "Preferences"
    if not caminho.exists():
        return
    try:
        dados = json.loads(caminho.read_text(encoding="utf-8"))
        perfil = dados.setdefault("profile", {})
        perfil["exit_type"] = "Normal"
        perfil["exited_cleanly"] = True
        caminho.write_text(json.dumps(dados), encoding="utf-8")
    except Exception:
        pass


def montar_driver():
    _matar_processos_orfaos()
    _evitar_dialogo_recuperacao()
    options = webdriver.ChromeOptions()
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument("--start-maximized")
    options.add_argument(f"--user-data-dir={PERFIL_NAVEGADOR}")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-gpu")
    # Log detalhado do proprio Chrome (motivo de crash, se houver) - grava em
    # chrome_debug.log na pasta do projeto.
    options.add_argument("--enable-logging")
    options.add_argument("--v=1")
    options.add_argument(f"--log-file={LOG_CHROME}")
    # NAO passar --remote-debugging-port aqui: o proprio chromedriver define
    # essa porta pra conversar com o Chrome. Passar um valor manual (mesmo
    # "=0") conflita com a porta que o chromedriver espera, e e a causa mais
    # provavel do erro "DevToolsActivePort file doesn't exist" que
    # investigamos - o Chrome abre, mas nao no endereco que o chromedriver
    # esta esperando, e ele conclui (errado) que o Chrome "crashou".

    # Se voce configurou um chromedriver manualmente (PY_CHROMEDRIVER_PATH),
    # usa ele direto - pula toda a deteccao automatica abaixo.
    if CHROMEDRIVER_PATH:
        servico = ChromeService(CHROMEDRIVER_PATH, service_args=["--verbose"], log_output=str(LOG_CHROMEDRIVER))
        return _iniciar_chrome_com_tentativas(servico, options)

    # 1a tentativa: deixa o proprio Selenium (Selenium Manager, embutido
    # desde a versao 4.6) descobrir e baixar o chromedriver certo. Ele tem
    # logica de deteccao propria, as vezes mais atualizada que a da
    # biblioteca webdriver-manager (que pode ficar presa numa versao de
    # driver que nao bate com um Chrome recem-atualizado).
    # Passamos um Service com log verboso (sem indicar o caminho do driver,
    # pra deixar o Selenium Manager continuar resolvendo ele sozinho) - assim
    # sobra um log detalhado em chromedriver.log mesmo quando falha aqui.
    try:
        servico_sm = ChromeService(service_args=["--verbose"], log_output=str(LOG_CHROMEDRIVER))
        return webdriver.Chrome(service=servico_sm, options=options)
    except WebDriverException as err:
        print(f"  Selenium Manager nao conseguiu iniciar o Chrome ({err}). Tentando com webdriver-manager...")

    # 2a tentativa: usa a biblioteca webdriver-manager pra baixar/cachear o
    # driver manualmente.
    caminho_driver = ChromeDriverManager().install()
    servico_wm = ChromeService(caminho_driver, service_args=["--verbose"], log_output=str(LOG_CHROMEDRIVER))
    return _iniciar_chrome_com_tentativas(servico_wm, options)


def _iniciar_chrome_com_tentativas(service, options):
    # "Chrome failed to start: crashed" / "DevToolsActivePort file doesn't
    # exist" costuma ser o Windows ainda liberando o processo/travas de
    # arquivo do Chrome anterior (ou duas instancias deste script tentando
    # usar o MESMO perfil ao mesmo tempo - so pode ter UM leitor_grupos.py
    # rodando por vez). Tenta de novo algumas vezes com pausa antes de
    # desistir, em vez de falhar na primeira tentativa.
    ultimo_erro = None
    for tentativa in range(1, 4):
        # Limpa ANTES de cada tentativa (nao so depois de falhar) - evita
        # que um chrome.exe deixado por uma tentativa anterior (inclusive a
        # do Selenium Manager, antes de cair aqui) ainda esteja de pe e
        # trave a proxima com o mesmo perfil (Chrome.ProcessSingleton).
        _matar_processos_orfaos()
        _evitar_dialogo_recuperacao()
        try:
            return webdriver.Chrome(service=service, options=options)
        except WebDriverException as err:
            ultimo_erro = err
            print(f"  Chrome nao iniciou (tentativa {tentativa}/3), tentando de novo em 5s...")
            time.sleep(5)
    raise ultimo_erro


# O WhatsApp Web muda os nomes de classe/atributo do HTML de tempos em
# tempos (ex: "data-tab"), o que quebra seletores fixos. Pra cada elemento
# importante, mantemos uma LISTA de seletores candidatos - o script tenta
# todos em ordem e usa o primeiro que aparecer na tela. Se nenhum funcionar
# mais, e sinal de que precisa adicionar um seletor novo aqui (inspecione
# com F12 no Chrome pra achar o atual).
SELETORES_TELA_PRONTA = [
    "#pane-side",
    "#side",
    'div[aria-label="Lista de conversas"]',
    'input[data-tab="3"]',
]
# Confirmado em jul/2026: a caixa de busca virou um <input> de verdade (antes
# era um <div contenteditable>). Mantemos o seletor antigo por ultimo, como
# fallback, caso o WhatsApp volte pro formato antigo em algum dispositivo.
SELETORES_CAIXA_BUSCA = [
    'input[data-tab="3"]',
    'input[aria-label="Pesquisar ou começar uma nova conversa"]',
    'div[contenteditable="true"][data-tab="3"]',
]
SELETORES_CAIXA_MENSAGEM = [
    'div[contenteditable="true"][data-tab="10"]',
    'div[aria-placeholder="Digite uma mensagem"]',
    'footer div[contenteditable="true"][role="textbox"]',
]


def _esperar_qualquer(driver, seletores, timeout=20, aviso_progresso=None):
    """Tenta cada seletor da lista repetidamente por at maximo "timeout"
    segundos, e devolve o primeiro elemento que aparecer. Levanta TimeoutError
    com a lista de seletores tentados se nenhum aparecer - isso ajuda a saber
    qual seletor precisa ser atualizado."""
    fim = time.time() + timeout
    ultimo_aviso = time.time()
    while time.time() < fim:
        for seletor in seletores:
            elementos = driver.find_elements(By.CSS_SELECTOR, seletor)
            if elementos:
                return elementos[0]
        if aviso_progresso and time.time() - ultimo_aviso > 20:
            print(aviso_progresso)
            ultimo_aviso = time.time()
        time.sleep(0.5)
    raise TimeoutError(f"nenhum destes seletores apareceu na tela: {seletores}")


def esperar_whatsapp_pronto(driver):
    driver.get("https://web.whatsapp.com")
    print("Se pedir QR Code, escaneie com o WhatsApp do celular (so na primeira vez).")
    _esperar_qualquer(
        driver,
        SELETORES_TELA_PRONTA,
        timeout=120,
        aviso_progresso="  Ainda esperando o WhatsApp Web carregar/logar (escaneou o QR Code?)...",
    )
    time.sleep(2)


_JS_DEFINIR_TEXTO = """
const el = arguments[0], texto = arguments[1];
if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, texto);
    el.dispatchEvent(new Event('input', { bubbles: true }));
} else {
    el.focus();
    el.textContent = texto;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: texto, inputType: 'insertText' }));
}
"""


def _definir_texto(driver, elemento, texto):
    """Preenche um campo via JavaScript em vez de send_keys - o send_keys
    as vezes engole acentos (ã, ç, õ etc.) dependendo do layout de teclado
    configurado no Windows, o que fazia a busca de grupo falhar em
    silencio (procurava um nome errado e abria/nao-abria o chat errado)."""
    elemento.click()
    driver.execute_script(_JS_DEFINIR_TEXTO, elemento, texto)


def abrir_grupo_por_nome(driver, nome):
    try:
        busca = _esperar_qualquer(driver, SELETORES_CAIXA_BUSCA, timeout=20)
    except TimeoutError:
        raise RuntimeError("nao encontrei a caixa de busca de conversas do WhatsApp Web")
    _definir_texto(driver, busca, nome)
    time.sleep(2)

    # SELETOR: primeiro resultado da busca (confirmado jul/2026: os
    # resultados sao linhas com role="row" dentro de um role="grid").
    resultados = driver.find_elements(By.CSS_SELECTOR, "div[role='row']")
    if not resultados:
        busca.send_keys(Keys.ESCAPE)
        raise RuntimeError(f'Grupo "{nome}" nao encontrado na busca (nome bate exatamente com o do WhatsApp?)')

    # Prefere o resultado cujo texto contem o nome do grupo (evita abrir uma
    # conversa/contato errado quando a busca devolve varias linhas - ex: uma
    # mensagem antiga que MENCIONA o nome do grupo, em vez do grupo em si).
    alvo = resultados[0]
    for r in resultados:
        if nome.strip().lower() in (r.text or "").strip().lower():
            alvo = r
            break
    alvo.click()

    # Espera a conversa carregar de verdade (com perfil novo, o WhatsApp Web
    # pode levar alguns segundos pra sincronizar o historico de cada grupo -
    # um sleep fixo de 2s nao era suficiente e fazia o script achar "0
    # mensagens" mesmo em grupos com historico).
    fim = time.time() + 8
    while time.time() < fim:
        if driver.find_elements(By.CSS_SELECTOR, "div.copyable-text"):
            break
        time.sleep(0.5)


def abrir_chat_por_numero(driver, numero):
    # WhatsApp permite abrir/criar uma conversa direto por numero, inclusive
    # com o seu proprio (recurso "mensagem para voce mesmo").
    driver.get(f"https://web.whatsapp.com/send?phone={numero}")
    _esperar_qualquer(driver, SELETORES_CAIXA_MENSAGEM, timeout=30)
    time.sleep(2)


def ler_mensagens_atuais(driver, limite, chaves_conhecidas=None):
    # SELETOR: cada mensagem no historico tem um container com atributo
    # data-pre-plain-text (texto) dentro de um bloco com data-id (a mensagem
    # inteira, que pode tambem ter uma imagem). Se essa lista vier vazia
    # sempre, e sinal de que o WhatsApp Web mudou esse nome de classe - dai
    # e preciso abrir o F12 no Chrome e achar o novo seletor.
    chaves_conhecidas = chaves_conhecidas or set()
    containers = driver.find_elements(By.CSS_SELECTOR, "div.copyable-text")
    mensagens = []
    for c in containers[-limite:]:
        pre = c.get_attribute("data-pre-plain-text") or ""
        # Usa so os spans "selectable-text" (o texto da mensagem em si) em
        # vez de c.text inteiro - c.text pega TUDO dentro do balao, incluindo
        # nome/numero de quem mandou (mostrado em grupos) e o horario, que
        # nao fazem parte da mensagem e nao devem ir pro grupo de destino.
        spans_texto = c.find_elements(By.CSS_SELECTOR, "span.selectable-text")
        if spans_texto:
            texto = "\n".join(s.text for s in spans_texto if s.text.strip()).strip()
        else:
            texto = c.text.strip()
        if not texto:
            continue
        chave = pre + "|" + texto[:200]
        # A imagem e extraida JA AQUI, na hora, e nao mais depois (durante o
        # processamento do link de afiliado, que pode levar varios segundos
        # com chamadas de rede). O WhatsApp Web reaproveita/recicla os nodes
        # do DOM conforme a lista rola (virtual scroll) - se esperar demais
        # pra ler a imagem, o elemento pode ja estar mostrando OUTRA
        # mensagem, e o bot manda a foto errada ou nenhuma das duas.
        # So baixa a imagem de mensagens NOVAS (as ja processadas antes so
        # servem pra dedupe, nao precisam gastar tempo/rede de novo).
        imagem_b64 = None
        if chave not in chaves_conhecidas:
            imagem_b64 = _extrair_imagem_base64(driver, c)
        mensagens.append({"chave": chave, "texto": texto, "elemento": c, "imagem_b64": imagem_b64})
    return mensagens


def _extrair_imagem_base64(driver, elemento_texto):
    """Se a mensagem tiver uma foto (ex: print/foto do produto), tenta
    baixar ela (via JS, porque o WhatsApp Web usa "blob:" que so existe na
    memoria do navegador) e devolve o conteudo em base64. Devolve None se
    nao achar imagem ou se falhar - nesse caso o texto ainda e enviado
    normalmente, so sem a foto. Imprime o motivo de cada falha (em vez de
    so voltar None em silencio) pra dar pra saber, pelo log do terminal,
    exatamente onde quebrou se o WhatsApp Web mudar esse HTML de novo.
    """
    bolha = None
    for xpath_ancestor in ("./ancestor::div[@data-id][1]", "./ancestor::div[@role='row'][1]"):
        try:
            bolha = elemento_texto.find_element(By.XPATH, xpath_ancestor)
            break
        except NoSuchElementException:
            continue
    if bolha is None:
        print("    [imagem] nao achei o balao da mensagem (nem data-id nem role=row).")
        return None

    # Pega a MAIOR <img> de verdade dentro do balao (a foto do produto),
    # ignorando emoji/avatar/icones pequenos - fazer isso via JS (em vez de
    # so filtrar por classe "emoji") e mais resistente a mudancas de HTML.
    script_achar_img = """
        const bolha = arguments[0];
        const imgs = Array.from(bolha.querySelectorAll('img'));
        let melhor = null, maior = 0;
        for (const img of imgs) {
            if (img.className && String(img.className).toLowerCase().includes('emoji')) continue;
            const area = (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0);
            if (area > maior) { maior = area; melhor = img; }
        }
        return melhor ? melhor.src : null;
    """
    try:
        src = driver.execute_script(script_achar_img, bolha) or ""
    except Exception as err:
        print(f"    [imagem] erro procurando <img> no balao: {err}")
        return None

    if not src:
        print("    [imagem] essa mensagem nao tem foto (nenhuma <img> relevante achada no balao).")
        return None
    if not (src.startswith("blob:") or src.startswith("data:")):
        print(f"    [imagem] achei uma <img>, mas o src nao e blob/data (comeca com: {src[:40]!r}).")
        return None

    script = """
        var done = arguments[arguments.length - 1];
        fetch(arguments[0]).then(function(r){ return r.blob(); }).then(function(blob){
            var reader = new FileReader();
            reader.onloadend = function(){ done(reader.result); };
            reader.readAsDataURL(blob);
        }).catch(function(){ done(null); });
    """
    try:
        data_url = driver.execute_async_script(script, src)
    except Exception as err:
        print(f"    [imagem] erro baixando a imagem via JS: {err}")
        return None

    if not data_url or "," not in data_url:
        print("    [imagem] download da imagem veio vazio.")
        return None
    return data_url.split(",", 1)[1]


def _salvar_imagem_temp(b64data, nome):
    PASTA_IMAGENS_TMP.mkdir(parents=True, exist_ok=True)
    caminho = PASTA_IMAGENS_TMP / f"{nome}.jpg"
    caminho.write_bytes(base64.b64decode(b64data))
    return caminho


def _limpar_imagem_temp(caminho):
    if not caminho:
        return
    try:
        Path(caminho).unlink(missing_ok=True)
    except Exception:
        pass


def enviar_mensagem(driver, texto):
    caixa = _esperar_qualquer(driver, SELETORES_CAIXA_MENSAGEM, timeout=20)
    caixa.click()
    for linha in texto.split("\n"):
        caixa.send_keys(linha)
        caixa.send_keys(Keys.SHIFT, Keys.ENTER)
    caixa.send_keys(Keys.ENTER)
    time.sleep(2)


def _achar_input_de_arquivo(driver):
    # Tenta achar o input de imagem escondido direto; se nao estiver no DOM
    # ainda, clica no botao de anexar pra ele aparecer.
    try:
        return driver.find_element(By.CSS_SELECTOR, "input[type='file'][accept*='image']")
    except NoSuchElementException:
        pass

    # SELETOR: botao de anexar (icone de "+"/clipe) na barra de digitar.
    for seletor in ["span[data-icon='plus-rounded']", "span[data-icon='clip']", "div[title='Anexar']"]:
        botoes = driver.find_elements(By.CSS_SELECTOR, seletor)
        if botoes:
            botoes[0].click()
            time.sleep(1)
            break

    try:
        return WebDriverWait(driver, 5).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, "input[type='file'][accept*='image']"))
        )
    except Exception:
        return None


def enviar_mensagem_com_imagem(driver, caminho_imagem, legenda):
    input_arquivo = _achar_input_de_arquivo(driver)
    if input_arquivo is None:
        raise RuntimeError("nao encontrei o campo de anexar imagem no WhatsApp Web")

    input_arquivo.send_keys(str(Path(caminho_imagem).resolve()))

    # SELETOR: caixa de legenda que aparece depois de escolher a imagem.
    caixa_legenda = _esperar_qualquer(driver, SELETORES_CAIXA_MENSAGEM, timeout=20)
    caixa_legenda.click()
    for linha in legenda.split("\n"):
        caixa_legenda.send_keys(linha)
        caixa_legenda.send_keys(Keys.SHIFT, Keys.ENTER)
    caixa_legenda.send_keys(Keys.ENTER)
    time.sleep(2)


def enviar_promocao(driver, texto, imagem_path=None):
    """Manda com imagem se tiver uma disponivel; se falhar por qualquer
    motivo (seletor mudou, imagem corrompida etc.), cai pro envio so de
    texto em vez de perder a promocao inteira."""
    if imagem_path and Path(imagem_path).exists():
        try:
            enviar_mensagem_com_imagem(driver, imagem_path, texto)
            return
        except Exception as err:
            print(f"    Nao consegui mandar com imagem, mandando so o texto ({err}).")
    enviar_mensagem(driver, texto)


# ==========================================================================
# Ciclo principal
# ==========================================================================
PADRAO_RESPOSTA = re.compile(r"\b(sim|ok|aprovar)\s+(\d+)\b|\b(nao|não|ignorar)\s+(\d+)\b", re.IGNORECASE)


def montar_mensagem_aprovacao(id_pendente, grupo_origem, texto_final, aviso):
    aviso_txt = f"\n\nAtencao: {aviso}" if aviso else ""
    return (
        f'[#{id_pendente}] Achado no grupo "{grupo_origem}":\n\n'
        f"{texto_final}"
        f"{aviso_txt}\n\n"
        f'Responda "sim {id_pendente}" pra postar no grupo de destino, ou "nao {id_pendente}" pra ignorar.'
    )


def processar_grupos_origem(driver, estado):
    for grupo in GRUPOS_DE_ORIGEM:
        print(f"Verificando grupo de origem: {grupo}")
        try:
            abrir_grupo_por_nome(driver, grupo)
        except RuntimeError as err:
            print(f"  {err}")
            continue

        mensagens = ler_mensagens_atuais(driver, MENSAGENS_POR_CICLO, set(estado["processadas"]))
        print(f"  {len(mensagens)} mensagem(ns) recente(s) lida(s) nesse grupo.")

        for msg in mensagens:
            if msg["chave"] in estado["processadas"]:
                continue

            links = extrair_links(msg["texto"])
            if not links:
                # nada pra fazer com essa mensagem - marca como vista e segue.
                estado["processadas"].append(msg["chave"])
                continue

            # Simplificacao: se a mensagem tiver mais de um link, so o
            # primeiro e convertido/enviado.
            link_original = links[0]

            try:
                link_final, aviso = montar_link_afiliado(link_original)
                texto_final = msg["texto"].replace(link_original, link_final)
                imagem_path = None
                b64 = msg.get("imagem_b64")
                if b64:
                    imagem_path = str(_salvar_imagem_temp(b64, f"origem_{estado['proximo_id']}"))

                if not APROVACAO_MANUAL and not aviso:
                    # Modo automatico: ja tem link de afiliado, posta direto
                    # no grupo de destino sem esperar aprovacao.
                    abrir_grupo_por_nome(driver, GRUPO_DESTINO)
                    enviar_promocao(driver, texto_final, imagem_path)
                    print(f"  Postado automaticamente no grupo de destino: {link_final}")
                    time.sleep(DELAY_ENTRE_POSTS_SEGUNDOS)
                    abrir_grupo_por_nome(driver, grupo)
                    _limpar_imagem_temp(imagem_path)
                else:
                    # Link sem afiliado configurado (ou aprovacao manual
                    # ligada) - manda pra voce decidir no privado.
                    id_pendente = str(estado["proximo_id"])
                    estado["proximo_id"] += 1
                    estado["pendentes"][id_pendente] = {
                        "grupo_origem": grupo,
                        "texto_final": texto_final,
                        "imagem": imagem_path,
                    }
                    abrir_chat_por_numero(driver, MEU_NUMERO)
                    enviar_promocao(driver, montar_mensagem_aprovacao(id_pendente, grupo, texto_final, aviso), imagem_path)
                    print(f"  Mandei #{id_pendente} pra aprovacao.")
                    abrir_grupo_por_nome(driver, grupo)

                # So marca como processada se tudo deu certo ate aqui - se
                # algo falhou (excecao abaixo), fica pendente pra tentar de
                # novo no proximo ciclo, em vez de sumir pra sempre.
                estado["processadas"].append(msg["chave"])
            except Exception as err:
                print(f"  Erro ao processar essa mensagem, vou tentar de novo no proximo ciclo: {err}")

        # limita o tamanho do historico de dedupe pra nao crescer pra sempre
        estado["processadas"] = estado["processadas"][-2000:]
        salvar_estado(estado)


def processar_aprovacoes(driver, estado):
    if not estado["pendentes"]:
        return

    print("Verificando suas respostas de aprovacao...")
    abrir_chat_por_numero(driver, MEU_NUMERO)
    mensagens = ler_mensagens_atuais(driver, 50)

    for msg in mensagens:
        m = PADRAO_RESPOSTA.search(msg["texto"])
        if not m:
            continue
        if msg["chave"] in estado["processadas"]:
            continue

        aprovado = bool(m.group(1))
        id_pendente = m.group(2) or m.group(4)
        pendente = estado["pendentes"].get(id_pendente)
        if not pendente:
            continue

        try:
            if aprovado:
                print(f"  Aprovado #{id_pendente}, postando no grupo de destino...")
                abrir_grupo_por_nome(driver, GRUPO_DESTINO)
                enviar_promocao(driver, pendente["texto_final"], pendente.get("imagem"))
                print("  Postado com sucesso.")
            else:
                print(f"  Ignorado #{id_pendente}.")

            estado["processadas"].append(msg["chave"])
            _limpar_imagem_temp(pendente.get("imagem"))
            del estado["pendentes"][id_pendente]
        except Exception as err:
            print(f"  Erro ao postar #{id_pendente}, vou tentar de novo no proximo ciclo: {err}")

    salvar_estado(estado)


def _fechar_driver_silenciosamente(driver):
    try:
        driver.quit()
    except Exception:
        pass


def main():
    estado = carregar_estado()
    driver = montar_driver()
    esperar_whatsapp_pronto(driver)

    try:
        while True:
            print("\n=== Novo ciclo ===")
            try:
                processar_grupos_origem(driver, estado)
                processar_aprovacoes(driver, estado)
            except WebDriverException as err:
                # A janela do Chrome foi fechada (por voce ou por algum crash)
                # ou a sessao morreu por outro motivo - abre um Chrome novo e
                # continua de onde parou, em vez de derrubar o script inteiro.
                print(f"  Chrome/WhatsApp Web parece ter fechado ou travado: {err}")
                print("  Abrindo o navegador de novo...")
                _fechar_driver_silenciosamente(driver)
                salvar_estado(estado)
                driver = montar_driver()
                esperar_whatsapp_pronto(driver)
                continue
            except Exception:
                # Qualquer outro erro inesperado (ex: selector do WhatsApp Web
                # mudou) NAO deve derrubar o bot inteiro - registra e tenta de
                # novo no proximo ciclo.
                print("  Erro inesperado neste ciclo (o bot vai tentar de novo no proximo ciclo):")
                traceback.print_exc()

            salvar_estado(estado)
            print(f"Aguardando {INTERVALO_MINUTOS} minuto(s)...\n")
            time.sleep(INTERVALO_MINUTOS * 60)
    except KeyboardInterrupt:
        print("Encerrando (Ctrl+C).")
    finally:
        salvar_estado(estado)
        _fechar_driver_silenciosamente(driver)


if __name__ == "__main__":
    main()
