#Requires -Version 5.1
<#
.SYNOPSIS
    Builds the Date Highlighter store package and distribution bundle.

.DESCRIPTION
    Stages the extension payload (manifest.json, content, popup, options) and
    writes two versioned archives into dist\:

    - Date-Highlighter-<version>.zip is the store package. manifest.json sits at
      the archive root, which is what the Chrome Web Store, Edge Add-ons, and
      addons.mozilla.org expect from an upload. One archive serves all three
      stores: browser_specific_settings is ignored by Chromium browsers.

    - Date-Highlighter-<version>-bundle.zip holds the same payload plus
      install.ps1 inside a single Date-Highlighter\ folder, mirroring the
      installed layout. Extract it into the install location directly, or
      extract it anywhere and run the bundled install.ps1.

    The version comes from manifest.json. Nothing outside the payload list is
    packaged, so tests, node_modules, and the packaging scripts stay out of the
    archives.

.PARAMETER OutputPath
    Directory that receives the archives. Defaults to dist\ next to this script.

.EXAMPLE
    .\pack.ps1
    Builds both archives into dist\.

.EXAMPLE
    .\pack.ps1 -OutputPath D:\Builds
    Builds both archives into D:\Builds.

.EXAMPLE
    .\pack.ps1 -WhatIf
    Reports the archives that would be written without creating them.
#>
[System.Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Status output is colour-coded for interactive use.')]
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter()]
    [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Payload and exclusions are duplicated across install.ps1, pack.ps1, and
# cleanup.ps1 by design: each script stays standalone and dot-source-free.
$payloadItems = @('manifest.json', 'content', 'popup', 'options')
$excludedDirs = @('.git', 'node_modules', 'tests', 'dist', 'web-ext-artifacts')
$installerItem = 'install.ps1'
$archiveName = 'Date-Highlighter'

# This script sits at the repository root, so $PSScriptRoot is the source tree.
$sourceRoot = $PSScriptRoot

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

function Copy-PayloadInto {
    <#
    .SYNOPSIS
        Copies every payload item into a staging directory.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Destination
    )

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($item in $payloadItems) {
        $source = Join-Path $sourceRoot $item
        $target = Join-Path $Destination $item
        if ((Get-Item -LiteralPath $source).PSIsContainer) {
            Copy-DirectoryTree -Source $source -Destination $target -ExcludeDirNames $excludedDirs
        }
        else {
            Copy-Item -LiteralPath $source -Destination $target -Force
        }
    }
}

# Validate the payload and the version source before staging anything.
$requiredItems = @($payloadItems + $installerItem)
$missing = @(foreach ($item in $requiredItems) {
        if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $item))) { $item }
    })
if ($missing.Count -gt 0) {
    throw "Missing items in ${sourceRoot}: $($missing -join ', ')"
}

$manifestPath = Join-Path $sourceRoot 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$version = $null
if ($manifest.PSObject.Properties['version']) {
    $version = [string]$manifest.version
}
if (-not $version) {
    throw "Could not read a version from $manifestPath"
}

if ($OutputPath) {
    $outputDir = [System.IO.Path]::GetFullPath($OutputPath)
}
else {
    $outputDir = Join-Path $sourceRoot 'dist'
}
$storeArchive = Join-Path $outputDir "$archiveName-$version.zip"
$bundleArchive = Join-Path $outputDir "$archiveName-$version-bundle.zip"

$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("$archiveName-pack-" + [System.IO.Path]::GetRandomFileName())
$results = @()

try {
    if ($PSCmdlet.ShouldProcess($storeArchive, 'create the store package')) {
        $stage = Join-Path $stagingRoot 'store'
        Copy-PayloadInto -Destination $stage
        New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
        $staged = @(Get-ChildItem -LiteralPath $stage -Recurse -File)
        # Pass the top-level entries, not the recursive file list: explicit file
        # paths are archived by name only, which would flatten the tree.
        $entries = @(Get-ChildItem -LiteralPath $stage -Force | Select-Object -ExpandProperty FullName)
        Compress-Archive -Path $entries -DestinationPath $storeArchive -Force
        $results += [pscustomobject]@{
            Kind = 'Store package'
            Path = $storeArchive
            Files = $staged.Count
        }
    }

    if ($PSCmdlet.ShouldProcess($bundleArchive, 'create the distribution bundle')) {
        $stage = Join-Path $stagingRoot 'bundle'
        $wrapper = Join-Path $stage $archiveName
        Copy-PayloadInto -Destination $wrapper
        Copy-Item -LiteralPath (Join-Path $sourceRoot $installerItem) -Destination (Join-Path $wrapper $installerItem) -Force
        New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
        $staged = @(Get-ChildItem -LiteralPath $wrapper -Recurse -File)
        Compress-Archive -Path $wrapper -DestinationPath $bundleArchive -Force
        $results += [pscustomobject]@{
            Kind = 'Bundle'
            Path = $bundleArchive
            Files = $staged.Count
        }
    }
}
finally {
    if (Test-Path -LiteralPath $stagingRoot) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($results.Count -eq 0) {
    return
}

Write-Host ("Packaged $archiveName $version") -ForegroundColor Green
foreach ($result in $results) {
    $sizeKb = (Get-Item -LiteralPath $result.Path).Length / 1KB
    Write-Host ('  {0,-14} {1} ({2} files, {3:N1} KB)' -f $result.Kind, $result.Path, $result.Files, $sizeKb)
}
Write-Host 'Store package: upload it to the Chrome Web Store, Edge Add-ons, or addons.mozilla.org.' -ForegroundColor Cyan
Write-Host "Bundle: extract Date-Highlighter\ into the install location, or extract it anywhere and run install.ps1."
