# Install Kiln for the current user. No administrator access is needed.
[CmdletBinding()]
param(
    [string]$ExecutablePath,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$releaseUrl = 'https://github.com/hongnhatpham/kiln/releases/latest/download'
$asset = 'Kiln-Windows-x64-Portable.exe'
$installDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Kiln'
$target = Join-Path $installDir 'Kiln.exe'
$marker = Join-Path $installDir '.kiln-install'
$programs = [Environment]::GetFolderPath('Programs')
$shortcutPath = Join-Path $programs 'Kiln.lnk'

function Assert-SafeDirectory([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Installation folder must be a regular directory: $Path"
        }
        if ((Test-Path -LiteralPath $marker) -and ((Get-Item -LiteralPath $marker -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Installation marker must not be a link: $marker"
        }
        if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
            if (@(Get-ChildItem -LiteralPath $Path -Force).Count -gt 0) {
                throw "This folder contains files from another installation. Move them first: $Path"
            }
        } elseif ((Get-Content -LiteralPath $marker -Raw).Trim() -ne 'kiln-installer-v1') {
            throw "Unrecognized installation marker: $marker"
        }
    }
}

$temporary = $null
$pending = $null
try {
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'Kiln requires 64-bit Windows.' }
    if ($ExecutablePath) {
        $source = (Resolve-Path -LiteralPath $ExecutablePath).ProviderPath
        if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or [IO.Path]::GetExtension($source) -ne '.exe') {
            throw 'ExecutablePath must point to a local .exe file.'
        }
        Write-Host "Local mode: using the supplied executable. Release checksum verification is skipped: $source"
    }
    Assert-SafeDirectory $installDir
    $shell = New-Object -ComObject WScript.Shell
    if (Test-Path -LiteralPath $shortcutPath) {
        $shortcutItem = Get-Item -LiteralPath $shortcutPath -Force
        if ($shortcutItem.PSIsContainer -or ($shortcutItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Unsafe shortcut destination: $shortcutPath"
        }
        $existing = $shell.CreateShortcut($shortcutPath)
        if ($existing.TargetPath -ine $target) { throw "An unrelated shortcut already exists: $shortcutPath" }
    }
    if ($DryRun) {
        Write-Host "Would install $asset to $target"
        Write-Host "Would create Start menu shortcut: $shortcutPath"
        if (-not $ExecutablePath) { Write-Host "Would download and verify SHA256SUMS.txt from $releaseUrl" }
        return
    }
    if (-not $ExecutablePath) {
        $temporary = Join-Path ([IO.Path]::GetTempPath()) ('kiln-install-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $temporary | Out-Null
        $source = Join-Path $temporary $asset
        $checksums = Join-Path $temporary 'SHA256SUMS.txt'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Write-Host 'Downloading Kiln...'
        Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/$asset" -OutFile $source
        Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/SHA256SUMS.txt" -OutFile $checksums
        $hashes = @(Get-Content -LiteralPath $checksums | ForEach-Object {
            if ($_ -match '^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -ceq $asset) { $Matches[1] }
        })
        if ($hashes.Count -ne 1 -or (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ine $hashes[0]) {
            throw 'Release checksum verification failed. The existing installation has not been changed.'
        }
        Write-Host 'Release checksum verified.'
    }
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    # Stage beside the destination so a failed copy leaves the installed executable intact.
    $pending = Join-Path $installDir ('Kiln-' + [guid]::NewGuid().ToString('N') + '.tmp')
    Copy-Item -LiteralPath $source -Destination $pending
    if (Test-Path -LiteralPath $target) {
        $item = Get-Item -LiteralPath $target -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Unsafe executable destination: $target" }
        [IO.File]::Replace($pending, $target, $null)
    } else {
        [IO.File]::Move($pending, $target)
    }
    $pending = $null
    Set-Content -LiteralPath $marker -Value 'kiln-installer-v1' -Encoding ASCII
    New-Item -ItemType Directory -Path $programs -Force | Out-Null
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $target
    $shortcut.WorkingDirectory = $installDir
    $shortcut.IconLocation = "$target,0"
    $shortcut.Description = 'Kiln'
    $shortcut.Save()
    Write-Host 'Kiln is installed. Open Kiln from the Start menu.'
} catch {
    Write-Error $_
    exit 1
} finally {
    if ($pending -and (Test-Path -LiteralPath $pending)) { Remove-Item -LiteralPath $pending -Force }
    if ($temporary -and (Test-Path -LiteralPath $temporary)) {
        # Only remove the exact temporary directory created by this invocation.
        $resolvedTemporary = (Get-Item -LiteralPath $temporary -Force).FullName
        $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
        if ([IO.Path]::GetDirectoryName($resolvedTemporary) -ine $temporaryRoot -or
            [IO.Path]::GetFileName($resolvedTemporary) -notmatch '^kiln-install-[a-f0-9]{32}$') {
            throw "Refusing to remove an unexpected temporary path: $resolvedTemporary"
        }
        Remove-Item -LiteralPath $temporary -Recurse -Force
    }
}
