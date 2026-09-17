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
    # Las NATURALES primero: son las voces modernas de Windows 11 (DisplayName con
    # «Natural», muchísimo mejor calidad que las de escritorio) y el desplegable de
    # Ajustes pinta la lista EN ESTE ORDEN, así que el usuario las encuentra arriba
    # sin bucear. El tercer campo ya no es el género (nadie lo usaba): es la marca
    # «natural», que el renderer muestra junto al nombre.
    # Se cuentan al vuelo y no con $todas.Count: en PowerShell 5.1 esa colección de WinRT
    # no expone Count como número, así que `.Count` devuelve un 1 por voz (medido: con tres
    # voces, «1 1 1») y la comparación con 0 no serviría para decidir el respaldo.
    $voces = @()
    foreach ($v in $todas) {
      $voces += [pscustomobject]@{ Nombre = [string]$v.DisplayName; Idioma = [string]$v.Language; Natural = ([string]$v.DisplayName -match 'Natural') }
    }
    foreach ($v in ($voces | Sort-Object -Property @{ Expression = { -not $_.Natural } }, Nombre)) {
      Say ("VOICE::" + $v.Nombre + "|" + $v.Idioma + "|" + $(if ($v.Natural) { 'natural' } else { '' }))
    }
    if ($voces.Count -eq 0) { SaySapi }
    exit 0
  }

  # ---- selección de voz ----
  # La voz EXPLÍCITA del usuario manda. Sin ella, la regla es: primero el idioma EXACTO
  # pedido y, dentro de cada grupo, una voz NATURAL («Natural» en el DisplayName: las
  # modernas de Windows 11, que suenan a persona) antes que una de escritorio (Helena y
  # compañía, robóticas). Antes se cogía la PRIMERA del idioma y esa solía ser la de
  # escritorio: es exactamente la «voz de mala calidad» que oía el usuario sin haber
  # tocado ningún ajuste.
  $elegida = $null
  if ($Voice) { foreach ($v in $todas) { if ($v.DisplayName -eq $Voice) { $elegida = $v } } }
  if (-not $elegida) {
    $exactas = @($todas | Where-Object { $_.Language -eq $Lang })
    $delIdioma = @($todas | Where-Object { $_.Language -like ($Lang.Split('-')[0] + '*') })
    $grupo = $exactas
    if ($grupo.Count -eq 0) { $grupo = $delIdioma }
    if ($grupo.Count -gt 0) {
      $naturales = @($grupo | Where-Object { [string]$_.DisplayName -match 'Natural' })
      if ($naturales.Count -gt 0) { $elegida = $naturales[0] } else { $elegida = $grupo[0] }
    }
  }
  if (-not $elegida) {
    $naturales = @($todas | Where-Object { [string]$_.DisplayName -match 'Natural' })
    if ($naturales.Count -gt 0) { $elegida = $naturales[0] }
  }
  if (-not $elegida) { $elegida = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::DefaultVoice }

  $syn = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
  if ($elegida) { $syn.Voice = $elegida }
  $texto = [IO.File]::ReadAllText($TextFile)

  # OJO: las voces NATURALES (OneCore y las del almacén) rechazan el SSML con un error
  # genérico — es el motivo por el que la síntesis caía al respaldo SAPI y el usuario
  # oía una voz robótica teniendo instaladas las buenas. Por eso tono y velocidad van por
  # las PROPIEDADES del sintetizador (aceptadas por todas las voces) y el texto viaja
  # PLANO. Con SSML no se puede avisar que algo se pierde: el rate ya no depende de que
  # la voz acepte un dialecto XML.
  # SpeakingRate es un MULTIPLICADOR con default 1.0 (rango 0.5–6.0, medido: 0.2 sonaba
  # 5 veces más lento), no un incremento porcentual: el rate de la app (+40..−40) se
  # traduce a 0.6–1.4, que está dentro del rango válido.
  $tasa = 1.0 + ([double]$Rate / 100.0)
  $tasa = [math]::Max(0.5, [math]::Min(6.0, $tasa))
  try { $syn.Options.SpeakingRate = $tasa } catch {}
  # El pitch relativo va de −1.0 a 1.0 con default 0.0: el rate de la app da un ajuste
  # fino (±0.2), no un cambio de voz.
  try { $syn.Options.Pitch = [math]::Max(-1.0, [math]::Min(1.0, [double]$Rate / 200.0)) } catch {}
  # De fábrica WinRT añade ~750 ms de silencio tras CADA frase y CADA signo de
  # puntuación: entre frases troceadas sonaba a voz dormida. El mínimo deja la
  # conversación ágil; cada opción en su try por si esta versión no la expone.
  try { $syn.Options.AppendedSilence = [Windows.Media.SpeechSynthesis.SpeechAppendedSilence]::Min } catch {}
  try { $syn.Options.PunctuationSilence = [Windows.Media.SpeechSynthesis.SpeechPunctuationSilence]::Min } catch {}

  $t0 = Get-Date
  # Las voces naturales rinden mejor a 24 kHz que en el 16 kHz de fábrica. En su propio
  # try: si esta versión no expone la opción, ponerla no puede tumbar el motor moderno.
  $fmtAlta = $false
  try { $syn.Options.AudioFormat = [Windows.Media.SpeechSynthesis.SpeechAudioFormat]::Khz24BitMono; $fmtAlta = $true } catch {}
  try {
    # Texto PLANO a propósito: ver la nota de arriba (las naturales rechazan el SSML).
    $stream = Await ($syn.SynthesizeTextToStreamAsync($texto)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  } catch {
    # No todas las voces aceptan el formato pedido: si se pidió uno alto y la síntesis
    # falló, se REINTENTA con el de fábrica antes de tirar el motor moderno entero
    # (caer a SAPI por un formato sería cambiar una voz buena por una robótica).
    if (-not $fmtAlta) { throw }
    try { $syn.Options.AudioFormat = [Windows.Media.SpeechSynthesis.SpeechAudioFormat]::Khz16BitMono } catch {}
    $stream = Await ($syn.SynthesizeTextToStreamAsync($texto)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  }
  $ms = [int]((Get-Date) - $t0).TotalMilliseconds
  # OJO: en PowerShell 5.1 esto NO existe como método de instancia; hay que llamar a la
  # extensión estática. Comprobado con una sonda en la máquina de desarrollo: con la
  # forma de instancia falla con «no contiene ningún método llamado AsStreamForRead».
  $input = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
  $out = [IO.File]::Create($OutFile)
  $input.CopyTo($out); $out.Close(); $input.Close()
  # La voz REAL usada va con su marca «natural»: el renderer no tiene que adivinar si lo
  # que va a sonar es una voz buena o el respaldo robótico (VOICEOK y no VOICEUSED, que
  # sigue aceptándose por compatibilidad con corridas viejas).
  $usada = 'sistema'
  $marca = ''
  try { $usada = $syn.Voice.DisplayName } catch {}
  if ($usada -match 'Natural') { $marca = 'natural' }
  Say ("VOICEOK::" + $usada + "|" + $marca)
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
