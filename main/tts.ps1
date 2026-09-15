param(
  [string]$Lang = "es-ES",
  [string]$Voice = "",
  [string]$TextFile = "",
  [string]$OutFile = "",
  [int]$Rate = 0,
  [switch]$List
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { Add-Type -AssemblyName System.Runtime.WindowsRuntime } catch {}
function Say([string]$l) { try { [Console]::Out.WriteLine($l); [Console]::Out.Flush() } catch {} }

# Voces de escritorio: las que ve System.Speech. Se usan para listar cuando el almacén
# moderno no da ninguna (o no está), porque si no el usuario vería cero voces aunque
# pudiera hablar perfectamente por SAPI.
function SaySapi {
  Add-Type -AssemblyName System.Speech
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  foreach ($v in $s.GetInstalledVoices()) { Say ("VOICE::" + $v.VoiceInfo.Name + "|" + $v.VoiceInfo.Culture.Name) }
  $s.Dispose()
}

function Await($t, $tipo) {
  $m = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $nt = $m.MakeGenericMethod($tipo).Invoke($null, @($t)); $nt.Wait(-1) | Out-Null; $nt.Result
}

# Las voces modernas (las «móviles», mejores que las de escritorio) solo existen aquí:
# System.Speech no las ve. Por eso la síntesis va por WinRT y SAPI queda de respaldo.
try {
  [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

  $todas = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
  if ($List) {
    # Se cuentan al vuelo y no con $todas.Count: en PowerShell 5.1 esa colección de WinRT
    # no expone Count como número, así que `.Count` devuelve un 1 por voz (medido: con tres
    # voces, «1 1 1») y la comparación con 0 no serviría para decidir el respaldo.
    $vistas = 0
    foreach ($v in $todas) { Say ("VOICE::" + $v.DisplayName + "|" + $v.Language + "|" + $v.Gender); $vistas++ }
    if ($vistas -eq 0) { SaySapi }
    exit 0
  }

  $elegida = $null
  if ($Voice) { foreach ($v in $todas) { if ($v.DisplayName -eq $Voice) { $elegida = $v } } }
  if (-not $elegida) { foreach ($v in $todas) { if ($v.Language -like ($Lang.Split('-')[0] + '*') -and -not $elegida) { $elegida = $v } } }
  if (-not $elegida) { $elegida = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::DefaultVoice }

  $syn = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
  if ($elegida) { $syn.Voice = $elegida }
  $texto = [IO.File]::ReadAllText($TextFile)
  # El tono y la velocidad se piden por SSML: la API moderna no tiene propiedades sueltas.
  $tasa = if ($Rate -ge 0) { "+" + $Rate + "%" } else { $Rate.ToString() + "%" }
  $ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="' + $Lang + '"><prosody rate="' + $tasa + '">' + [System.Security.SecurityElement]::Escape($texto) + '</prosody></speak>'
  $t0 = Get-Date
  $stream = Await ($syn.SynthesizeSsmlToStreamAsync($ssml)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $ms = [int]((Get-Date) - $t0).TotalMilliseconds
  # OJO: en PowerShell 5.1 esto NO existe como método de instancia; hay que llamar a la
  # extensión estática. Comprobado con una sonda en la máquina de desarrollo: con la
  # forma de instancia falla con «no contiene ningún método llamado AsStreamForRead».
  $input = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
  $out = [IO.File]::Create($OutFile)
  $input.CopyTo($out); $out.Close(); $input.Close()
  Say ("VOICEUSED::" + $syn.Voice.DisplayName)
  Say ("OK::" + $OutFile + "|" + $ms)
} catch {
  # Listar también tiene respaldo: si la proyección de WinRT no está (máquinas sin el
  # almacén moderno), este catch es el que atiende el -List, y sin esto la lista salía
  # vacía aunque SAPI pudiera hablar.
  if ($List) { SaySapi; exit 0 }
  # Respaldo: System.Speech (voces de escritorio). Peor voz, pero nunca deja al usuario mudo.
  try {
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    if ($Voice) { try { $s.SelectVoice($Voice) } catch {} }
    $s.Rate = [math]::Max(-10, [math]::Min(10, [int]($Rate / 10)))
    $t0 = Get-Date
    $s.SetOutputToWaveFile($OutFile)
    $s.Speak([IO.File]::ReadAllText($TextFile))
    # El nombre se lee ANTES de Dispose(): después el sintetizador ya no tiene voz que
    # dar y la línea salía vacía («VOICEUSED::»), con el motor diciendo que no sabía qué
    # voz usó. Medido con una sonda que fuerza este carril.
    $usada = 'sistema'
    try { $usada = $s.Voice.Name } catch {}
    $s.Dispose()
    Say ("VOICEUSED::" + $usada)
    Say ("OK::" + $OutFile + "|" + [int]((Get-Date) - $t0).TotalMilliseconds)
  } catch {
    Say ("ERROR::" + $_.Exception.Message)
    exit 1
  }
}
