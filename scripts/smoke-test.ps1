# Launches the packaged app and verifies the MCP server inside it comes up.
# Fails the build (and blocks the release) if the installed app would not start.
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PWD 'dist\win-unpacked\Agent Relay.exe'
if (-not (Test-Path $exe)) { throw "Packaged app not found at $exe" }
$p = Start-Process -FilePath $exe -PassThru
try {
  $ok = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    if ($p.HasExited) { throw "App exited early with code $($p.ExitCode)" }
    try {
      $r = Invoke-RestMethod -Uri 'http://127.0.0.1:3737/health' -TimeoutSec 2
      if ($r.ok -and $r.app -eq 'agent-relay') { $ok = $true; break }
    } catch { }
  }
  if (-not $ok) { throw 'MCP server in the packaged app did not respond on :3737 within 60s' }
  # The key is required: an unauthenticated MCP call must be refused.
  try { Invoke-WebRequest -Uri 'http://127.0.0.1:3737/mcp/Smoke' -Method Post -Body '{}' -ContentType 'application/json' | Out-Null; throw 'unauthenticated request was accepted' }
  catch { if ($_.Exception.Response.StatusCode.value__ -ne 403) { throw "expected 403, got: $($_.Exception.Message)" } }
  Write-Output 'Smoke test passed: packaged app starts and its MCP server enforces the access key.'
} finally {
  Get-Process -Name 'Agent Relay' -ErrorAction SilentlyContinue | Stop-Process -Force
}
