'use strict';
/**
 * Generates the one-paste PowerShell setup script for a dev PC.
 * Works in Windows PowerShell 5.1 and PowerShell 7; no admin rights needed.
 *
 * It (1) downloads the relay CA and checks its fingerprint, (2) checks for Node.js,
 * (3) backs up claude_desktop_config.json and merges the "agent-relay" entry in place,
 * leaving every other MCP server untouched. If the existing config is broken it stops,
 * changes nothing and shows the offending lines.
 */

const psq = (s) => `'${String(s).replace(/'/g, "''")}'`; // PowerShell single-quoted literal

/**
 * @param {{url:string, server:string, tls:boolean, caHash?:string, agent:string, caPath?:string}} o
 */
function buildSetupScript(o) {
  const caPath = o.caPath || 'C:\\AgentRelay\\relay-ca.pem';
  const lines = [];
  lines.push(`# Agent Relay setup for "${o.agent}" - paste this whole block into PowerShell on the dev PC (no admin needed).`);
  lines.push(`& {`);
  lines.push(`$ErrorActionPreference = 'Stop'`);
  lines.push(`$Url = ${psq(o.url)}`);
  if (o.tls) {
    lines.push(`$Server = ${psq(o.server)}`);
    lines.push(`$Ca = ${psq(caPath)}`);
    lines.push(`$Hash = ${psq(o.caHash)}`);
    lines.push(`Write-Host '1/3 Downloading the relay certificate...'`);
    lines.push(`New-Item -ItemType Directory -Force (Split-Path $Ca) | Out-Null`);
    lines.push(`& curl.exe -sSk --max-time 20 "$Server/ca.pem" -o $Ca`);
    lines.push(`if ($LASTEXITCODE -ne 0 -or -not (Test-Path $Ca)) { Write-Host "Could not reach $Server - is Agent Relay running there, and is port open in the firewall on that PC?" -ForegroundColor Red; return }`);
    lines.push(`if ((Get-FileHash $Ca -Algorithm SHA256).Hash -ne $Hash) { Remove-Item $Ca -Force; Write-Host 'STOP: the certificate fingerprint does not match the one shown in Agent Relay. Nothing was changed.' -ForegroundColor Red; return }`);
    lines.push(`Write-Host '    Certificate verified.' -ForegroundColor Green`);
  } else {
    lines.push(`Write-Host '1/3 Encryption is off on the relay - skipping the certificate step.'`);
  }
  lines.push(`Write-Host '2/3 Checking for Node.js...'`);
  lines.push(`if (Get-Command npx -ErrorAction SilentlyContinue) { Write-Host '    Node.js found.' -ForegroundColor Green } else { Write-Host '    Node.js was not found. Install the LTS version from https://nodejs.org, then restart Claude Desktop.' -ForegroundColor Yellow }`);
  lines.push(`Write-Host '3/3 Updating Claude Desktop config...'`);
  // Config locations: normal install, Microsoft Store install, or an explicit override (used by tests).
  lines.push(`$paths = @()`);
  lines.push(`if ($env:AGENT_RELAY_CONFIG_PATHS) { $paths = $env:AGENT_RELAY_CONFIG_PATHS -split ';' } else {`);
  lines.push(`  $paths = @("$env:APPDATA\\Claude\\claude_desktop_config.json")`);
  lines.push(`  $paths += @(Get-ChildItem "$env:LOCALAPPDATA\\Packages\\Claude_*\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })`);
  lines.push(`}`);
  lines.push(`$targets = @($paths | Where-Object { Test-Path $_ })`);
  lines.push(`if ($targets.Count -eq 0) { $targets = @($paths[0]) }`);
  const args = o.tls ? `@('-y', 'mcp-remote@latest', $Url, '--transport', 'http-only')` : `@('-y', 'mcp-remote@latest', $Url, '--allow-http', '--transport', 'http-only')`;
  lines.push(`$entry = [ordered]@{ command = 'npx'; args = ${args} }`);
  if (o.tls) lines.push(`$entry.env = [ordered]@{ NODE_EXTRA_CA_CERTS = $Ca }`);
  lines.push(`foreach ($p in $targets) {`);
  lines.push(`  $cfg = New-Object PSObject`);
  lines.push(`  if (Test-Path $p) {`);
  lines.push(`    $raw = [IO.File]::ReadAllText($p)`);
  lines.push(`    $bak = "$p.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"`);
  lines.push(`    Copy-Item $p $bak -Force`);
  lines.push(`    if ($raw.Trim()) {`);
  lines.push(`      $parsed = $false`);
  lines.push(`      try { $cfg = ConvertFrom-Json -InputObject $raw; $parsed = $true } catch { }`);
  // A comma right before } or ] is the most common hand-editing slip; retry without it.
  lines.push(`      if (-not $parsed) { try { $cfg = ConvertFrom-Json -InputObject ([regex]::Replace($raw, ',(\\s*[}\\]])', '$1')); $parsed = $true; Write-Host '    Fixed a stray comma in your config.' -ForegroundColor Yellow } catch { } }`);
  lines.push(`      if (-not $parsed) { try { $null = ConvertFrom-Json -InputObject $raw } catch {`);
  lines.push(`        Write-Host ""`);
  lines.push(`        Write-Host "Your existing config is not valid JSON - that is the 'Couldn't load app settings' error. Nothing was changed." -ForegroundColor Red`);
  lines.push(`        Write-Host "File: $p   (backup: $bak)"`);
  lines.push(`        Write-Host "Parser says: $($_.Exception.Message)"`);
  lines.push(`        $m = [regex]::Match($_.Exception.Message + ' ' + $_.ToString(), '[Ll]ine\\D{0,3}(\\d+)')`);
  lines.push(`        $all = $raw -split "\\r?\\n"`);
  lines.push(`        $ln = 0
        if ($m.Success) { $ln = [int]$m.Groups[1].Value } else { $pm = [regex]::Match($_.Exception.Message, '\\((\\d+)\\)'); if ($pm.Success) { $pos = [Math]::Min([int]$pm.Groups[1].Value, $raw.Length); $ln = ($raw.Substring(0, $pos) -split "\\n").Count } }
        if ($ln -gt 0) { $from = [Math]::Max(1, $ln - 6); $to = [Math]::Min($all.Count, $ln + 3); Write-Host "Lines $from-$($to):"; for ($i = $from; $i -le $to; $i++) { Write-Host ("{0,5}: {1}" -f $i, $all[$i - 1]) } }`);
  lines.push(`        Write-Host 'Most common cause: a whole { "mcpServers": ... } snippet pasted as a second object - delete the extra { line (and its matching }) shown above. Fix it (or rename the file to start fresh), then run this again.' -ForegroundColor Yellow`);
  lines.push(`        return`);
  lines.push(`      } }`);
  lines.push(`    }`);
  lines.push(`  } else { New-Item -ItemType Directory -Force (Split-Path $p) | Out-Null }`);
  lines.push(`  if (-not $cfg.PSObject.Properties['mcpServers'] -or $null -eq $cfg.mcpServers) { $cfg | Add-Member -NotePropertyName mcpServers -NotePropertyValue (New-Object PSObject) -Force }`);
  lines.push(`  $cfg.mcpServers | Add-Member -NotePropertyName 'agent-relay' -NotePropertyValue $entry -Force`);
  lines.push(`  $json = ConvertTo-Json -InputObject $cfg -Depth 64`);
  lines.push(`  [IO.File]::WriteAllText($p, $json, (New-Object System.Text.UTF8Encoding $false))`);
  lines.push(`  Write-Host "    Updated $p" -ForegroundColor Green`);
  lines.push(`}`);
  lines.push(`Write-Host ''`);
  lines.push(`Write-Host 'Done. Fully quit Claude Desktop (system tray icon -> Quit) and start it again.' -ForegroundColor Cyan`);
  lines.push(`}`);
  return lines.join('\r\n') + '\r\n';
}

module.exports = { buildSetupScript };
