param(
    [Parameter(Mandatory = $true)]
    [string]$ArchivePath,

    [Parameter(Mandatory = $true)]
    [string]$Destination
)

$ErrorActionPreference = 'Stop'
$resolvedDestination = [IO.Path]::GetFullPath($Destination)
$root = [IO.Path]::GetPathRoot($resolvedDestination)

if ($resolvedDestination -eq $root) {
    throw 'Refusing to extract an artifact into a filesystem root.'
}
if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) {
    throw "Verified artifact archive does not exist: $ArchivePath"
}
if (-not (Test-Path -LiteralPath $resolvedDestination -PathType Container)) {
    throw "Artifact destination does not exist: $resolvedDestination"
}
if (@(Get-ChildItem -LiteralPath $resolvedDestination -Force).Count -ne 0) {
    throw "Artifact destination must be empty: $resolvedDestination"
}

Expand-Archive -LiteralPath $ArchivePath -DestinationPath $resolvedDestination -Force
