#Requires -Version 5.1
<#
.SYNOPSIS
    Renders icons/icon.svg to the PNG sizes the browsers and stores need.

.DESCRIPTION
    Chrome and Edge cannot load SVG icons from a manifest, so the shared
    manifest points at PNGs. This script draws the SVG in a headless Chromium
    browser (Chrome or Edge) at each requested size, which rasterizes gradients
    and filters exactly as a browser does, and keeps the transparent corners by
    rendering on a transparent page background.

    Each PNG is verified after rendering: the IHDR dimensions must equal the
    requested size, so a silently mis-sized icon cannot reach the manifest.

.PARAMETER Chrome
    Path to chrome.exe or msedge.exe. Defaults to the usual install locations.

.PARAMETER Sizes
    Icon sizes in pixels. Defaults to 16, 32, 48, 128 (what the manifest and
    the stores use).

.PARAMETER SourceSvg
    SVG to render. Defaults to icons/icon.svg next to this script.

.PARAMETER OutputDir
    Folder for the rendered PNGs. Defaults to the folder holding the SVG.

.EXAMPLE
    .\render-icons.ps1
    Renders icon-16.png, icon-32.png, icon-48.png, and icon-128.png into icons\.

.EXAMPLE
    .\render-icons.ps1 -Sizes 16, 32, 48, 128, 256
    Also renders a 256 px icon for a store listing.

.EXAMPLE
    .\render-icons.ps1 -WhatIf
    Reports the files that would be written without rendering anything.
#>
[System.Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Status output is colour-coded for interactive use.')]
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter()]
    [string]$Chrome,

    [Parameter()]
    [int[]]$Sizes = @(16, 32, 48, 128),

    [Parameter()]
    [string]$SourceSvg,

    [Parameter()]
    [string]$OutputDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# This script sits at the repository root, so $PSScriptRoot is the source tree.
$sourceRoot = $PSScriptRoot

if (-not $SourceSvg) {
    $SourceSvg = Join-Path $sourceRoot 'icons\icon.svg'
}
if (-not $OutputDir) {
    $OutputDir = Split-Path -Parent $SourceSvg
}

if (-not (Test-Path -LiteralPath $SourceSvg)) {
    throw "Source SVG not found: $SourceSvg"
}

function Resolve-ChromiumBinary {
    <#
    .SYNOPSIS
        Finds chrome.exe or msedge.exe in the usual install locations.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param()

    $candidates = @(
        (Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    throw 'No Chrome or Edge binary found; pass -Chrome with the full path.'
}

function Get-PngSize {
    <#
    .SYNOPSIS
        Reads width and height from a PNG's IHDR chunk without extra modules.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 24) { throw "Not a PNG: $Path" }
    $width = [int]$bytes[16] * 16777216 + [int]$bytes[17] * 65536 + [int]$bytes[18] * 256 + [int]$bytes[19]
    $height = [int]$bytes[20] * 16777216 + [int]$bytes[21] * 65536 + [int]$bytes[22] * 256 + [int]$bytes[23]
    return @{ Width = $width; Height = $height }
}

if (-not $Chrome) {
    $Chrome = Resolve-ChromiumBinary
}
if (-not (Test-Path -LiteralPath $Chrome)) {
    throw "Chromium binary not found: $Chrome"
}

$svg = [System.IO.File]::ReadAllText($SourceSvg)
$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('Date-Highlighter-icons-' + [System.IO.Path]::GetRandomFileName())
# Internal scaffolding, not a user-visible mutation: a dry run must still stage
# and clean up so it reports the same work without leaking temp folders.
New-Item -ItemType Directory -Path $stagingRoot -Force -WhatIf:$false -Confirm:$false | Out-Null
$rendered = @()

try {
    foreach ($size in $Sizes) {
        $pngPath = Join-Path $OutputDir "icon-$size.png"
        if (-not $PSCmdlet.ShouldProcess($pngPath, "render the ${size}px icon")) { continue }

        # The output folder may not exist yet; Chrome cannot write a screenshot
        # into a missing directory.
        New-Item -ItemType Directory -Path $OutputDir -Force -WhatIf:$false -Confirm:$false | Out-Null

        # The page is exactly one icon wide with no margins, so the screenshot
        # is the icon: 1:1 pixels, transparent background, no scrollbars.
        $html = @"
<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}
svg{display:block;width:${size}px;height:${size}px}
</style></head><body>
$svg
</body></html>
"@
        $htmlPath = Join-Path $stagingRoot "icon-$size.html"
        [System.IO.File]::WriteAllText($htmlPath, $html, (New-Object System.Text.UTF8Encoding $false))

        if (Test-Path -LiteralPath $pngPath) { Remove-Item -LiteralPath $pngPath -Force -WhatIf:$false -Confirm:$false }
        $profileDir = Join-Path $stagingRoot "profile-$size"
        $browserArgs = @(
            '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
            '--force-device-scale-factor=1', '--default-background-color=00000000',
            "--user-data-dir=$profileDir", "--window-size=$size,$size",
            "--screenshot=$pngPath", "file:///$($htmlPath -replace '\\', '/')"
        )
        $process = Start-Process -FilePath $Chrome -ArgumentList $browserArgs -PassThru -WindowStyle Hidden
        $process | Wait-Process -Timeout 120 -ErrorAction SilentlyContinue

        if (-not (Test-Path -LiteralPath $pngPath)) {
            throw "No PNG was produced for ${size}px; check that $Chrome can run headless and that $OutputDir is writable."
        }
        $dimensions = Get-PngSize -Path $pngPath
        if ($dimensions.Width -ne $size -or $dimensions.Height -ne $size) {
            throw "Rendered $pngPath as $($dimensions.Width)x$($dimensions.Height); expected ${size}x${size}."
        }
        $rendered += [pscustomobject]@{ Path = $pngPath; Size = $size; Bytes = (Get-Item -LiteralPath $pngPath).Length }
    }
}
finally {
    if (Test-Path -LiteralPath $stagingRoot) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force -WhatIf:$false -Confirm:$false -ErrorAction SilentlyContinue
    }
}

if ($rendered.Count -eq 0) {
    return
}

Write-Host ("Rendered {0} icon(s) from {1} with {2}" -f $rendered.Count, $SourceSvg, (Split-Path -Leaf $Chrome)) -ForegroundColor Green
foreach ($icon in $rendered) {
    Write-Host ('  {0} ({1} bytes)' -f $icon.Path, $icon.Bytes)
}
