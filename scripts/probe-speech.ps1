param([string]$Lang = "es-ES")
$ErrorActionPreference = "Continue"
Add-Type -AssemblyName System.Speech

Write-Output "=== Installed recognizers ==="
[System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object {
  Write-Output ($_.Culture.Name + " | " + $_.Description + " | id=" + $_.Id)
}

Write-Output "=== Requested lang match ==="
$rid = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
  Where-Object { $_.Culture.Name -like ($Lang + "*") } | Select-Object -First 1
if ($rid) { Write-Output ("MATCH: " + $rid.Culture.Name) } else { Write-Output "NO MATCH for $Lang" }

Write-Output "=== Audio devices (default capture) ==="
try {
  Add-Type -AssemblyName Microsoft.VisualBasic
} catch {}
Get-CimInstance Win32_SoundDevice | ForEach-Object { Write-Output ($_.Name + " | status=" + $_.Status + " | " + $_.StatusInfo) }

Write-Output "=== Confidence behavior quick test (2s capture, no speech expected) ==="
try {
  $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine($rid)
  $rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $rec.SetInputToDefaultAudioDevice()
  $rec.BabbleTimeout = [TimeSpan]::FromSeconds(0.3)
  $rec.EndSilenceTimeout = [TimeSpan]::FromSeconds(0.5)
  $rec.InitialSilenceTimeout = [TimeSpan]::FromSeconds(2)
  $r = $rec.Recognize([TimeSpan]::FromSeconds(4))
  if ($r) { Write-Output ("RESULT: '" + $r.Text + "' conf=" + $r.Confidence) } else { Write-Output "RESULT: (null - nothing captured in 4s)" }
  $rec.Dispose()
} catch {
  Write-Output ("ENGINE ERR: " + $_.Exception.Message)
}
