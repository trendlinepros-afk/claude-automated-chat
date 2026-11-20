# Launches the packaged app and verifies the MCP server inside it comes up — over HTTPS,
# validated against the app's own certificate authority — and that the access key is enforced.
# Fails the build (and blocks the release) if the installed app would not work.
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PWD 'dist\win-unpacked\Agent Relay.exe'
if (-not (Test-Path $exe)) { throw "Packaged app not found at $exe" }
$ca = Join-Path $env:APPDATA 'Agent Relay\tls\ca.pem'
$p = Start-Process -FilePath $exe -PassThru
try {
  $ok = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    if ($p.HasExited) { throw "App exited early with code $($p.ExitCode)" }
    if (-not (Test-Path $ca)) { continue }
    $out = node -e "const https=require('https'),fs=require('fs');https.get('https://127.0.0.1:3737/health',{ca:fs.readFileSync(process.argv[1])},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{console.log(d)})}).on('error',e=>{console.log('ERR '+e.message)})" $ca
    if ($out -match '"app":"agent-relay"' -and $out -match '"tls":true') { $ok = $true; break }
  }
  if (-not $ok) { throw "Packaged app did not serve verified HTTPS on :3737 within 60s (last: $out)" }
  Write-Output "HTTPS verified against the app's CA: $out"
  $code = node -e "const https=require('https'),fs=require('fs');const q=https.request('https://127.0.0.1:3737/mcp/Smoke',{method:'POST',ca:fs.readFileSync(process.argv[1]),headers:{'content-type':'application/json'}},r=>{console.log(r.statusCode)});q.on('error',e=>console.log('ERR '+e.message));q.end('{}')" $ca
  if ("$code".Trim() -ne '403') { throw "Expected 403 for a request without the access key, got: $code" }
  Write-Output 'Smoke test passed: packaged app starts, serves verified HTTPS, and enforces the access key.'
} finally {
  Get-Process -Name 'Agent Relay' -ErrorAction SilentlyContinue | Stop-Process -Force
}
