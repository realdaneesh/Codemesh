$ErrorActionPreference = 'Stop'
$pilotRoot = Split-Path $PSScriptRoot -Parent
Push-Location $pilotRoot
# npm 11 redacts GUID-shaped path segments in `npm list` output. Use a numeric
# unique suffix so vsce receives real paths during dependency discovery.
$pilotStage = Join-Path ([IO.Path]::GetTempPath()) ('codemesh-vsix-' + [DateTime]::UtcNow.Ticks + '-' + (Get-Random))
try {
    npm run compile -w extension
    if ($LASTEXITCODE -ne 0) { throw 'Extension compilation failed' }
    New-Item -ItemType Directory -Path $pilotStage | Out-Null
    Copy-Item -LiteralPath extension/package.json, extension/dist, extension/resources, extension/README.md, extension/.vscodeignore -Destination $pilotStage -Recurse
    New-Item -ItemType Directory -Path "$pilotStage/node_modules" | Out-Null
    # The extension's two runtime packages are pure JS with no required dependencies.
    # Resolve from the extension, since npm workspaces hoists them to the root.
    foreach ($pilotDependency in @('ws', 'ignore')) {
        $pilotPackageFile = node -e "console.log(require.resolve('$pilotDependency/package.json', { paths: [require('node:path').resolve('extension')] }))"
        if ($LASTEXITCODE -ne 0) { throw "Missing runtime dependency: $pilotDependency. Run npm ci." }
        $pilotDependencyManifest = Get-Content -LiteralPath $pilotPackageFile -Raw | ConvertFrom-Json
        if ($pilotDependencyManifest.dependencies -and @($pilotDependencyManifest.dependencies.PSObject.Properties).Count) {
            throw "$pilotDependency now has required dependencies; update staging before packaging."
        }
        Copy-Item -LiteralPath (Split-Path $pilotPackageFile -Parent) -Destination "$pilotStage/node_modules/$pilotDependency" -Recurse
    }
    $pilotManifest = Get-Content extension/package.json -Raw | ConvertFrom-Json
    New-Item -ItemType Directory -Force artifacts | Out-Null
    $pilotVsix = Join-Path $pilotRoot "artifacts/codemesh-$($pilotManifest.version)-cloud-pilot.vsix"
    # Discover dependencies only in the standalone staging folder, not the monorepo.
    Push-Location $pilotStage
    $pilotPreviousPrefix = $env:npm_config_prefix
    $env:npm_config_prefix = $pilotStage
    try {
        & "$pilotRoot/node_modules/.bin/vsce.cmd" package --no-yarn --allow-missing-repository --skip-license --out $pilotVsix
        if ($LASTEXITCODE -ne 0) { throw 'VSIX packaging failed' }
    } finally {
        $env:npm_config_prefix = $pilotPreviousPrefix
        Pop-Location
    }
    & "$PSScriptRoot/verify-lan-vsix.ps1" -VsixPath $pilotVsix
    if ($LASTEXITCODE -ne 0) { throw 'VSIX verification failed' }
    Get-FileHash -LiteralPath $pilotVsix -Algorithm SHA256
    Write-Host "Ready to copy to PC B: $pilotVsix"
} finally {
    # Only remove the unique temporary directory created by this invocation.
    if ((Test-Path -LiteralPath $pilotStage) -and (Split-Path $pilotStage -Leaf).StartsWith('codemesh-vsix-') -and
        (Split-Path $pilotStage -Parent) -eq ([IO.Path]::GetTempPath()).TrimEnd('\')) {
        Remove-Item -LiteralPath $pilotStage -Recurse -Force
    }
    Pop-Location
}
