param([switch]$RuntimeOnly, [ValidateSet('All','Image','Encoder','Vae','Runtime')][string]$Component = 'All')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$ProgressPreference = 'SilentlyContinue'
function Get-VerifiedFile($Url, $Target, $Hash) {
    if (Test-Path -LiteralPath $Target) {
        if ((Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLower() -eq $Hash) { Write-Host "Already verified: $Target"; return }
        throw "Existing file has an incorrect checksum: $Target"
    }
    Write-Host "Downloading: $Target"
    $ariaBinary = Get-ChildItem runtime -Filter aria2c.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($ariaBinary) {
        $downloadDir = '--dir=' + (Split-Path $Target -Parent)
        $downloadOut = '--out=' + (Split-Path $Target -Leaf) + '.part'
        & $ariaBinary.FullName --continue=true --max-connection-per-server=8 --split=8 --min-split-size=16M --file-allocation=none --summary-interval=30 --console-log-level=warn --download-result=hide --auto-file-renaming=false --allow-overwrite=true --max-tries=8 --retry-wait=3 $downloadDir $downloadOut $Url
    } else {
        & curl.exe -L --fail --retry 8 --retry-delay 3 -C - --output "$Target.part" $Url
    }
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $Target; run Install.ps1 again to resume." }
    if ((Get-FileHash -LiteralPath "$Target.part" -Algorithm SHA256).Hash.ToLower() -ne $Hash) { throw "Checksum mismatch: $Target.part" }
    Move-Item -LiteralPath "$Target.part" -Destination $Target
    Write-Host "Verified: $Target"
}
New-Item -ItemType Directory -Force models,runtime,outputs,logs | Out-Null
$imageRepo = 'https://huggingface.co/KasugaiSakura/Qwen-Image-2.1-Uncensored-Abenzerps-GGUF/resolve/240ef1d68f778115f8ff69965eca9ad6d3ccdcf1'
if (!$RuntimeOnly -and $Component -in @('All','Image')) {
    Get-VerifiedFile "$imageRepo/qwen-image-2.1-UC-Q4_K_M.gguf" 'models/qwen-image-2.1-UC-Q4_K_M.gguf' 'e79c8a009f2ecbdb6c70fd663d9aea9ee304a0d91f347e4169a756b8ad141b41'
}
if (!$RuntimeOnly -and $Component -in @('All','Encoder')) {
    Get-VerifiedFile 'https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/f982a07559d4a2f6c8744d840bf6fccab30eea96/Qwen3VL-8B-Instruct-Q4_K_M.gguf' 'models/Qwen3VL-8B-Instruct-Q4_K_M.gguf' '67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2'
}
if (!$RuntimeOnly -and $Component -in @('All','Vae')) {
    Get-VerifiedFile "$imageRepo/vae/qwen_image_2.1_vae_bf16.safetensors" 'models/qwen_image_2.1_vae_bf16.safetensors' 'bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9'
}
if ($RuntimeOnly -or $Component -in @('All','Runtime')) {
$release = Invoke-RestMethod 'https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/tags/master-929-3f8527a'
foreach ($assetName in @('sd-master-3f8527a-bin-win-cuda12-x64.zip','cudart-sd-bin-win-cu12-x64.zip')) {
    $asset = $release.assets | Where-Object name -eq $assetName
    if (!$asset -or !$asset.digest.StartsWith('sha256:')) { throw "No SHA256 digest for runtime asset $assetName" }
    $archive = "runtime/$assetName"
    Get-VerifiedFile $asset.browser_download_url $archive $asset.digest.Substring(7)
    Expand-Archive -LiteralPath $archive -DestinationPath runtime -Force
}
$sdBinary = Get-ChildItem runtime -Filter sd-cli.exe -Recurse | Select-Object -First 1
if (!$sdBinary) { throw 'sd-cli.exe missing from the runtime archive.' }
Set-Content -LiteralPath runtime/cli-path.txt -Value $sdBinary.FullName -Encoding utf8
}
$completedName = if ($RuntimeOnly) { 'Runtime' } else { $Component }
Write-Host "Requested component installation complete ($completedName). No model has been started."
