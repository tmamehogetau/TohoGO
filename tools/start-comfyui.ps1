<#
.SYNOPSIS
    ComfyUI を Strata なしで単独起動する（DSH のバックグラウンドジョブとして実行する想定）。
.DESCRIPTION
    GPU を ComfyUI 専用で使う。Strata が起動している場合は先に止めること。
    カスタムノードは読み込まない（コアノードのみで Qwen 系ワークフローを実行）。
    出力・入出力・ユーザーディレクトリはワークスペース内 .tmp に逃がす。
.NOTES
    例: run_in_background で
      pwsh -NoProfile -File tools/start-comfyui.ps1
    起動後: http://127.0.0.1:8188
#>
$ErrorActionPreference = 'Stop'
$Root = "C:\Users\kou-1\ComfyUI"
$Work = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Out = Join-Path $Work ".tmp\comfy-output"
$Tmp = Join-Path $Work ".tmp\comfy-temp"
$In = Join-Path $Work ".tmp\comfy-input"
$User = Join-Path $Work ".tmp\comfy-user"
foreach ($d in @($Out, $Tmp, $In, $User)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

$sysPy = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"
$py = if (Test-Path -LiteralPath $sysPy) { $sysPy } else { Join-Path $Root "venv-rocm\Scripts\python.exe" }

$env:PYTHONPATH = Join-Path $Root "venv-rocm\Lib\site-packages"
$env:PYTHONIOENCODING = "utf-8"
$env:NUMBA_CACHE_DIR = Join-Path $env:TEMP "ComfyUI-numba-cache"
$env:AUX_ORT_PROVIDERS = "CPUExecutionProvider"

Set-Location $Root
& $py main.py --listen 127.0.0.1 --port 8188 --disable-all-custom-nodes `
    --output-directory $Out --temp-directory $Tmp --input-directory $In --user-directory $User
