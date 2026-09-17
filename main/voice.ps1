param(
  [string]$Lang = "es-ES",
  # La app ya NO manda -NoWinrt: intenta siempre el motor moderno (WinRT), que es el que
  # reconoce de verdad, y esta bandera sirve solo para forzar el clásico a mano en pruebas.
  [switch]$NoWinrt
)

$ErrorActionPreference = "Stop"
# Node decodes stdout as UTF-8: force UTF-8 so accents survive the pipe.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
# Y la ENTRADA también: si el proceso padre manda el idioma por la tubería con acentos
# u otra codificación, PowerShell la recorre con la página de código del sistema (en un
# Windows español, CP-1252/850) y la corrompe en silencio. Sin esta línea, un `es-ES`
# bienintencionado podía llegar convertido en basura — y un idioma corrupto no encuentra
# NINGÚN reconocedor: el motor moderno compila un reconocedor vacío (sordo de fábrica)
# y el clásico agarra el primero instalado, que puede estar en otro idioma.
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}
# WinRT projection helpers (AsTask) live in this assembly
try { Add-Type -AssemblyName System.Runtime.WindowsRuntime } catch {}

function Say([string]$line) {
  try { [Console]::Out.WriteLine($line); [Console]::Out.Flush() } catch {}
}

# NORMALIZACIÓN DEL IDIOMA. $Lang llega por la línea de comandos, por tubería o por
# teclado: PowerShell (y el propio Terminal) meten comillas tipográficas, espacios no
# separables o guiones distintos del ASCII. Un `es–ES` con guion tipográfico NO encuentra
# reconocedor: el motor moderno compila un reconocedor sin idioma (sordo de fábrica) y el
# clásico agarra el primero instalado, aunque esté en otro idioma. Se limpia a la forma
# `xx-XX` ANTES de usarlo para nada.
$Lang = ($Lang -replace '[^a-zA-Z\-]', '') -replace '-{2,}', '-'
if ($Lang -notmatch '^[a-zA-Z]{2,3}-[a-zA-Z]{2,3}$' -and $Lang -notmatch '^[a-zA-Z]{2,3}$') { $Lang = 'es-ES' }

# Prefijo del idioma pedido («es» de «es-ES»), calculado UNA vez y como cadena.
# Hace falta porque más abajo `$langObj` convive con el parámetro `$Lang` (PowerShell no
# distingue mayúsculas) y cualquier $lang. algo escrito después de esa línea compara contra
# un objeto de idioma, no contra «es»: así el filtro del motor clásico no encontraba el
# reconocedor pedido —se quedaba con el primero instalado, que puede estar en INGLÉS— y el
# aviso de idioma saltaba siempre con un texto sin sentido.
$prefijo = ($Lang -split '-')[0].ToLower()

# Aseguramiento preventivo de privacidad de reconocimiento de voz en línea para WinRT:
# En Windows 10/11, WinRT SpeechRecognizer requiere HasAccepted=1 en OnlineSpeechPrivacy.
# Si la clave no está presente, RecognizeAsync falla con HRESULT 0x80045509.
# Activarlo aquí evita caídas involuntarias al motor clásico.
try {
  $regPath = 'HKCU:\Software\Microsoft\Speech_OneCore\Settings\OnlineSpeechPrivacy'
  if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
  Set-ItemProperty -Path $regPath -Name 'HasAccepted' -Value 1 -Type DWord -Force -ErrorAction SilentlyContinue
} catch {}

# Por donde escucha de verdad. Este motor NO puede elegir microfono: oye SIEMPRE el
# predeterminado de Windows. Con un micro de webcam al otro lado de la mesa —o un
# dispositivo virtual como NVIDIA Broadcast— el reconocimiento se cae aunque la app
# parezca oirte (el orbe late porque el micro capta algo), y el arreglo esta fuera de la
# app. Decirlo al arrancar es la pista mas util que puede dar, y por eso se dice siempre.
function AvisoMicrofono() {
  try {
    [Windows.Media.Devices.MediaDevice, Windows.Media.Devices, ContentType = WindowsRuntime] | Out-Null
    $id = [Windows.Media.Devices.MediaDevice]::GetDefaultAudioCaptureId([Windows.Media.Devices.AudioDeviceRole]::Communications)
    $m = [regex]::Match($id, '\.\{([0-9a-fA-F\-]{36})\}')
    if (-not $m.Success) { return }
    $d = Get-PnpDevice -Class AudioEndpoint | Where-Object { $_.InstanceId -like ('*' + $m.Groups[1].Value + '*') } | Select-Object -First 1
    if ($d -and $d.FriendlyName) {
      Say ("HINT::Escuchando por el microfono predeterminado: " + [string]$d.FriendlyName + ". El dictado usa siempre el predeterminado de Windows: si no es el que usas para hablar, cambialo en ms-settings:sound.")
    }
  } catch { }
}

AvisoMicrofono

# ---------- Engine 1: WinRT (Windows.Media.SpeechRecognition) ----------
# Modern Windows engine (the one behind Windows dictation): far better free-dictation
# accuracy than SAPI 8.0. Windows PowerShell 5.1 cannot subscribe to WinRT events,
# so instead of the continuous session we loop single-shot RecognizeAsync():
# each call captures one utterance and completes after a natural pause (1.2s).
function Await($WinRtTask, $ResultType) {
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

# Igual que Await, pero con TOPE: en algunas máquinas el reconocedor, tras capturar
# audio que no logra reconocer, deja la SIGUIENTE RecognizeAsync congelada para siempre
# (sin error, sin resultado). Un intento sano acaba en menos de ~5 s (silencio inicial
# 2,5 s + pausa final 0,5 s + habla): cualquier intento que supere el tope es un motor
# congelado y no puede esperar eternamente. Devuelve $null si el tope se agotó.
function AwaitConTope($WinRtTask, $ResultType, [int]$Ms) {
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  if (-not $netTask.Wait($Ms)) { return $null }
  $netTask.Result
}

try {
  # -NoWinrt: salta el motor WinRT sin intentarlo (el catch de abajo lo trata como
  # «no disponible» y continúa con el clásico).
  if ($NoWinrt) { throw "motor WinRT desactivado con -NoWinrt" }

  [Windows.Media.SpeechRecognition.SpeechRecognizer, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.SpeechRecognition.SpeechRecognitionTopicConstraint, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.SpeechRecognition.SpeechRecognitionCompilationResult, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.SpeechRecognition.SpeechRecognitionResult, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

  $rec = $null
  try {
    # Búsqueda inteligente de idioma: primero exacto, luego por prefijo de idioma (ej: es-MX para es-ES)
    $idiomasCompatibles = @()
    try {
      $idiomasCompatibles = [Windows.Media.SpeechRecognition.SpeechRecognizer]::SupportedTopicLanguages
    } catch {}
    if (-not $idiomasCompatibles -or $idiomasCompatibles.Count -eq 0) {
      try { $idiomasCompatibles = [Windows.Media.SpeechRecognition.SpeechRecognizer]::SupportedGrammarLanguages } catch {}
    }
    $langCandidato = $null
    if ($idiomasCompatibles) {
      $langCandidato = $idiomasCompatibles | Where-Object { $_.LanguageTag.ToLower() -eq $Lang.ToLower() } | Select-Object -First 1
      if (-not $langCandidato) {
        $langCandidato = $idiomasCompatibles | Where-Object { $_.LanguageTag.ToLower().StartsWith($prefijo) } | Select-Object -First 1
      }
    }
    if ($langCandidato) {
      $rec = New-Object Windows.Media.SpeechRecognition.SpeechRecognizer($langCandidato)
    } else {
      $langObj = New-Object Windows.Globalization.Language($Lang)
      $rec = New-Object Windows.Media.SpeechRecognition.SpeechRecognizer($langObj)
    }
  } catch {
    # requested language not installed -> use the system speech language
    $rec = New-Object Windows.Media.SpeechRecognition.SpeechRecognizer
  }

  # Ajuste equilibrado de pausas de silencio:
  # EndSilenceTimeout a 1.0s permite respuesta natural y ágil sin cortar frases.
  $rec.Timeouts.BabbleTimeout = [TimeSpan]::FromSeconds(0)
  $rec.Timeouts.EndSilenceTimeout = [TimeSpan]::FromSeconds(1.0)
  # Silencio inicial CORTO a propósito (12 s): un resultado vacío por silencio devuelve el
  # control y el bucle sigue vivo y reactivo. Con el valor largo de antes (5 min), un motor
  # que no recibe nada del dispositivo se quedaba CONGELADO minutos dentro de una sola
  # llamada RecognizeAsync: sin aviso, sin reloj y sin rescate posible.
  try { $rec.Timeouts.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromSeconds(0.9) } catch {}
  # Silencio INICIAL corto (2,5 s): un intento sin nada de audio completa pronto y el
  # bucle sigue vivo. Con el valor por defecto (5 s) cada intento vacío tardaba el doble
  # y el rescate a continuación se demoraba sin motivo.
  try { $rec.Timeouts.InitialSilenceTimeout = [TimeSpan]::FromSeconds(2.5) } catch {}

  # Inyección de SpeechRecognitionTopicConstraint (Dictado libre):
  # En PowerShell 5.1 $rec.Constraints es un System.__ComObject y no expone .Append().
  # A través de la interfaz genérica ICollection<ISpeechRecognitionConstraint> se añade
  # correctamente al vector WinRT, habilitando el dictado libre en lugar de la gramática por defecto.
  try {
    $dictTopic = 0  # SpeechRecognitionTopic::Dictation
    $topic = New-Object Windows.Media.SpeechRecognition.SpeechRecognitionTopicConstraint($dictTopic, 'dictado')
    $iColType = [System.Collections.Generic.ICollection[Windows.Media.SpeechRecognition.ISpeechRecognitionConstraint]]
    $addMethod = $iColType.GetMethod("Add")
    $addMethod.Invoke($rec.Constraints.PSObject.BaseObject, @($topic.PSObject.BaseObject)) | Out-Null
  } catch {
    try { $rec.Constraints.Append($topic) | Out-Null } catch {}
  }
  $compiled = Await ($rec.CompileConstraintsAsync()) ([Windows.Media.SpeechRecognition.SpeechRecognitionCompilationResult])
  if ($compiled.Status -ne [Windows.Media.SpeechRecognition.SpeechRecognitionResultStatus]::Success) {
    throw "no se pudieron compilar las restricciones de dictado"
  }

  Say "MODE::winrt"
  $tagReal = $rec.CurrentLanguage.LanguageTag
  Say ("READY::" + $tagReal)
  # El motor escucha en SU idioma, y cuando el que pedimos no esta instalado cae al del
  # sistema sin decirlo: dictar espanol contra un reconocedor ingles es justo lo que se ve
  # como «no me reconoce la voz». Se avisa, con el arreglo concreto.
  if (-not $tagReal.ToLower().StartsWith($prefijo)) {
    Say ("HINT::El reconocedor disponible esta en " + $tagReal + ", no en " + $Lang + ": por eso oye mal. Anade el paquete de voz de " + $Lang + " en Configuracion de Windows > Hora e idioma > Idioma y region.")
  }

  # 0x80045509 = speech privacy policy not accepted (online speech recognition off).
  # We detect it and fall back to the classic engine with an actionable message.
  $PRIVACY_HR = '0x80045509'
  $seenErr = @{}
  $consecutiveFails = 0
  $finals = 0
  $avisoAudio = [DateTime]::Now.AddSeconds(30)
  # Vigía de sordera del motor moderno: los intentos VACÍOS no lanzan excepción (el
  # contador de fallos de abajo nunca se entera), así que un dispositivo que no entrega
  # audio dejaba este bucle girando para siempre sin diagnóstico. AudioDuration dice
  # cuánto audio capturó cada intento: >0 = el camino funciona (sólo estás callado);
  # 0 repetido = el motor moderno está SORDO en esta máquina.
  $silencioSeguido = 0
  $audioMs = 0
  :winrtloop while ($true) {
    # El aviso de audio se evalúa en CADA vuelta y no solo en el catch: el silencio del
    # dispositivo NO lanza una excepción, así que un usuario callado nunca pasaba por el
    # camino de fallo y la pista del micrófono no salía nunca. (El RESCATE al clásico lo
    # decide el renderer, que sí mide la voz real del micro — aquí no se puede distinguir
    # «motor sordo» de «usuario callado» sin arriesgar degradar sesiones buenas.)
    if ($finals -eq 0 -and [DateTime]::Now -gt $avisoAudio) {
      Say "HINT::No llega audio para reconocer: revisa el microfono predeterminado en ms-settings:sound (si usas NVIDIA Broadcast o similar, asegurate de que el microfono real sea el predeterminado)."
      $avisoAudio = [DateTime]::Now.AddSeconds(30)
    }
    try {
      $tIntento = Get-Date
      $op = $rec.RecognizeAsync()
      $res = AwaitConTope $op ([Windows.Media.SpeechRecognition.SpeechRecognitionResult]) 12000
      if (-not $res) {
        # Intento CONGELADO (pasó del tope sin completar): es la forma de sordera que
        # ni los vacíos ni los fallos revelan — el motor capturó audio y se quedó
        # bloqueado dentro de su máquina de estados. Aquí no hay nada que recuperar:
        # el clásico toma la sesión (usa otro camino de audio y otra máquina de estados).
        Say "MotorAlterno::el motor moderno se congeló dentro de un intento de reconocimiento (rescate automatico)"
        break :winrtloop
      }
      if ($res -and $res.Text -and $res.Text.Trim()) {
        $consecutiveFails = 0
        $finals++
        $silencioSeguido = 0
        $audioMs = 0
        # La confianza de WinRT es un enumerado (High/Medium/Low/Rejected): se pasa a
        # número para que el proceso principal pueda decidir si avisar al usuario.
        $c = switch ([string]$res.Confidence) { 'High' { 0.9 } 'Medium' { 0.6 } 'Low' { 0.3 } default { 0.1 } }
        Say ("FINAL::" + $res.Text.Trim() + [char]31 + $c)
      } elseif ($finals -eq 0) {
        # Resultado VACÍO antes de la primera frase. Hay DOS formas de sordera y las dos
        # rescatan: (a) cero audio en los intentos — el dispositivo no entrega NADA al
        # camino moderno; (b) audio SÍ llega pero nunca se reconoce nada — resultados
        # vacíos con AudioDuration > 0: el motor recibe la voz y no la entiende. Un
        # usuario simplemente callado no acumula audio ni produce reconocimientos, así
        # que ni (a) ni (b) le tocan: el moderno sigue de guardia sin degradarse.
        try { $audioMs += [int]$res.AudioDuration.TotalMilliseconds } catch {}
        $silencioSeguido++
        if ($silencioSeguido -ge 6 -or $audioMs -ge 6000) {
          Say "MotorAlterno::el motor moderno no consigue reconocer nada en este dispositivo (rescate automatico)"
          break :winrtloop
        }
      }
    } catch {
      # Cuanto ha tardado el intento. Es el unico dato que distingue un fallo del
      # dispositivo de un simple silencio, y hace falta para no tirar el motor bueno.
      $espera = ((Get-Date) - $tIntento).TotalMilliseconds
      $hr = ('0x{0:X8}' -f ($_.Exception.HResult -band 0xFFFFFFFF))
      $agg = $_.Exception.InnerException
      if ($agg) { $hr = ('0x{0:X8}' -f ($agg.HResult -band 0xFFFFFFFF)) }
      if ($hr -eq $PRIVACY_HR) {
        Say "ERROR::Para el dictado de alta calidad, activa 'Reconocimiento de voz en linea' en Configuracion de Windows > Privacidad y seguridad > Voz (ms-settings:privacy-speech). Uso el motor clasico mientras tanto."
        break :winrtloop
      }
      # Una espera LARGA significa que el microfono SI esta dando audio: el motor se quedo
      # escuchando y se rindio por silencio. Eso no es un fallo del dispositivo y no puede
      # contar para dejar de intentarlo. Antes contaba, asi que una racha de silencios
      # -quedarse callado unos segundos mientras se piensa la frase- tiraba el motor
      # moderno y el resto de la sesion seguia con el clasico, que oye mucho peor: el
      # usuario veia «no me reconoce» justo despues de una pausa. Un fallo instantaneo, en
      # cambio, si es del dispositivo y si cuenta.
      if ($espera -lt 1500) { $consecutiveFails++ } else { $consecutiveFails = 0 }
      if ($consecutiveFails -ge 20) {
        Say "ERROR::No consigo oir nada del microfono (revisa el dispositivo de entrada predeterminado en ms-settings:sound). Sigo con el motor clasico, que oye peor."
        break :winrtloop
      }
      if (-not $seenErr[$hr]) {
        $seenErr[$hr] = $true
        $msg = if ($agg) { $agg.Message } else { $_.Exception.Message }
        Say ("NOTE::HR=" + $hr + " " + $msg.Split("`
")[0])
      }
      # Watchdog del micro, el mismo del motor clasico: media hora no, 30 s sin una sola
      # frase suele ser el dispositivo equivocado o silenciado.
      if ($finals -eq 0 -and [DateTime]::Now -gt $avisoAudio) {
        Say "HINT::No llega audio para reconocer: revisa el microfono predeterminado en ms-settings:sound (si usas NVIDIA Broadcast o similar, asegurate de que el microfono real sea el predeterminado)."
        $avisoAudio = [DateTime]::Now.AddSeconds(30)
      }
      Start-Sleep -Milliseconds 600
    }
  }
} catch {
  if (-not $NoWinrt) {
    Say ("NOTE::WinRT no disponible (" + ($_.Exception.Message.Split("`
")[0]) + "), usando motor clasico")
  }
} finally {
  # Al salir del bloque —por caída al clásico o por error— el reconocedor moderno
  # SUELTA el micrófono. Sin esto, el clásico abría el dispositivo con el moderno
  # todavía agarrado a él: dos motores capturando a la vez es la receta para que el
  # segundo reciba audio vacío (otro «oye pero no reconoce nada»).
  if ($rec) { try { $rec.Dispose() } catch {} }
}

# ---------- Engine 2: System.Speech fallback (SAPI) ----------
try {
  Add-Type -AssemblyName System.Speech

  $rid = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
    Where-Object { $_.Culture.Name.ToLower().StartsWith($prefijo) } | Select-Object -First 1
  if (-not $rid) {
    $rid = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Select-Object -First 1
  }
  if (-not $rid) {
    Say "ERROR::No hay reconocedores de voz instalados (agrega el paquete de idioma en Configuracion de Windows)."
    exit 1
  }

  $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine($rid)
  Say ("NOTE::Motor clasico en marcha (reconocedor: " + $rid.Culture.Name + ").")
  $rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $rec.SetInputToDefaultAudioDevice()
  # tuned for dictation: don't clip sentence starts, tolerate natural pauses. Mismos
  # tiempos que el motor moderno: el corte por silencio no puede depender de cual toque.
  $rec.BabbleTimeout = [TimeSpan]::FromSeconds(0)
  $rec.EndSilenceTimeout = [TimeSpan]::FromSeconds(1.6)
  $rec.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromSeconds(1.2)

  $global:VoiceEvents = 0
  Register-ObjectEvent -InputObject $rec -EventName SpeechHypothesized -Action {
    try { $global:VoiceEvents++; Say ("PART::" + $EventArgs.Result.Text) } catch {}
  } | Out-Null
  Register-ObjectEvent -InputObject $rec -EventName SpeechRecognized -Action {
    try {
      $global:VoiceEvents++
      $c = [math]::Round([double]$EventArgs.Result.Confidence, 3)
      Say ("FINAL::" + $EventArgs.Result.Text + [char]31 + $c)
    } catch {}
  } | Out-Null

  $rec.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
  Say "MODE::sapi"
  Say ("READY::" + $rid.Culture.Name)
  # Un CLASSICO oye peor que el moderno cuando el moderno funciona: en una máquina donde
  # SÓLO pasa esto (o donde el usuario lo pidió en Ajustes), decir CÓMO volver al moderno
  # cuando cambie de micro o se arregle el sistema es lo que evita quedarse para siempre
  # con la peor oreja. Una sola vez por sesión.
  Say "HINT::Estas usando el motor clasico, que entiende peor el habla libre. Si notas poco preciso, apaga 'Motor de escucha clasico' en SAGITARI > Ajustes para volver al moderno."
  # El reconocedor clasico tambien puede estar en otro idioma: cuando el paquete que
  # pedimos no esta, arriba se acaba cogiendo el primero que haya instalado.
  if (-not $rid.Culture.Name.ToLower().StartsWith($prefijo)) {
    Say ("HINT::El reconocedor clasico esta en " + $rid.Culture.Name + ", no en " + $Lang + ": por eso oye mal. Anade el paquete de voz de " + $Lang + " en Configuracion de Windows > Hora e idioma > Idioma y region.")
  }

  # Fin de la entrada estándar + ÓRDENES del proceso principal: si la app se cierra de
  # golpe, su tubería se cierra con ella y este bucle no puede quedarse girando para
  # siempre con el micrófono abierto. Y por la MISMA tubería puede llegar una orden de
  # cambio (MotorAlterno::): la escribió el proceso principal cuando el MOTOR MODERNO se
  # declaró sordo en esta máquina — el clásico toma la sesión. La lectura va en un hilo
  # aparte porque las lecturas asíncronas de .NET sobre la entrada estándar devuelven fin
  # de flujo antes de tiempo.
  $stdinWatch = $false
  try {
    Add-Type -Namespace Sagitari -Name StdinWatch -MemberDefinition @'
public static volatile bool Eof;
public static volatile bool Clasico;
public static void Start()
{
    var t = new System.Threading.Thread(() => {
        try
        {
            var input = System.Console.OpenStandardInput();
            var buf = new byte[512];
            var n = input.Read(buf, 0, buf.Length);
            while (n > 0)
            {
                var line = System.Text.Encoding.UTF8.GetString(buf, 0, n);
                if (line.Contains("MotorAlterno")) { Clasico = true; }
                n = input.Read(buf, 0, buf.Length);
            }
        }
        catch { }
        Eof = true;
    });
    t.IsBackground = true;
    t.Start();
}
'@
    [Sagitari.StdinWatch]::Start()
    $stdinWatch = $true
  } catch { }

  # mic guard: 30s without ANY engine event usually means the default capture
  # device is muted, dead, or the wrong one (e.g. a webcam mic across the room)
  $start = [DateTime]::Now
  while ($true) {
    Start-Sleep -Milliseconds 500
    if ($stdinWatch -and [Sagitari.StdinWatch]::Eof) { break }
    # Orden de cambio recibida: sale limpio. El proceso principal reorganiza la escucha
    # (en la práctica ya está en clásico: este break sólo cierra un proceso duplicado).
    if ($stdinWatch -and [Sagitari.StdinWatch]::Clasico) { break }
    if ($global:VoiceEvents -eq 0 -and ([DateTime]::Now - $start).TotalSeconds -gt 30) {
      Say "HINT::No llega audio: revisa el microfono predeterminado en ms-settings:sound (si usas NVIDIA Broadcast o similar, asegurate de que el microfono real sea el predeterminado)."
      $start = [DateTime]::Now
    }
  }
} catch {
  Say ("ERROR::" + $_.Exception.Message)
  exit 1
}
