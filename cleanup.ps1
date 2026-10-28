#Requires -Version 5.1
<#
.SYNOPSIS
    Removes build artifacts from the Date Highlighter repository.

.DESCRIPTION
    Deletes only the artifact folders this repository produces:

    - dist\              store packages and bundles written by pack.ps1
    - web-ext-artifacts\ output from "npx web-ext build"

    Cleanup is allowlist-driven: only those names are considered, node_modules
    and every source file are left alone, and anything else found in the root is
    reported as skipped. The repository root must contain .git or manifest.json
    before anything is removed, so running this script from the wrong folder
    cannot delete unrelated data.

.PARAMETER Path
    Repository root. Defaults to the folder containing this script.

.EXAMPLE
    .\cleanup.ps1
    Removes dist\ and web-ext-artifacts\ if they exist.

.EXAMPLE
    .\cleanup.ps1 -WhatIf
    Reports what would be removed without deleting anything.
#>
[System.Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Status output is colour-coded for interactive use.')]
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter()]
    [string]$Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Allowlist of artifact folders this repository produces. Never widen this to
# pattern scavenging: cleanup scripts delete the wrong thing when they guess.
$artifactDirs = @('dist', 'web-ext-artifacts')
$protectedItems = @('manifest.json', 'content', 'popup', 'options', 'tests', 'install.ps1', 'pack.ps1', 'cleanup.ps1')

# This script sits at the repository root, so $PSScriptRoot is the repository.
$root = if ($Path) { [System.IO.Path]::GetFullPath($Path) } else { $PSScriptRoot }

if (-not (Test-Path -LiteralPath $root)) {
    throw "Repository root not found: $root"
}

# Marker guard: refuse to delete anything outside a Date Highlighter checkout.
$markers = @('.git', 'manifest.json')
$foundMarker = $false
foreach ($marker in $markers) {
    if (Test-Path -LiteralPath (Join-Path $root $marker)) { $foundMarker = $true }
}
if (-not $foundMarker) {
    throw "Refusing to clean $root : neither .git nor manifest.json is present, so this does not look like the repository."
}

$removed = @()
$skipped = @()

foreach ($name in $artifactDirs) {
    $target = Join-Path $root $name
    if ($protectedItems -contains $name) {
        throw "Refusing to remove '$name': it is part of the payload."
    }
    if (-not (Test-Path -LiteralPath $target)) {
        $skipped += $name
        continue
    }

    $files = @(Get-ChildItem -LiteralPath $target -Recurse -File -ErrorAction SilentlyContinue)
    $sizeKb = ($files | Measure-Object -Property Length -Sum).Sum / 1KB
    if ($null -eq $sizeKb) { $sizeKb = 0 }

    if (-not $PSCmdlet.ShouldProcess($target, "remove artifact folder '$name'")) {
        continue
    }

    Remove-Item -LiteralPath $target -Recurse -Force
    $removed += [pscustomobject]@{
        Name = $name
        Files = $files.Count
        SizeKb = $sizeKb
    }
    Write-Host ("Removed {0} ({1} files, {2:N1} KB)" -f $name, $files.Count, $sizeKb) -ForegroundColor Green
}

foreach ($name in $skipped) {
    Write-Verbose "Skipped '$name': not present."
}

if ($removed.Count -eq 0) {
    if ($skipped.Count -eq $artifactDirs.Count) {
        Write-Host 'Nothing to clean: no build artifacts found.' -ForegroundColor Yellow
    }
    return
}

$totalFiles = ($removed | Measure-Object -Property Files -Sum).Sum
$totalKb = ($removed | Measure-Object -Property SizeKb -Sum).Sum
Write-Host ("Cleaned {0} artifact folder(s): {1} files, {2:N1} KB freed." -f $removed.Count, $totalFiles, $totalKb) -ForegroundColor Cyan
Write-Host 'Source files, tests, node_modules, and an installed copy of the extension were not touched.'
