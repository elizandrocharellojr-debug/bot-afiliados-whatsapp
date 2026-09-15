@echo off
echo Testando abrir o Chrome direto, sem passar pelo Selenium...
echo.
"C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="C:\Users\jr\Desktop\bot-afiliados\teste-chrome-profile" --no-sandbox --disable-dev-shm-usage --disable-gpu --remote-debugging-port=9222 --disable-blink-features=AutomationControlled
echo.
echo Codigo de saida do Chrome: %errorlevel%
echo.
echo Se uma janela do Chrome abriu e ficou aberta, pode fechar ela normalmente.
echo Depois, ve o que apareceu aqui em cima e manda pro Claude.
pause
