# Bot de Afiliados para WhatsApp

Bot que monitora grupos do WhatsApp, identifica promoções em lojas online (Amazon, Mercado Livre e Shopee), converte os links em links de afiliado e publica automaticamente as ofertas em grupos do WhatsApp e/ou canais do Telegram. Inclui um painel web para gerenciar grupos de origem/destino e uma extensão de navegador auxiliar.

## Funcionalidades

- **Leitura de grupos do WhatsApp**: conecta-se via `whatsapp-web.js` e monitora grupos configurados em busca de links de produtos.
- **Deduplicação de promoções**: evita reenviar a mesma oferta várias vezes.
- **Geração de links de afiliado**: cria automaticamente links de afiliado para Amazon, Mercado Livre e Shopee, incluindo encurtamento de URL.
- **Publicação automática**: envia as promoções formatadas para grupos do WhatsApp e/ou canais do Telegram.
- **Painel web**: interface local para configurar grupos de origem e destino e acompanhar o funcionamento do bot.
- **Extensão de navegador**: auxilia na captura manual de promoções direto do navegador.
- **Deploy pronto para produção**: inclui `Dockerfile` e configuração para Railway.

## Arquitetura

```
index.js                 # Ponto de entrada do bot
src/
  config.js               # Configurações gerais
  groupReader.js           # Leitura e monitoramento dos grupos do WhatsApp
  scheduler.js              # Agendamento de tarefas
  promoStore.js             # Armazenamento/dedupe de promoções
  shorten.js                # Encurtamento de links
  telegram.js                # Integração com Telegram
  painel.js                   # Servidor do painel web
  sources/                     # Extração de promoções por loja (Amazon, Mercado Livre, Shopee)
  whatsapp/                    # Conexão e envio de mensagens no WhatsApp
scripts/                  # Scripts utilitários (setup, testes de integração, vínculo de contas)
extension/                # Extensão de navegador auxiliar
copiador_promocoes.py     # Utilitário em Python para captura de promocoes
leitor_grupos.py          # Utilitário em Python para leitura de grupos
```

## Tecnologias

- Node.js
- whatsapp-web.js
- Python (utilitários auxiliares)
- Docker / Railway (deploy)

## Como rodar

Veja o passo a passo detalhado em [`COMO_RODAR.txt`](./COMO_RODAR.txt) e as instruções de deploy em [`DEPLOY_RAILWAY.txt`](./DEPLOY_RAILWAY.txt).

Resumo:

```bash
npm install
cp .env.example .env   # preencha as variáveis necessárias
npm start
```

Na primeira execução será necessário escanear o QR Code do WhatsApp para autenticar o bot.

## Variáveis de ambiente

Veja [`.env.example`](./.env.example) para a lista completa de variáveis necessárias (tokens do Telegram, configurações de afiliados, etc). Nenhuma credencial real está incluída neste repositório.

---

Projeto pessoal desenvolvido para automatizar a curadoria e divulgação de promoções.
