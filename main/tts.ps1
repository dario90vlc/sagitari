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
    foreach ($v in $todas) { Say ("VOICE::" + $v.DisplayName + "|" + $v.Language + "|" + $v.Gender) }
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
  # Respaldo: System.Speech (voces de escritorio). Peor voz, pero nunca deja al usuario mudo.
  try {
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    if ($Voice) { try { $s.SelectVoice($Voice) } catch {} }
    $s.Rate = [math]::Max(-10, [math]::Min(10, [int]($Rate / 10)))
    $t0 = Get-Date
    $s.SetOutputToWaveFile($OutFile)
    $s.Speak([IO.File]::ReadAllText($TextFile))
    $s.Dispose()
    Say ("VOICEUSED::" + $(try { $s.Voice.Name } catch { 'sistema' }))
    Say ("OK::" + $OutFile + "|" + [int]((Get-Date) - $t0).TotalMilliseconds)
  } catch {
    Say ("ERROR::" + $_.Exception.Message)
    exit 1
  }
}
