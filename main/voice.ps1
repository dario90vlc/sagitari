param(
  [string]$Lang = "es-ES",
  # El proceso principal arranca el dictado con -NoWinrt: así se salta el motor
  # WinRT (depende de la política de voz en línea y en muchas máquinas falla) y
  # se va directo al motor clásico.
  [switch]$NoWinrt
)

$ErrorActionPreference = "Stop"
# Node decodes stdout as UTF-8: force UTF-8 so accents survive the pipe.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
# WinRT projection helpers (AsTask) live in this assembly
try { Add-Type -AssemblyName System.Runtime.WindowsRuntime } catch {}

function Say([string]$line) {
  try { [Console]::Out.WriteLine($line); [Console]::Out.Flush() } catch {}
}

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
    $lang = New-Object Windows.Globalization.Language($Lang)
    $rec = New-Object Windows.Media.SpeechRecognition.SpeechRecognizer($lang)
  } catch {
    # requested language not installed -> use the system speech language
    $rec = New-Object Windows.Media.SpeechRecognition.SpeechRecognizer
  }

  # never cut the beginning of a phrase; end it only after a real pause
  $rec.Timeouts.BabbleTimeout = [TimeSpan]::FromSeconds(0)
  $rec.Timeouts.EndSilenceTimeout = [TimeSpan]::FromSeconds(1.2)

  # dictation topic constraint = free-form speech. PS 5.1 often can't append into the
  # WinRT IVector (__ComObject) -> if it fails we continue with the default grammar,
  # which RecognizeAsync() treats as dictation anyway.
  try {
    $dictTopic = 0  # SpeechRecognitionTopic::Dictation
    $topic = New-Object Windows.Media.SpeechRecognition.SpeechRecognitionTopicConstraint($dictTopic, 'dictado')
    $rec.Constraints.Append($topic) | Out-Null
  } catch { }
  $compiled = Await ($rec.CompileConstraintsAsync()) ([Windows.Media.SpeechRecognition.SpeechRecognitionCompilationResult])
  if ($compiled.Status -ne [Windows.Media.SpeechRecognition.SpeechRecognitionResultStatus]::Success) {
    throw "no se pudieron compilar las restricciones de dictado"
  }

  Say "MODE::winrt"
  Say ("READY::" + $rec.CurrentLanguage.LanguageTag)

  # 0x80045509 = speech privacy policy not accepted (online speech recognition off).
  # We detect it and fall back to the classic engine with an actionable message.
  $PRIVACY_HR = '0x80045509'
  $seenErr = @{}
  $consecutiveFails = 0
  :winrtloop while ($true) {
    try {
      $op = $rec.RecognizeAsync()
      $res = Await $op ([Windows.Media.SpeechRecognition.SpeechRecognitionResult])
      if ($res -and $res.Text -and $res.Text.Trim()) {
        $consecutiveFails = 0
        # La confianza de WinRT es un enumerado (High/Medium/Low/Rejected): se pasa a
        # número para que el proceso principal pueda decidir si avisar al usuario.
        $c = switch ([string]$res.Confidence) { 'High' { 0.9 } 'Medium' { 0.6 } 'Low' { 0.3 } default { 0.1 } }
        Say ("FINAL::" + $res.Text.Trim() + [char]31 + $c)
      }
    } catch {
      $hr = ('0x{0:X8}' -f ($_.Exception.HResult -band 0xFFFFFFFF))
      $agg = $_.Exception.InnerException
      if ($agg) { $hr = ('0x{0:X8}' -f ($agg.HResult -band 0xFFFFFFFF)) }
      if ($hr -eq $PRIVACY_HR) {
        Say "ERROR::Para el dictado de alta calidad, activa 'Reconocimiento de voz en linea' en Configuracion de Windows > Privacidad y seguridad > Voz (ms-settings:privacy-speech). Uso el motor clasico mientras tanto."
        break :winrtloop
      }
      $consecutiveFails++
      if ($consecutiveFails -ge 12) {
        Say "ERROR::No se puede acceder al microfono (revisa el dispositivo de entrada predeterminado en ms-settings:sound)."
        break :winrtloop
      }
      if (-not $seenErr[$hr]) {
        $seenErr[$hr] = $true
        $msg = if ($agg) { $agg.Message } else { $_.Exception.Message }
        Say ("NOTE::HR=" + $hr + " " + $msg.Split("`
")[0])
      }
      Start-Sleep -Milliseconds 600
    }
  }
} catch {
  if (-not $NoWinrt) {
    Say ("NOTE::WinRT no disponible (" + ($_.Exception.Message.Split("`
")[0]) + "), usando motor clasico")
  }
}

# ---------- Engine 2: System.Speech fallback (SAPI) ----------
try {
  Add-Type -AssemblyName System.Speech

  $rid = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
    Where-Object { $_.Culture.Name -like ($Lang + "*") } | Select-Object -First 1
  if (-not $rid) {
    $rid = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Select-Object -First 1
  }
  if (-not $rid) {
    Say "ERROR::No hay reconocedores de voz instalados (agrega el paquete de idioma en Configuracion de Windows)."
    exit 1
  }

  $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine($rid)
  $rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $rec.SetInputToDefaultAudioDevice()
  # tuned for dictation: don't clip sentence starts, tolerate natural pauses
  $rec.BabbleTimeout = [TimeSpan]::FromSeconds(0)
  $rec.EndSilenceTimeout = [TimeSpan]::FromSeconds(1.2)
  $rec.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromSeconds(1.0)

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

  # Fin de la entrada estándar: si la app se cierra de golpe, su tubería se cierra
  # con ella y este bucle no puede quedarse girando para siempre con el micrófono
  # abierto. La lectura va en un hilo aparte porque las lecturas asíncronas de
  # .NET sobre la entrada estándar devuelven fin de flujo antes de tiempo.
  $stdinWatch = $false
  try {
    Add-Type -Namespace Sagitari -Name StdinWatch -MemberDefinition @'
public static volatile bool Eof;
public static void Start()
{
    var t = new System.Threading.Thread(() => {
        try
        {
            var input = System.Console.OpenStandardInput();
            var buf = new byte[256];
            while (input.Read(buf, 0, buf.Length) > 0) { }
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
    if ($global:VoiceEvents -eq 0 -and ([DateTime]::Now - $start).TotalSeconds -gt 30) {
      Say "HINT::No llega audio: revisa el microfono predeterminado en ms-settings:sound (si usas NVIDIA Broadcast o similar, asegurate de que el microfono real sea el predeterminado)."
      $start = [DateTime]::Now
    }
  }
} catch {
  Say ("ERROR::" + $_.Exception.Message)
  exit 1
}
