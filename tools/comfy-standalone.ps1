<#
.SYNOPSIS
    comfy-standalone.ps1 (compat shim) - delegates to the shared comfy-driver.
.DESCRIPTION
    The implementation now lives in comfy-driver (one core, one CLI, two GPU
    profiles). This file keeps the historical path and parameters working:

        pwsh -File tools/comfy-standalone.ps1 -SkipStart -Manifest runs.json

    Changes vs the pre-0.2 script:
      * ComfyUI runs on port 8189 (profile 'standalone'); the Strata profile keeps 8188.
      * Progress/metrics land in <OutDir>\_runs.jsonl and _summary.json.
      * Server start/stop is handled by the driver (no more ad-hoc Start-Process here).
#>
param(
    [string]$Prompt,
    [string]$Manifest,
    [string]$PromptList,
    [string]$Workflow = 'C:\Users\kou-1\comfyui-amd-rocm-kit\workflows\image\qwen21_turbo.api.json',
    [string]$OutDir = '',
    [string]$Negative = 'text, watermark, signature, logo, lowres, blurry, bad anatomy, bad hands, extra fingers, deformed, photorealistic, 3d render',
    [int]$Seed = 0,
    [int]$TimeoutSec = 300,
    [int]$ComfyPort = 8189,
    [int]$Width = 0,
    [int]$Height = 0,
    [switch]$SkipStart
)

$ErrorActionPreference = 'Stop'

$DriverHome = $env:COMFY_DRIVER_HOME
if (-not $DriverHome) {
    $candidates = @(
        'C:\Users\kou-1\Projects\comfy-driver',
        'C:\Users\kou-1\Projects\Comfy\comfy-driver'
    )
    $DriverHome = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'comfy.ps1')) } | Select-Object -First 1
}
if (-not $DriverHome) {
    throw 'comfy-driver not found. Set COMFY_DRIVER_HOME to the comfy-driver directory.'
}
$cli = Join-Path $DriverHome 'comfy.ps1'

$forward = @('-Profile', 'standalone', '-TimeoutSec', "$TimeoutSec")
if ($Prompt) { $forward += @('-Prompt', $Prompt) }
if ($PromptList) { $forward += @('-PromptList', $PromptList) }
if ($Manifest) { $forward += @('-Manifest', $Manifest) }
if (-not $Manifest -and $Workflow) { $forward += @('-Workflow', $Workflow) }
if ($OutDir) { $forward += @('-OutDir', $OutDir) }
if ($PSBoundParameters.ContainsKey('Negative')) { $forward += @('-Negative', $Negative) }
if ($Seed) { $forward += @('-Seed', "$Seed") }
if ($Width -gt 0) { $forward += @('-Width', "$Width") }
if ($Height -gt 0) { $forward += @('-Height', "$Height") }
if ($SkipStart) { $forward += @('-SkipStart') }

$profilesPath = Join-Path $DriverHome 'config\comfy-profiles.json'
if (Test-Path -LiteralPath $profilesPath) {
    $port = [int](Get-Content -LiteralPath $profilesPath -Raw | ConvertFrom-Json).profiles.standalone.port
    if ($port -and $ComfyPort -ne $port) {
        Write-Warning "ComfyPort=$ComfyPort ignored; profile 'standalone' uses port $port."
    }
}

& pwsh -NoProfile -File $cli @forward
exit $LASTEXITCODE
