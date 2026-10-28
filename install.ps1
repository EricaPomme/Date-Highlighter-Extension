#Requires -Version 5.1
<#
.SYNOPSIS
    Installs Date Highlighter as an unpacked browser extension.

.DESCRIPTION
    Copies the extension payload (manifest.json, content, popup, options, icons)
    into a destination folder so a browser can load it from a stable path. The
    install is a clean replace: an existing destination folder is removed first,
    so no file from an earlier install can survive an upgrade.

    The destination defaults to a per-user folder under LOCALAPPDATA. Pass
    -Destination to install somewhere else; a relative path resolves against the
    current directory. Writability is verified with a real create/delete probe
    before anything is removed.

.PARAMETER Destination
    Folder that receives the extension payload. Defaults to
    "$env:LOCALAPPDATA\Date-Highlighter\extension".

.EXAMPLE
    .\install.ps1
    Installs the extension into the default per-user folder.

.EXAMPLE
    .\install.ps1 -Destination D:\Extensions\Date-Highlighter
    Installs the extension into a custom folder.

.EXAMPLE
    .\install.ps1 -WhatIf
    Reports the folder that would be replaced and copied, without touching the
    filesystem.
#>
[System.Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Status output is colour-coded for interactive use.')]
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter()]
    [string]$Destination
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Payload and exclusions are duplicated across install.ps1, pack.ps1, and
# cleanup.ps1 by design: each script stays standalone and dot-source-free.
$payloadItems = @('manifest.json', 'content', 'popup', 'options', 'icons')
$excludedDirs = @('.git', 'node_modules', 'tests', 'dist', 'web-ext-artifacts')
$extensionName = 'Date Highlighter'

# This script sits at the repository root, so $PSScriptRoot is the source tree.
$sourceRoot = $PSScriptRoot

function Test-PathWritable {
    <#
    .SYNOPSIS
        Verifies writability by creating and deleting a probe file.
    .DESCRIPTION
        An actual create/delete is the ground truth; ACL inspection is not. The
        probe cmdlets pass -WhatIf:$false -Confirm:$false so a dry run still
        probes genuinely and silently.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $probe = Join-Path $Path ([System.IO.Path]::GetRandomFileName())
    try {
        New-Item -ItemType File -Path $probe -WhatIf:$false -Confirm:$false -ErrorAction Stop | Out-Null
        return $true
    }
    catch {
        return $false
    }
    finally {
        if (Test-Path -LiteralPath $probe) {
            Remove-Item -LiteralPath $probe -Force -WhatIf:$false -Confirm:$false -ErrorAction SilentlyContinue
        }
    }
}

function Copy-DirectoryTree {
    <#
    .SYNOPSIS
        Copies a directory tree, pruning excluded directory names during the walk.
    .DESCRIPTION
        Copy-Item -Exclude does not reliably prune recursion, so the walk is done
        here and excluded names are skipped whole.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Source,

        [Parameter(Mandatory)]
        [string]$Destination,

        [Parameter()]
        [string[]]$ExcludeDirNames = @()
    )

    if (-not (Test-Path -LiteralPath $Destination)) {
        New-Item -ItemType Directory -Path $Destination -Force -WhatIf:$false -Confirm:$false | Out-Null
    }
    foreach ($entry in Get-ChildItem -LiteralPath $Source -Force) {
        if ($entry.PSIsContainer) {
            if ($ExcludeDirNames -contains $entry.Name) { continue }
            Copy-DirectoryTree -Source $entry.FullName -Destination (Join-Path $Destination $entry.Name) -ExcludeDirNames $ExcludeDirNames
        }
        else {
            Copy-Item -LiteralPath $entry.FullName -Destination (Join-Path $Destination $entry.Name) -Force
        }
    }
}

# Validate the payload before touching any destination.
$missing = @(foreach ($item in $payloadItems) {
        if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $item))) { $item }
    })
if ($missing.Count -gt 0) {
    throw "Missing payload items in ${sourceRoot}: $($missing -join ', ')"
}

if ($Destination) {
    $target = [System.IO.Path]::GetFullPath($Destination)
}
else {
    if (-not $env:LOCALAPPDATA) {
        throw 'LOCALAPPDATA is not set; pass -Destination to choose an install folder.'
    }
    $target = Join-Path $env:LOCALAPPDATA 'Date-Highlighter\extension'
}

# Probe the nearest existing ancestor: the folder that has to accept the copy
# or the folder that has to accept the new destination itself.
$probeRoot = $target
while (-not (Test-Path -LiteralPath $probeRoot)) {
    $parent = Split-Path -Parent $probeRoot
    if (-not $parent -or $parent -eq $probeRoot) { break }
    $probeRoot = $parent
}

if (-not (Test-Path -LiteralPath $probeRoot) -or -not (Test-PathWritable -Path $probeRoot)) {
    throw @"
Cannot install ${extensionName}: no writable location found.

Destination:  $target
Checked:      $probeRoot
Payload:      $($payloadItems -join ', ')

Create a writable destination yourself, then re-run this script:
    New-Item -ItemType Directory -Path '$target' -Force
Locations under Program Files or another system-wide root may require an
elevated (Administrator) session.
"@
}

$exists = Test-Path -LiteralPath $target
$action = if ($exists) { "replace the existing install and copy the payload to '$target'" }
else { "copy the payload to '$target'" }

if (-not $PSCmdlet.ShouldProcess($target, $action)) {
    return
}

if ($exists) {
    Remove-Item -LiteralPath $target -Recurse -Force
}
New-Item -ItemType Directory -Path $target -Force | Out-Null

foreach ($item in $payloadItems) {
    $source = Join-Path $sourceRoot $item
    $destination = Join-Path $target $item
    if ((Get-Item -LiteralPath $source).PSIsContainer) {
        Copy-DirectoryTree -Source $source -Destination $destination -ExcludeDirNames $excludedDirs
    }
    else {
        Copy-Item -LiteralPath $source -Destination $destination -Force
    }
}

$installed = @(Get-ChildItem -LiteralPath $target -Recurse -File)
$sizeKb = ($installed | Measure-Object -Property Length -Sum).Sum / 1KB
Write-Host ('Installed {0} files ({1:N1} KB) to {2}' -f $installed.Count, $sizeKb, $target) -ForegroundColor Green
Write-Host 'Load it as an unpacked extension:' -ForegroundColor Cyan
Write-Host "  Edge:    edge://extensions -> Developer mode -> Load unpacked -> $target"
Write-Host "  Chrome:  chrome://extensions -> Developer mode -> Load unpacked -> $target"
Write-Host "  Firefox: about:debugging#/runtime/this-firefox -> Load Temporary Add-on -> $(Join-Path $target 'manifest.json')"
