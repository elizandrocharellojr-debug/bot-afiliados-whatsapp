import re
import time
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from webdriver_manager.chrome import ChromeDriverManager

# ===== CONFIGURAÇÕES =====
# Substitua abaixo:
SEU_LINK_AFILIADOS = "https://exemplo.com?ref=SEU_CODIGO"  # Coloque seu link de afiliados aqui
GRUPOS_DE_ORIGEM = [
    {"nome": "grupo1", "url": "https://web.whatsapp.com/join/group/XXXXXXXX"},  # Substitua XXXXXXXX pelo código do grupo
    {"nome": "grupo2", "url": "https://web.whatsapp.com/join/group/YYYYYYYY"}   # Adicione mais grupos se quiser
]
GRUPO_DESTINO = "+5511999999999"  # Número do seu grupo de destino com DDD (ex: +5511999999999)
# ========================

# Configurar o Chrome sem ser detectado
options = webdriver.ChromeOptions()
options.add_argument("--disable-blink-features=AutomationControlled")
options.add_argument("--start-maximized")

def extrair_promocoes(url_grupo):
    driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=options)
    driver.get(url_grupo)
    time.sleep(20)  # Aguarda você logar manualmente no WhatsApp Web

    # Buscar o grupo
    busca = driver.find_element(By.XPATH, '//div[@contenteditable="true"][1]')
    busca.send_keys(url_grupo.split("/")[-1])  # Extrai o nome do grupo da URL
    time.sleep(2)
    busca.send_keys(Keys.ENTER)
    time.sleep(5)

    # Extrair as últimas 5 mensagens com links
    promocoes = driver.find_elements(By.XPATH, '//div[@dir="auto"][@class=""]')
    promocoes_filtradas = [p.text for p in promocoes if "http" in p.text]

    driver.quit()
    return promocoes_filtradas[-5:]  # Retorna as últimas 5 promoções

def substituir_link(promocoes):
    promocoes_atualizadas = []
    for promo in promocoes:
        # Remove parâmetros antigos e adiciona seu link
        url_limpa = re.sub(r'\?.*', '', promo)
        promocoes_atualizadas.append(f"{url_limpa}{SEU_LINK_AFILIADOS}")
    return promocoes_atualizadas

def enviar_para_grupo_de_destino(promocoes):
    for promo in promocoes:
        print(f"Enviando: {promo}")
        time.sleep(3)  # Pequena pausa para evitar problemas

# Loop principal
while True:
    print("=== Iniciando verificação das promoções ===")
    todas_promocoes = []

    for grupo in GRUPOS_DE_ORIGEM:
        print(f"Verificando grupo: {grupo['nome']}")
        promocoes_grupo = extrair_promocoes(grupo["url"])
        todas_promocoes.extend(promocoes_grupo)
        time.sleep(10)  # Evita sobrecarga

    if todas_promocoes:
        print("\nPromoções encontradas:")
        promocoes_atualizadas = substituir_link(todas_promocoes)
        for idx, promo in enumerate(promocoes_atualizadas, 1):
            print(f"{idx}. {promo}")

        enviar_para_grupo_de_destino(promocoes_atualizadas)
    else:
        print("Nenhuma promoção encontrada.")

    print("\nAguardando 30 minutos para próxima verificação...\n")
    time.sleep(1800)  # Aguarda 30 minutos antes de verificar novamente
