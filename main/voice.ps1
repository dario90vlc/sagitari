param([string]$Lang = "es-ES")

$ErrorActionPreference = "Stop"
try {
  Add-Type -AssemblyName System.Speech

  $rid = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
    Where-Object { $_.Culture.Name -like ($Lang + "*") } | Select-Object -First 1
  if (-not $rid) {
    $rid = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Select-Object -First 1
  }
  if (-not $rid) {
    [Console]::Out.WriteLine("ERROR::No hay reconocedores de voz instalados (agrega el paquete de idioma en Configuración de Windows).")
    [Console]::Out.Flush(); exit 1
  }

  $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine($rid)
  $rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $rec.SetInputToDefaultAudioDevice()
  $rec.BabbleTimeout = [TimeSpan]::FromSeconds(0.4)
  $rec.EndSilenceTimeout = [TimeSpan]::FromSeconds(0.8)

  Register-ObjectEvent -InputObject $rec -EventName SpeechHypothesized -Action {
    try { [Console]::Out.WriteLine("PART::" + $EventArgs.Result.Text); [Console]::Out.Flush() } catch {}
  } | Out-Null
  Register-ObjectEvent -InputObject $rec -EventName SpeechRecognized -Action {
    try { [Console]::Out.WriteLine("FINAL::" + $EventArgs.Result.Text); [Console]::Out.Flush() } catch {}
  } | Out-Null

  $rec.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
  [Console]::Out.WriteLine("READY::" + $rid.Culture.Name)
  [Console]::Out.Flush()

  while ($true) { Start-Sleep -Milliseconds 250 }
} catch {
  [Console]::Out.WriteLine("ERROR::" + $_.Exception.Message)
  [Console]::Out.Flush()
  exit 1
}
