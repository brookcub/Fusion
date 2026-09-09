param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$ArgumentsBase64,
  [Parameter(Mandatory=$true)][int]$TimeoutMs,
  [string]$CancelFile,
  [string]$OutcomeFile,
  [string]$ReadyFile
)

$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot '..\..\packages\engine\src\sandbox\windows-owned-command-source.ts'
# FNXC:WindowsContainment 2026-09-09-13:23: One JSON-escaped program literal
# lives in a TS data module, so both bundled and plain-Node builds load it.
$module = Get-Content -LiteralPath $sourcePath -Raw
$match = [regex]::Match($module, '\Aconst source: string = (?<json>"(?:\\.|[^"\\])*");\r?\nexport default source;\s*\z')
if (-not $match.Success) { throw 'Invalid owned-command source module' }
$source = $match.Groups['json'].Value | ConvertFrom-Json
& ([ScriptBlock]::Create($source)) @PSBoundParameters
exit $LASTEXITCODE
