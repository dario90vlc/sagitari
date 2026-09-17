# Qué puede oír esta máquina, con qué motores y por dónde.
#
# NO abre el micrófono: solo pregunta qué hay instalado y cuál es el dispositivo de entrada
# predeterminado. Es la pregunta que decide por qué el dictado «no reconoce bien»: si el
# idioma que pide la app (Ajustes > Voz) no está instalado, voice.ps1 cae al del sistema SIN
# decirlo, y dictar español contra un reconocedor inglés se ve exactamente como «no me
# reconoce la voz». Y si el micrófono predeterminado es un dispositivo virtual (NVIDIA
# Broadcast y compañía), el reconocedor oye silencio o una voz procesada.
#
# Para medir la voz de verdad (y ver qué motor arranca) hace falta la sonda que sí escucha:
#   node scripts/voz-sonda.js 30

$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { Add-Type -AssemblyName System.Runtime.WindowsRuntime } catch {}

function Head([string]$t) { Write-Host ""; Write-Host $t }
function Nota([string]$t) { Write-Host ("  " + $t) }
# El mensaje de una excepción de .NET trae la traza entera: aquí solo interesa la primera
# línea, que es la que dice qué ha pasado.
function Corto($e) { return (($e.Exception.Message) -split "`n")[0] }

$idiomas = @('es-ES', 'es-MX', 'es-AR', 'es-US', 'en-US')

Head "== Motor moderno (WinRT, el que reconoce de verdad) =="
$winrt = $false
try {
  [Windows.Media.SpeechRecognition.SpeechRecognizer, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
  $winrt = $true
} catch {
  Nota ("este Windows no expone el motor moderno: " + (Corto $_))
}
if ($winrt) {
  foreach ($idioma in $idiomas) {
    try {
      $lang = New-Object Windows.Globalization.Language($idioma)
      $rec = New-Object Windows.Media.SpeechRecognition.SpeechRecognizer($lang)
      Nota ($idioma.PadRight(6) + " disponible  =>  reconoceria en " + $rec.CurrentLanguage.LanguageTag)
    } catch {
      Nota ($idioma.PadRight(6) + " NO INSTALADO  (" + (Corto $_) + ")")
    }
  }
  # El del sistema es al que cae voice.ps1 cuando el idioma pedido no está.
  try {
    $sys = New-Object Windows.Media.SpeechRecognition.SpeechRecognizer
    Nota ("sistema => " + $sys.CurrentLanguage.LanguageTag + " (la app cae aquí si el idioma pedido no está)")
  } catch {
    Nota ("sistema: NO se pudo construir (" + (Corto $_) + ")")
    Nota "  Un fallo aquí suele ser la política de voz en línea (ms-settings:privacy-speech)."
  }
}

Head "== Tiempos de silencio del motor moderno =="
# El motor decide dónde acaba una frase por el silencio. Si el «ambiguo» no se puede fijar,
# una duda natural a mitad de frase («abre… el navegador») corta la petición en dos.
try {
  $t = (New-Object Windows.Media.SpeechRecognition.SpeechRecognizer).Timeouts
  foreach ($p in @('BabbleTimeout', 'EndSilenceTimeout', 'EndSilenceTimeoutAmbiguous', 'InitialSilenceTimeout')) {
    $m = $t | Get-Member -Name $p
    if ($m) { Nota ($p.PadRight(28) + " " + $t.$p) } else { Nota ($p.PadRight(28) + " NO EXISTE en esta versión de Windows") }
  }
} catch { Nota ("no se pudo consultar: " + (Corto $_)) }

Head "== Motor clásico (SAPI, el que oye peor) =="
try {
  Add-Type -AssemblyName System.Speech
  $todas = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
  if (-not $todas) { Nota "(ninguno instalado)" }
  foreach ($r in $todas) { Nota ($r.Culture.Name + "  " + $r.Description) }
} catch { Nota ("no se pudo consultar: " + (Corto $_)) }

Head "== Voces de lectura (TTS) =="
try {
  [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime] | Out-Null
  $n = 0
  foreach ($v in [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices) { Nota ($v.Language + "  " + $v.DisplayName + "  (" + $v.Gender + ")"); $n++ }
  if ($n -eq 0) { Nota "(ninguna voz moderna instalada: la lectura irá por la voz de escritorio)" }
} catch { Nota ("no se pudo consultar: " + (Corto $_)) }

Head "== Micrófonos que ve Windows =="
try {
  Get-CimInstance Win32_SoundDevice | ForEach-Object { Nota ($_.Name + "  [" + $_.Status + "]") }
} catch { Nota "no se pudo consultar" }

Head "== Micrófono predeterminado (el que escucha la app) =="
# Enumerar el hardware no basta: en un equipo con NVIDIA Broadcast instalado, el micrófono
# «predeterminado» puede ser su dispositivo VIRTUAL. Si su fuente no está bien puesta, el
# reconocedor oye silencio, y eso se ve como «no me reconoce».
# El identificador trae el GUID del extremo: `...\{0.0.1.00000000}.{GUID}#{GUID de interfaz}`.
# Con el del medio se pregunta a Windows por el nombre amable del dispositivo.
function NombreDe([string]$id) {
  $m = [regex]::Match($id, '\.\{([0-9a-fA-F\-]{36})\}')
  if ($m.Success) {
    $g = $m.Groups[1].Value
    try {
      $d = Get-PnpDevice -Class AudioEndpoint | Where-Object { $_.InstanceId -like ('*' + $g + '*') } | Select-Object -First 1
      if ($d -and $d.FriendlyName) { return [string]$d.FriendlyName }
    } catch { }
  }
  return ('(sin nombre) ' + $id)
}
try {
  [Windows.Media.Devices.MediaDevice, Windows.Media.Devices, ContentType = WindowsRuntime] | Out-Null
  foreach ($rol in @('Communications', 'Default', 'Console')) {
    try {
      $id = [Windows.Media.Devices.MediaDevice]::GetDefaultAudioCaptureId([Windows.Media.Devices.AudioDeviceRole]::$rol)
      Nota ($rol.PadRight(15) + ' -> ' + (NombreDe $id))
    } catch { Nota ($rol.PadRight(15) + ' -> no se pudo consultar') }
  }
} catch { Nota 'este Windows no expone Windows.Media.Devices' }
