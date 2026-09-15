@echo off
chcp 65001 >nul
title Bot Afiliados - Oferta Ninja

REM Usa a pasta deste arquivo - funciona em qualquer maquina.
cd /d "%~dp0"

echo ============================================
echo   BOT AFILIADOS - Oferta Ninja
echo ============================================
echo.
echo   Uma janela so - o tunel pra usar fora de casa (dados moveis)
echo   sobe sozinho junto com o bot. Procure no terminal, mais abaixo,
echo   a linha "PAINEL FORA DE CASA".
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [X] O Node.js nao esta instalado. Baixe em https://nodejs.org
  pause
  exit /b 1
)

call npm run preparar
if errorlevel 1 (
  echo [X] A preparacao encontrou um problema. Leia as mensagens acima.
  pause
  exit /b 1
)

if not exist "auth" (
  echo.
  echo PRIMEIRA VEZ: vamos conectar o WhatsApp pelo QR code.
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
