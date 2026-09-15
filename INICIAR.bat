@echo off
chcp 65001 >nul
title Bot Afiliados - Oferta Ninja

REM "%~dp0" = a pasta onde ESTE arquivo esta. Por isso funciona em qualquer
REM maquina, qualquer usuario, qualquer disco - sem caminho fixo.
cd /d "%~dp0"

echo ============================================
echo   BOT AFILIADOS - Oferta Ninja
echo ============================================
echo   Pasta: %CD%
echo.

REM O Node esta instalado?
where node >nul 2>nul
if errorlevel 1 (
  echo [X] O Node.js nao esta instalado nesta maquina.
  echo.
  echo     Baixe a versao LTS em https://nodejs.org
  echo     Instale, feche esta janela e abra o INICIAR.bat de novo.
  echo.
  pause
  exit /b 1
)

REM Prepara o que faltar (dependencias, navegador, .env).
call npm run preparar
if errorlevel 1 (
  echo.
  echo [X] A preparacao encontrou um problema. Leia as mensagens acima.
  echo.
  pause
  exit /b 1
)

REM Sem sessao do WhatsApp? Faz o pareamento pelo QR antes de subir.
if not exist "auth" (
  echo.
  echo ============================================
  echo   PRIMEIRA VEZ: conectar o WhatsApp
  echo ============================================
  echo   Um QR code vai aparecer. No celular:
  echo   WhatsApp ^> Aparelhos conectados ^> Conectar aparelho
  echo.
  echo   Depois escolha o grupo de destino na lista.
  echo.
  pause
  call npm run setup-whatsapp
)

REM Janela do Mercado Livre (login/geracao de link) abre pelo Google Chrome,
REM nao pelo Edge - perfil proprio, separado do Chrome que voce usa no dia a
REM dia (na primeira vez vai pedir login no Mercado Livre de novo, so uma vez).
set ML_NAVEGADOR_CHANNEL=chrome
set ML_PERFIL_DIR=C:\Users\Pietro\AppData\Local\bot-afiliados-ml-browser-chrome

echo.
echo ============================================
echo   LIGANDO O BOT
echo ============================================
echo   Deixe esta janela ABERTA. Para desligar: Ctrl + C
echo.
call npm start

echo.
echo O bot foi encerrado.
pause
