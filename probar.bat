@echo off
setlocal
title SAGITARI - probar y testear
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto sin_node

rem La version se lee de package.json: el banner no puede mentir.
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set VERSION=%%v

rem ---------------------------------------------------------------------------
rem  MODO RAPIDO:  probar.bat rapido     (o probar.bat -r)
rem  Comprueba la sintaxis (un segundo: evita abrir una ventana en blanco por
rem  una edicion a medias) y abre la app. Se salta tests, smoke y ui-check,
rem  que son los que tardan minutos y escriben cientos de lineas.
rem ---------------------------------------------------------------------------
set RAPIDO=0
if /i "%~1"=="rapido" set RAPIDO=1
if /i "%~1"=="-r" set RAPIDO=1

echo.
echo ==================================================
if "%RAPIDO%"=="1" echo   SAGITARI v%VERSION%  -  ARRANQUE RAPIDO
if "%RAPIDO%"=="0" echo   SAGITARI v%VERSION%  -  PRUEBA PREVIA A COMPILAR
echo ==================================================
if "%RAPIDO%"=="1" echo   Sin tests ni ui-check. Para la bateria completa: probar.bat
echo.

if not exist "node_modules\electron" goto instalar

:tras_instalar
rem La salida de cada paso va al log: antes eran cientos de lineas en la consola
rem y el fallo de verdad se perdia entre ellas. En pantalla queda el resumen y
rem la ruta del log; si algo falla, ahi esta TODO.
set LOG=%TEMP%\sagitari-probar.log

set PASO=Sintaxis de los modulos
echo [paso 1] %PASO% ...
set SYNTAX_OK=1
for %%f in (main\*.js agent\*.js renderer\*.js test\*.js scripts\*.js) do (
    node --check "%%f" >nul 2>nul
    if errorlevel 1 (
        echo    [ERROR] Sintaxis invalida: %%f
        set SYNTAX_OK=0
    )
)
if "%SYNTAX_OK%"=="0" goto sintaxis_mal
echo    OK

if "%RAPIDO%"=="1" goto lanzar

set PASO=Tests unitarios
echo [paso 2] %PASO% ...
rem El resumen del paso se lee del log: la ultima linea de la salida ya dice
rem cuantos tests pasaron (o que fallaron).
call npm test > "%LOG%" 2>&1
if errorlevel 1 goto fallo
node -e "const s=require('fs').readFileSync(process.argv[1],'utf8').trim().split(/\r?\n/);console.log('   ' + s[s.length-1])" "%LOG%"

set PASO=Smoke test: arranque real de la app
echo [paso 3] %PASO% ...
call npm run smoke > "%LOG%" 2>&1
if errorlevel 1 goto fallo
echo    OK

set PASO=Interfaz real: iconos, botones y navegacion
echo [paso 4] %PASO% ...
call npm run uicheck > "%LOG%" 2>&1
if errorlevel 1 goto fallo
echo    OK

rem La herramienta de navegador corre codigo DENTRO de la pagina (nombres accesibles,
rem shadow DOM, iframes, clicks sin tapar): solo se puede comprobar contra un navegador
rem real. Si el equipo no tiene Chrome ni Edge, el paso se salta solo y no falla.
set PASO=Navegador real: inventario, clics y dialogos
echo [paso 5] %PASO% ...
call npm run navcheck > "%LOG%" 2>&1
if errorlevel 1 goto fallo
findstr /C:"saltado" "%LOG%" >nul
if not errorlevel 1 (
  echo    saltado ^(sin Chrome ni Edge^)
) else (
  echo    OK
)

echo.
echo [paso 6] Todo en verde. Lanzando SAGITARI...
echo.

:lanzar
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
exit /b 0

rem ---------------------------------------------------------------------------
rem  Salidas: instalacion y errores (cada una dice que paso y ensena lo util)
rem ---------------------------------------------------------------------------
:instalar
echo [..] Primera vez: instalando dependencias con npm install...
call npm install
if errorlevel 1 goto instalar_mal
goto tras_instalar

:sin_node
echo [ERROR] Node.js no esta en el PATH. Instalalo desde https://nodejs.org
pause
exit /b 1

:instalar_mal
echo [ERROR] Fallo npm install. Revisa tu conexion e intentalo de nuevo.
pause
exit /b 1

:sintaxis_mal
echo.
echo [ERROR] Hay errores de sintaxis. No se puede continuar.
pause
exit /b 1

:fallo
echo.
echo [ERROR] Fallo en: %PASO%
echo         SAGITARI no se ha lanzado.
echo.
node -e "const fs=require('fs');const s=fs.readFileSync(process.argv[1],'utf8').split(/\r?\n/);const m=s.filter(l=>/FALLO|ERROR|FAIL|fallaron|rojo|invalid/i.test(l));if(m.length)console.log(m.slice(0,40).join('\n'));console.log('--- ultimas 12 lineas ---');console.log(s.slice(-12).join('\n'))" "%LOG%"
echo ------------------------------------------------
echo Log completo: %LOG%
pause
exit /b 1
