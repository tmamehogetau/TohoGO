<#
.SYNOPSIS
    start-comfyui.ps1 (compat shim) - starts ComfyUI through the shared driver.
.DESCRIPTION
    The driver owns server lifecycle now (profile 'standalone', port 8189).
    Use this only when you want the server up without generating anything.

        pwsh -File tools/start-comfyui.ps1
#>
param(
    [int]$ComfyPort = 8189,
    [string]$Profile = 'standalone'
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

& pwsh -NoProfile -File (Join-Path $DriverHome 'comfy.ps1') -Profile $Profile -StartOnly -ComfyPort $ComfyPort
exit $LASTEXITCODE
