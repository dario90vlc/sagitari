@echo off
setlocal
title SAGITARI - compilar
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js no esta en el PATH.
    pause
    exit /b 1
)

rem La version se lee de package.json: el banner no puede mentir.
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set VERSION=%%v

echo.
echo ==================================================
echo   SAGITARI v%VERSION%  -  COMPILACION (opcional)
echo ==================================================
echo.

echo [1/3] Sintaxis + tests...
set SYNTAX_OK=1
for %%f in (main\*.js agent\*.js renderer\*.js test\*.js scripts\*.js) do (
    node --check "%%f" >nul 2>nul
    if errorlevel 1 (
        echo    [ERROR] Sintaxis invalida: %%f
        set SYNTAX_OK=0
    )
)
if "%SYNTAX_OK%"=="0" (
    echo [ERROR] Corrige los errores antes de compilar. Usa probar.bat para depurar.
    pause
    exit /b 1
)
call npm test
if errorlevel 1 (
    echo [ERROR] Tests en rojo. No se compila.
    pause
    exit /b 1
)

echo [2/3] Generando instalador NSIS + portable en dist\...
call npm run dist
if errorlevel 1 (
    echo.
    echo [ERROR] Fallo la compilacion con electron-builder.
    pause
    exit /b 1
)

echo [3/3] Comprobando artefactos generados...
if exist "dist\SAGITARI-Setup-*.exe" echo    OK: instalador generado en dist\
if exist "dist\SAGITARI-Portable-*.exe" echo    OK: portable generado en dist\
if not exist "dist\SAGITARI-Setup-*.exe" (
    echo    [ERROR] No se encontro el instalador esperado en dist\
    pause
    exit /b 1
)

echo.
echo Compilacion terminada. Los ejecutables estan en la carpeta dist\
echo.
pause
