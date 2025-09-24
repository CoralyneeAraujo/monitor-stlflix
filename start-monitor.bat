@echo off
echo ====================================
echo Iniciando Monitoramento Node (porta 3000)
echo ====================================

:: Caminho do Node (ajuste se usa nvm ou instalação custom)
set NODE_PATH=C:\Program Files\nodejs\node.exe

:: Caminho do seu projeto
cd /d "C:\caminho\do\projeto"

:: Start do servidor
start "" "%NODE_PATH%" server.js

:: Espera alguns segundos para garantir que subiu
timeout /t 5 >nul

:: Abre no navegador (http://localhost:3000)
start "" "http://localhost:3000"

echo Servidor rodando em segundo plano!
pause
