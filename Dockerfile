# Imagem pra rodar o bot num servidor na nuvem (Railway) - Linux, sem tela.
# No seu PC (Windows) voce continua usando o INICIAR.bat normal; esse
# Dockerfile so importa pra quem for fazer o deploy no Railway.
FROM node:22-slim

# Bibliotecas de sistema que o Chromium do Playwright precisa pra RODAR
# (mesmo sem janela/headless) - sem isso ele nem abre no Linux.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 \
    libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 \
    libnspr4 libnss3 libxcomposite1 libxdamage1 libxfixes3 \
    libxkbcommon0 libxrandr2 xdg-utils wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# So o package.json primeiro - assim o Docker reaproveita essa camada
# (npm install) entre deploys quando so o CODIGO muda, nao as dependencias.
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Baixa o Chromium do Playwright (sem "msedge" - so existe no Windows).
RUN npx playwright install chromium

# Pasta onde o Volume persistente do Railway e' montado (configure isso nas
# configuracoes do servico, em "Volumes" -> Mount Path: /app/storage). Ver
# DEPLOY_RAILWAY.txt pro passo a passo completo.
ENV DADOS_DIR=/app/storage/data
ENV WHATSAPP_AUTH_DIR=/app/storage/auth
ENV ML_PERFIL_DIR=/app/storage/ml-browser-perfil
ENV ML_NAVEGADOR_HEADLESS=sim
ENV ML_NAVEGADOR_CHANNEL=

CMD ["node", "index.js"]
