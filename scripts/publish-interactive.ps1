# One-shot interactive npm publish (WebAuthn device flow) for dsh-service-watchdog.
# Token is read from env -> User scope -> secrets file; never printed or persisted.
# Run in YOUR interactive terminal (the WebAuthn flow needs a TTY + browser):
#   powershell -ExecutionPolicy Bypass -File scripts\publish-interactive.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $MyInvocation.MyCommand.Path -Parent) -Parent
$node = 'E:\Program Files\DeepSeek Harness\runtime\node\bin\node.exe'
$npmCli = 'E:\Deepseek\Default\npm-cli\node_modules\.pnpm\npm@12.0.2\node_modules\npm\bin\npm-cli.js'

$token = $env:NPM_PUBLISH_TOKEN
if (-not $token) { $token = [Environment]::GetEnvironmentVariable('NPM_PUBLISH_TOKEN', 'User') }
if (-not $token) {
  $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
  $secrets = Join-Path $dshHome 'secrets\npm-token.txt'
  if (Test-Path $secrets) { $token = (Get-Content $secrets -Raw).Trim() }
}
if (-not $token) { throw 'npm token missing. Run: setx NPM_PUBLISH_TOKEN "<your-granular-token>"' }

Push-Location $root
try {
  Set-Content -Path '.npmrc' -Value ("//registry.npmjs.org/:_authToken=" + $token) -Encoding ascii
  Write-Host 'Publishing dsh-service-watchdog via official npm CLI (WebAuthn).'
  Write-Host 'If npm prints a URL like https://www.npmjs.com/auth/cli/<id>, open it in your browser and approve with your security key.'
  & $node $npmCli publish --ignore-scripts --cache '.npm-cache'
  if ($LASTEXITCODE -ne 0) { throw "npm publish failed (exit $LASTEXITCODE)" }
  Write-Host 'Published. Verify at: https://www.npmjs.com/package/dsh-service-watchdog'
} finally {
  Remove-Item -Force '.npmrc' -ErrorAction SilentlyContinue
  Pop-Location
}
