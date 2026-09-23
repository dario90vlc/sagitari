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
rem --publish never: igual que en el workflow. Sin esto, si el entorno parece CI
rem (variable CI en el entorno), electron-builder intenta publicar al final y
rem muere por GH_TOKEN DESPUES de construir, y el exit1 confunde.
call npm run dist -- --publish never
if errorlevel 1 (
    echo.
    echo [ERROR] Fallo la compilacion con electron-builder.
    pause
    exit /b 1
)

echo [3/3] Comprobando artefactos generados...
if exist "dist\SAGITARI-Setup-*.exe" echo    OK: instalador generado en dist\
if exist "dist\SAGITARI-Portable-*.exe" echo    OK: portable generado en dist\
if not exist "dist\SAGITARI-Setup-*.exe" goto artefactos_mal
if not exist "dist\SAGITARI-Portable-*.exe" goto artefactos_mal

rem latest.yml: el mismo paso que el workflow. electron-builder solo firma el
rem Setup; sin completar el yml el portable queda SIN firma publicada y el
rem updater de la app lo descarta al intentar actualizarse.
call node scripts\latest-yml.js dist
if errorlevel 1 goto artefactos_mal
call node scripts\latest-yml.js dist --check
if errorlevel 1 goto artefactos_mal
echo    OK: latest.yml con la firma de todos los binarios

echo.
echo Compilacion terminada. Los ejecutables estan en la carpeta dist\
echo.
pause
exit /b 0

:artefactos_mal
echo     [ERROR] Falta un artefacto esperado en dist\ (Setup o Portable).
pause
exit /b 1
