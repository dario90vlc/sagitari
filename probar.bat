@echo off
setlocal
title SAGITARI - probar y testear
cd /d "%~dp0"

echo.
echo ==================================================
echo   SAGITARI v2.1.0  -  PRUEBA PREVIA A COMPILAR
echo ==================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js no esta en el PATH. Instalalo desde https://nodejs.org
    pause
    exit /b 1
)

if not exist "node_modules\electron" (
    echo [..] Primera vez: instalando dependencias con npm install...
    call npm install
    if errorlevel 1 (
        echo [ERROR] Fallo npm install. Revisa tu conexion e intentalo de nuevo.
        pause
        exit /b 1
    )
)

echo [1/5] Comprobando sintaxis de todos los modulos...
set SYNTAX_OK=1
for %%f in (main\*.js agent\*.js renderer\app.js test\*.js scripts\*.js) do (
    node --check "%%f" >nul 2>nul
    if errorlevel 1 (
        echo    [ERROR] Sintaxis invalida: %%f
        set SYNTAX_OK=0
    )
)
if "%SYNTAX_OK%"=="0" (
    echo.
    echo [ERROR] Hay errores de sintaxis. No se puede continuar.
    pause
    exit /b 1
)
echo    OK

echo [2/5] Tests unitarios...
call npm test
if errorlevel 1 (
    echo.
    echo [ERROR] Tests en rojo. Corrige antes de lanzar la app.
    pause
    exit /b 1
)

echo [3/5] Smoke test: arranque real de la app...
call npm run smoke
if errorlevel 1 (
    echo.
    echo [ERROR] La app no arranca correctamente. Revisa el error arriba.
    pause
    exit /b 1
)

echo [4/5] Interfaz real: iconos, botones y navegacion...
call npm run uicheck
if errorlevel 1 (
    echo.
    echo [ERROR] La interfaz no responde bien - mira los FALLO de arriba.
    echo         Un script del renderer puede haber dejado de ejecutarse.
    pause
    exit /b 1
)

echo [5/5] Todo en verde. Lanzando SAGITARI...
echo.

rem SAGITARI es de instancia unica: si ya hay una abierta, el lanzamiento nuevo
rem se cierra solo y parece que "la app se cierra". Mejor avisar antes.
set YA_ABIERTA=0
tasklist /FI "IMAGENAME eq SAGITARI.exe" 2>nul | findstr /i "SAGITARI.exe" >nul
if not errorlevel 1 set YA_ABIERTA=1
tasklist /FI "IMAGENAME eq electron.exe" 2>nul | findstr /i "electron.exe" >nul
if not errorlevel 1 set YA_ABIERTA=1
if "%YA_ABIERTA%"=="1" (
    echo   [AVISO] Ya hay una instancia de SAGITARI abierta.
    echo           Al lanzar de nuevo se mostrara ESA ventana y este intento
    echo           terminara solo - no es un fallo. Cierrala primero si
    echo           quieres verlo arrancar de cero.
    echo.
)

echo   - La app se abre con normalidad (sin DevTools).
echo   - Cierra la ventana de SAGITARI para terminar este script.
echo.
call npm start

echo.
echo Sesion de pruebas terminada.
pause
