# CI helper: creates a local user and an SMB share that ONLY that user may access,
# so test/smb-backup.js can exercise UNC paths + `net use` credentials for real.
$ErrorActionPreference = 'Stop'
$user = 'relaytest'
$pass = 'Rt!' + [guid]::NewGuid().ToString('N').Substring(0, 16) + 'aZ9'
Write-Output "::add-mask::$pass"
New-LocalUser -Name $user -Password (ConvertTo-SecureString $pass -AsPlainText -Force) -PasswordNeverExpires -AccountNeverExpires | Out-Null
$dir = 'C:\relayshare'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
icacls $dir /grant "${user}:(OI)(CI)F" | Out-Null
New-SmbShare -Name 'RelayBackup' -Path $dir -FullAccess $user | Out-Null
Get-SmbShareAccess -Name 'RelayBackup' | Format-Table -AutoSize | Out-String | Write-Output
"SHARE_UNC=\\localhost\RelayBackup" >> $env:GITHUB_ENV
"SHARE_LOCAL=$dir" >> $env:GITHUB_ENV
"SHARE_USER=$env:COMPUTERNAME\$user" >> $env:GITHUB_ENV
"SHARE_PASS=$pass" >> $env:GITHUB_ENV
