<#
.SYNOPSIS
    ComfyUI 単独で画像を生成するルート（Strata を使わない）。
.DESCRIPTION
    共有 GPU の Strata が停止している前提で、ComfyUI だけを起動して
    ワークフローを投入し、画像をダウンロードする。
    comfygen.ps1 の Strata ハンドオフは行わない。

    使い方（単発）:
      pwsh tools/comfy-standalone.ps1 -Prompt "..." -Seed 1001 -OutDir .tmp/out
    使い方（バッチ）:
      pwsh tools/comfy-standalone.ps1 -Manifest tools/card-art/runs.json
    Manifest:
      {"outdir":"...","timeout_sec":300,"runs":[
        {"prompt":"...","seed":1001,"name":"k_remi","negative":"..."}]}
    "name" を付けると <outdir>/<name>.png に保存する。
#>
param(
    [string]$Prompt,
    [string]$Manifest,
    [string]$PromptList,
    [string]$Workflow = "C:\Users\kou-1\comfyui-amd-rocm-kit\workflows\image\qwen21_turbo.api.json",
    [string]$OutDir = "",
    [string]$Negative = "text, watermark, signature, logo, lowres, blurry, bad anatomy, bad hands, extra fingers, deformed, photorealistic, 3d render",
    [int]$Seed = 0,
    [int]$TimeoutSec = 300,
    [int]$ComfyPort = 8188,
    [switch]$SkipStart
)

$ErrorActionPreference = 'Stop'
$Comfy = "http://127.0.0.1:$ComfyPort"
$Root = "C:\Users\kou-1\ComfyUI"
$LogDir = Join-Path $PSScriptRoot "..\.tmp"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Test-Comfy {
    try { Invoke-RestMethod "$Comfy/system_stats" -TimeoutSec 3 | Out-Null; return $true } catch { return $false }
}

function Ensure-Comfy {
    if (Test-Comfy) { Write-Host "ComfyUI: already running"; return }
    if ($SkipStart) { throw "ComfyUI is not running (8188) and -SkipStart was given" }
    $sysPy = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"
    $venvPy = Join-Path $Root "venv-rocm\Scripts\python.exe"
    $py = if (Test-Path -LiteralPath $sysPy) { $sysPy } elseif (Test-Path -LiteralPath $venvPy) { $venvPy } else { throw "ComfyUI python not found ($sysPy / $venvPy)" }
    Write-Host "ComfyUI: starting standalone ($py)"
    # start-resident.cmd と同じ環境（システム Python + venv の site-packages）
    $env:PYTHONPATH = Join-Path $Root "venv-rocm\Lib\site-packages"
    $env:PYTHONIOENCODING = "utf-8"
    $env:NUMBA_CACHE_DIR = Join-Path $env:TEMP "ComfyUI-numba-cache"
    $env:AUX_ORT_PROVIDERS = "CPUExecutionProvider"
    # サンドボックス対策: 書き込み先（output/temp/input/user）をワークスペース内へ逃がす
    $work = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    $comfyOut = Join-Path $work ".tmp\comfy-output"
    $comfyTmp = Join-Path $work ".tmp\comfy-temp"
    $comfyIn = Join-Path $work ".tmp\comfy-input"
    $comfyUser = Join-Path $work ".tmp\comfy-user"
    foreach ($d in @($comfyOut, $comfyTmp, $comfyIn, $comfyUser)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
    $out = Join-Path $LogDir "comfy-standalone.out.log"
    $err = Join-Path $LogDir "comfy-standalone.err.log"
    Start-Process -FilePath $py `
        -ArgumentList @(
            "main.py", "--listen", "127.0.0.1", "--port", "$ComfyPort", "--disable-all-custom-nodes",
            "--output-directory", $comfyOut,
            "--temp-directory", $comfyTmp,
            "--input-directory", $comfyIn,
            "--user-directory", $comfyUser
        ) `
        -WorkingDirectory $Root -WindowStyle Hidden `
        -RedirectStandardOutput $out -RedirectStandardError $err | Out-Null
    $deadline = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        if (Test-Comfy) { Write-Host "ComfyUI: ready"; return }
    }
    throw "ComfyUI did not become ready within 180s. See $err"
}

function Invoke-ComfyRun($run, [int]$index) {
    $wfPath = if ($run.workflow) { $run.workflow } else { $Workflow }
    $runSeed = if ($null -ne $run.seed) { [int]$run.seed } else { $Seed }
    $runPrompt = [string]$run.prompt
    $runNegative = if ($null -ne $run.negative) { [string]$run.negative } else { $Negative }
    $runName = if ($run.name) { [string]$run.name } else { $null }
    $timeout = if ($null -ne $run.timeout) { [int]$run.timeout } else { $TimeoutSec }

    $wf = Get-Content $wfPath -Raw | ConvertFrom-Json

    # sampler seed
    $sampler = @($wf.PSObject.Properties | Where-Object { $_.Value.class_type -match 'IrisSampler|KSampler' }) | Select-Object -First 1
    if ($sampler -and ($sampler.Value.inputs.PSObject.Properties.Name -contains 'seed')) {
        $sampler.Value.inputs.seed = $runSeed
    }

    # prompt / negative
    $textNodes = @($wf.PSObject.Properties | Where-Object { $_.Value.class_type -eq 'CLIPTextEncode' -and $_.Value.inputs.text -is [string] } | Sort-Object Name)
    $qwenNode = $wf.PSObject.Properties | Where-Object { $_.Value.class_type -eq 'TextEncodeQwenImage21' } | Select-Object -First 1
    $irisNode = $wf.PSObject.Properties | Where-Object { $_.Value.class_type -eq 'IrisTextEncode' } | Select-Object -First 1
    if ($qwenNode) {
        $qwenNode.Value.inputs.prompt = $runPrompt
        if ($runNegative) { $qwenNode.Value.inputs.negative_prompt = $runNegative }
    } elseif ($irisNode) {
        $irisNode.Value.inputs.positive = $runPrompt
    } elseif ($textNodes.Count -eq 0) {
        throw "No text node found in $wfPath"
    } else {
        $positive = $textNodes | Where-Object { $_.Value._meta.title -match 'positive|instruction|prompt' } | Select-Object -First 1
        if ($positive) { $positive.Value.inputs.text = $runPrompt }
        else {
            $textNodes[0].Value.inputs.text = $runPrompt
            if ($textNodes.Count -gt 1 -and $runNegative) { $textNodes[1].Value.inputs.text = $runNegative }
        }
    }

    # submit
    $body = @{ prompt = $wf; client_id = "comfy-standalone" } | ConvertTo-Json -Depth 30
    $id = [string](Invoke-RestMethod -Method Post -Uri "$Comfy/prompt" -Body $body -ContentType 'application/json').prompt_id
    if ([string]::IsNullOrWhiteSpace($id)) { throw "ComfyUI /prompt returned no prompt_id" }
    Write-Host "submitted [$index] $id"

    # poll
    $deadline = (Get-Date).AddSeconds($timeout)
    $entry = $null
    do {
        Start-Sleep -Seconds 4
        $hist = Invoke-RestMethod "$Comfy/history/$id"
        $entry = $hist.$id
        $isError = $entry -and $entry.status -and $entry.status.status_str -eq 'error'
        $isCompleted = $entry -and $entry.status -and $entry.status.completed
    } until ($isError -or $isCompleted -or (Get-Date) -gt $deadline)
    if (-not $entry) { throw "generation timed out after ${timeout}s (prompt_id=$id)" }
    if ($entry.status -and $entry.status.status_str -eq 'error') { throw "workflow failed (prompt_id=$id)" }

    $images = @(
        foreach ($out in $entry.outputs.PSObject.Properties) {
            foreach ($img in @($out.Value.images)) { if ($img) { $img } }
        }
    )
    if ($images.Count -eq 0) { throw "workflow completed without images (prompt_id=$id)" }

    $saved = @()
    $i = 0
    foreach ($img in $images) {
        $i++
        $file = if ($runName) {
            if ($images.Count -gt 1) { Join-Path $OutDir "$runName-$i.png" } else { Join-Path $OutDir "$runName.png" }
        } else {
            Join-Path $OutDir ("{0}-{1}-r{2}-i{3}-{4}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $id.Substring(0, 8), $index, $i, [IO.Path]::GetFileName([string]$img.filename))
        }
        $query = 'filename={0}&subfolder={1}&type={2}' -f `
            [Uri]::EscapeDataString([string]$img.filename), `
            [Uri]::EscapeDataString([string]$img.subfolder), `
            [Uri]::EscapeDataString([string]$img.type)
        Invoke-WebRequest "$Comfy/view?$query" -OutFile $file
        Write-Host "saved: $file"
        $saved += $file
    }
    return $saved
}

# ---- runs の組み立て ----
$runs = @()
if ($Manifest) {
    $m = Get-Content $Manifest -Raw | ConvertFrom-Json
    if ($m.outdir) { $OutDir = [string]$m.outdir }
    if ($m.timeout_sec) { $TimeoutSec = [int]$m.timeout_sec }
    foreach ($r in @($m.runs)) {
        $runs += @{ prompt = [string]$r.prompt; seed = $r.seed; negative = $r.negative; name = $r.name; workflow = $r.workflow; timeout = $r.timeout }
    }
} elseif ($PromptList) {
    foreach ($line in Get-Content $PromptList) {
        $t = $line.Trim()
        if (-not $t -or $t.StartsWith('#')) { continue }
        if ($t -match '^(\d+)\s*\|\s*(.+)$') { $runs += @{ prompt = $Matches[2]; seed = [int]$Matches[1] } }
        else { $runs += @{ prompt = $t; seed = $Seed } }
    }
} elseif ($Prompt) {
    $runs += @{ prompt = $Prompt; seed = $Seed }
} else {
    throw "Specify -Prompt, -PromptList or -Manifest"
}

$skipStart = $SkipStart
if (-not $skipStart) { Ensure-Comfy }
if (-not $OutDir) { $OutDir = Join-Path $LogDir "comfy-out" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$results = @()
$n = 0
foreach ($run in $runs) {
    $n++
    try {
        $files = Invoke-ComfyRun $run $n
        $results += [ordered]@{ index = $n; ok = $true; name = $run.name; files = @($files) }
    } catch {
        Write-Warning "run ${n} failed: $($_.Exception.Message)"
        $results += [ordered]@{ index = $n; ok = $false; name = $run.name; error = $_.Exception.Message }
    }
}

$summary = Join-Path $OutDir "_summary.json"
$results | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summary -Encoding UTF8
$okCount = @($results | Where-Object { $_.ok }).Count
Write-Host "done: $okCount/$($runs.Count) saved to $OutDir"
if ($okCount -lt $runs.Count) { exit 2 }
