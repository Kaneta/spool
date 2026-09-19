<#
.SYNOPSIS
  spool Windows installer v1 (PowerShell single script, non-admin).
.DESCRIPTION
  Downloads spool-windows-amd64.zip, verifies SHA-256, stages extraction,
  installs to %LOCALAPPDATA%\Programs\spool\, provisions config/root on
  first run, creates a Desktop shortcut. Existing config/root/records are
  never modified or deleted.
  No PATH mutation, no admin elevation, no installer framework.
.EXAMPLE
  .\install-spool-windows.ps1 -ArchiveUrl https://example.invalid/spool-windows-amd64.zip -ExpectedSha256 <hex64>
#>
[CmdletBinding()]
param(
    # URL of the distribution archive (spool-windows-amd64.zip). HTTPS only.
    # No official URL is assumed; caller must supply it.
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://')]
    [string]$ArchiveUrl,

    # Expected SHA-256 of the archive (64 hex chars). Pinned here instead of
    # downloading SHA256SUMS; mismatch fails before touching the install dir.
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F]{64}$')]
    [string]$ExpectedSha256,

    # After a successful install, launch the Desktop shortcut.
    [switch]$Launch
)

$ErrorActionPreference = 'Stop'

$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\spool'
$RequiredFiles = @('spool.exe', 'spool-clipboard.exe', 'spool.ico')
$ConfigDir = Join-Path $env:USERPROFILE '.config\spool'
$ConfigPath = Join-Path $ConfigDir 'config.json'
$DefaultRoot = Join-Path $env:USERPROFILE 'spool'

# Windows PowerShell 5.1 defaults to TLS 1.0 negotiation; opt into TLS 1.2+.
& {
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch { <# PS7 handles TLS natively #> }
}

function Test-ExclusiveOpen {
    param([string]$Path)
    # Returns $true when the file can be opened with no sharing (i.e. writable
    # by this installer). File must exist at this point.
    $fs = $null
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        return $true
    } catch {
        return $false
    } finally {
        if ($fs) { $fs.Dispose() }
    }
}

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ('spool-install-' + [System.IO.Path]::GetRandomFileName())
$stagingPrepared = $false
$fresh = $false
$exitCode = 0

try {
    Write-Host "spool installer v1"
    Write-Host "  install dir : $InstallDir"
    Write-Host "  archive     : $ArchiveUrl"

    # ---------------------------------------------------------------- staging
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    $stagingPrepared = $true
    $zipPath = Join-Path $staging 'spool-windows-amd64.zip'
    $stagedDir = Join-Path $staging 'extracted'

    Write-Host 'Step 1/5: downloading archive...'
    Invoke-WebRequest -Uri $ArchiveUrl -OutFile $zipPath -UseBasicParsing

    Write-Host 'Step 2/5: verifying SHA-256...'
    $actualHash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash
    if ($actualHash -ne $ExpectedSha256) {
        throw ("SHA-256 mismatch:`n  expected: {0}`n  actual  : {1}`nAborting before any change to the install directory." -f $ExpectedSha256, $actualHash)
    }

    Write-Host 'Step 3/5: extracting...'
    New-Item -ItemType Directory -Path $stagedDir -Force | Out-Null
    Expand-Archive -Path $zipPath -DestinationPath $stagedDir -Force

    # Search staged files at archive root or one level deep.
    foreach ($name in $RequiredFiles) {
        $found = @(Get-ChildItem -Path $stagedDir -Recurse -Filter $name -File | Select-Object -First 1)
        if ($found.Count -eq 0) {
            throw ("required file missing from archive: {0}" -f $name)
        }
    }
    $fresh = -not (Test-Path -LiteralPath $InstallDir)

    # ----------------------------------------------- reinstall preconditions
    if (-not $fresh) {
        Write-Host 'Step 4/5: prechecking replacement of existing install...'
        foreach ($name in $RequiredFiles) {
            $target = Join-Path $InstallDir $name
            if (Test-Path -LiteralPath $target) {
                if (-not (Test-ExclusiveOpen -Path $target)) {
                    throw ("cannot replace '{0}': file locked. Close running spool processes and re-run this script." -f $target)
                }
            }
        }
    }

    # --------------------------------------------------------------- install
    if ($fresh) {
        Write-Host 'Step 4/5: creating install directory...'
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }

    foreach ($name in $RequiredFiles) {
        $src = @(Get-ChildItem -Path $stagedDir -Recurse -Filter $name -File | Select-Object -First 1)[0]
        Copy-Item -LiteralPath $src.FullName -Destination (Join-Path $InstallDir $name) -Force
    }

    # ------------------------------------------------ first-run provisioning
    Write-Host 'Step 5/5: config / root / shortcut...'
    if (Test-Path -LiteralPath $ConfigPath) {
        Write-Host "  existing config found; not modified: $ConfigPath"
    } else {
        New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
        if (-not (Test-Path -LiteralPath $DefaultRoot)) {
            New-Item -ItemType Directory -Path $DefaultRoot -Force | Out-Null
        }
        $json = '{"root":"' + ($DefaultRoot.Replace('\', '\\')) + '"}'
        # UTF-8 WITHOUT BOM: Go's JSON parser rejects BOM.
        [System.IO.File]::WriteAllText($ConfigPath, $json, [System.Text.UTF8Encoding]::new($false))
        Write-Host "  config created: $ConfigPath"
        Write-Host "  root   created: $DefaultRoot"
    }

    # Desktop shortcut
    $desktop = [Environment]::GetFolderPath('Desktop')
    $lnkPath = Join-Path $desktop 'spool.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath = Join-Path $InstallDir 'spool-clipboard.exe'
    $lnk.IconLocation = Join-Path $InstallDir 'spool.ico'
    $lnk.Save()

    Write-Host ''
    Write-Host 'Install complete.'
    Write-Host "  binaries : $InstallDir"
    Write-Host "  shortcut : $lnkPath"
    Write-Host "  config   : $ConfigPath (existing config is preserved as-is)"

    if ($Launch) {
        Write-Host 'Launching spool-clipboard.exe via Desktop shortcut...'
        Start-Process -FilePath $lnkPath
    }
} catch {
    # Fresh-install cleanup: remove only the install dir created by this run;
    # config / root / records are never touched.
    if ($fresh -and (Test-Path -LiteralPath $InstallDir)) {
        $existing = @()
        try {
            $existing = @(Get-ChildItem -LiteralPath $InstallDir -Recurse -File | Select-Object -First 1)
        } catch { $existing = @() }
        if ($existing.Count -gt 0) {
            foreach ($name in $RequiredFiles) {
                $f = Join-Path $InstallDir $name
                if (-not (Test-Path -LiteralPath $f)) { $fresh = $false }
            }
            foreach ($name in $RequiredFiles) {
                $f = Join-Path $InstallDir $name
                if (Test-Path -LiteralPath $f) {
                    if ((Get-Item -LiteralPath $f).Length -eq 0) { $fresh = $false }
                }
            }
        } else { $fresh = $false }
        if ($fresh) {
            try {
                Remove-Item -LiteralPath $InstallDir -Recurse -Force
                Write-Warning 'Removed incomplete fresh install directory.'
            } catch {
                Write-Warning ("could not remove incomplete install dir '{0}': {1}" -f $InstallDir, $_.Exception.Message)
            }
        } else {
            Write-Warning 'Install directory left as-is (may contain pre-existing or verified files).'
        }
    }
    [Console]::Error.WriteLine(("install failed: {0}" -f $_.Exception.Message))
    $exitCode = 1
} finally {
    if ($stagingPrepared) {
        try {
            Remove-Item -LiteralPath $staging -Recurse -Force
        } catch {
            # Cleanup failure must not hide the primary error.
            Write-Warning ("staging cleanup failed ({0}): {1}" -f $staging, $_.Exception.Message)
        }
    }
}

exit $exitCode
