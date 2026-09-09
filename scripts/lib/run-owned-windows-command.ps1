param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$ArgumentsBase64,
  [Parameter(Mandatory=$true)][int]$TimeoutMs,
  [string]$CancelFile,
  [string]$OutcomeFile,
  [string]$ReadyFile
)

$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot '..\..\packages\engine\src\sandbox\windows-owned-command-source.json'
$source = (Get-Content -LiteralPath $sourcePath -Raw | ConvertFrom-Json).source
& ([ScriptBlock]::Create($source)) @PSBoundParameters
exit $LASTEXITCODE
