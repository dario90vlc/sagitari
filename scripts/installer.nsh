; scripts/installer.nsh — lo incluye electron-builder (nsis.include).
;
; Sustituye la comprobación de «app en marcha» de serie. La de electron-builder busca
; procesos cuyo ejecutable EMPIECE por la ruta del directorio de instalación
; (Get-CimInstance + StartsWith), y en cuanto esa ruta llega vacía o corta cualquier
; proceso de la máquina encaja: el instalador anuncia «No se puede cerrar SAGITARI» y se
; queda en un bucle de Reintentar sin que haya nada abierto ni instalado.
;
; Aquí se mira el NOMBRE EXACTO del ejecutable, que es lo único que de verdad impide
; reemplazar ficheros en uso.
!macro customCheckAppRunning
  nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH | "$SYSDIR\findstr.exe" /I /C:"${APP_EXECUTABLE_FILENAME}"`
  Pop $R0
  ${if} $R0 == 0
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK sagiStopApp
    Quit
    sagiStopApp:
    nsExec::Exec `"$SYSDIR\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}" /F /T`
    Pop $R0
    Sleep 500
  ${endif}
!macroend
