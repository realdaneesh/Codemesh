param([Parameter(Mandatory = $true)][string]$VsixPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$pilotArchive = (Resolve-Path -LiteralPath $VsixPath).Path
$pilotExtract = Join-Path ([IO.Path]::GetTempPath()) ('codemesh-vsix-check-' + [guid]::NewGuid())
try {
    [IO.Compression.ZipFile]::ExtractToDirectory($pilotArchive, $pilotExtract)
    node "$PSScriptRoot/verify-lan-runtime.cjs" "$pilotExtract/extension"
    if ($LASTEXITCODE -ne 0) { throw 'Extracted VSIX runtime check failed' }
    Write-Host 'VSIX archive and isolated runtime check passed (not a two-PC test).'
} finally {
    if ((Test-Path -LiteralPath $pilotExtract) -and (Split-Path $pilotExtract -Leaf).StartsWith('codemesh-vsix-check-') -and
        (Split-Path $pilotExtract -Parent) -eq ([IO.Path]::GetTempPath()).TrimEnd('\')) {
        Remove-Item -LiteralPath $pilotExtract -Recurse -Force
    }
}
