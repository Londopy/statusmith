# Creates Start Menu + Desktop shortcuts to the built exe.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe  = Join-Path $root "src-tauri\target\release\statusmith.exe"
$ico  = Join-Path $root "src-tauri\icons\icon.ico"
if (-not (Test-Path $exe)) { Write-Error "Build first: npm run build  (exe not found at $exe)"; exit 1 }

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath("Programs"), [Environment]::GetFolderPath("Desktop"))) {
    $lnk = $shell.CreateShortcut((Join-Path $dir "Statusmith.lnk"))
    $lnk.TargetPath = $exe
    $lnk.WorkingDirectory = Split-Path $exe
    $lnk.IconLocation = "$ico,0"
    $lnk.Description = "Custom Discord Rich Presence statuses"
    $lnk.Save()
    Write-Host "Shortcut: $(Join-Path $dir 'Statusmith.lnk')"
}
