param(
  [string]$Code = $env:CODEMESH_VSCODE_PATH,
  [string]$Workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$ProfileRoot = (Join-Path $env:TEMP 'codemesh-two-hosts')
)

$ErrorActionPreference = 'Stop'
if (-not $Code) {
  $Code = 'C:\Users\danee\Documents\Microsoft VS Code\Code.exe'
}
if (-not (Test-Path -LiteralPath $Code -PathType Leaf)) {
  throw "VS Code executable not found: $Code"
}

$extension = (Resolve-Path (Join-Path $PSScriptRoot '..\extension')).Path
$workspacePath = (Resolve-Path $Workspace).Path
New-Item -ItemType Directory -Force -Path $ProfileRoot | Out-Null
$electronRunAsNode = $env:ELECTRON_RUN_AS_NODE
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

try {
  foreach ($member in @(
    @{ Name = 'Alice'; Folder = 'host-a' },
    @{ Name = 'Bob'; Folder = 'host-b' }
  )) {
    $profile = Join-Path $ProfileRoot $member.Folder
    $extensions = Join-Path $profile 'extensions'
    $settings = Join-Path $profile 'user-data\User\settings.json'
    $stdout = Join-Path $profile 'stdout.log'
    $stderr = Join-Path $profile 'stderr.log'
    New-Item -ItemType Directory -Force -Path (Split-Path $settings), $extensions | Out-Null
    $profileSettings = @{ 'codemesh.displayName' = $member.Name; 'codemesh.serverUrl' = 'ws://localhost:3977' } |
      ConvertTo-Json
    [System.IO.File]::WriteAllText($settings, $profileSettings, [System.Text.UTF8Encoding]::new($false))

    $arguments = @(
      "`"$workspacePath`"",
      '--new-window',
      "--user-data-dir=`"$(Join-Path $profile 'user-data')`"",
      "--extensions-dir=`"$extensions`"",
      "--extensionDevelopmentPath=`"$extension`""
    )
    $process = Start-Process -FilePath $Code -ArgumentList $arguments -PassThru `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    [pscustomobject]@{
      Member = $member.Name
      ProcessId = $process.Id
      UserDataDir = Join-Path $profile 'user-data'
      ExtensionsDir = $extensions
      Workspace = $workspacePath
      StdoutLog = $stdout
      StderrLog = $stderr
    }
  }
} finally {
  if ($null -ne $electronRunAsNode) { $env:ELECTRON_RUN_AS_NODE = $electronRunAsNode }
}
