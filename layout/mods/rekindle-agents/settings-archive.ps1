param(
    [Parameter(Mandatory)][ValidateSet('Export', 'Inspect', 'Restore')][string]$Operation,
    [Parameter(Mandatory)][string]$ArchivePath,
    [Parameter(Mandatory)][string]$AppDirectory,
    [Parameter(Mandatory)][ValidateSet('rekindle', 'taller')][string]$Theme,
    [string]$ManifestPath,
    [string]$Fingerprint
)

$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = $utf8
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$logoDirectory = "data/$Theme/logos"
$managedLogo = '^' + [regex]::Escape($logoDirectory) + '/[a-z0-9-]+\.(png|jpg|webp|svg)$'
$archiveLogo = '^logos/[a-z0-9-]+\.(png|jpg|webp|svg)$'
$archivePath = [IO.Path]::GetFullPath($ArchivePath)
$maxArchiveBytes = 256MB

function Read-Entry($Entry, [int]$Limit) {
    if (!$Entry -or $Entry.Length -gt $Limit) { throw 'The archive entry is missing or too large.' }
    $bytes = [byte[]]::new([int]$Entry.Length)
    $stream = $Entry.Open()
    try {
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if (!$read) { throw 'The archive entry ended early.' }
            $offset += $read
        }
        if ($stream.ReadByte() -ne -1) { throw 'The archive entry is larger than declared.' }
    } finally {
        $stream.Dispose()
    }
    return ,$bytes
}

function Test-Image([string]$Extension, [byte[]]$Bytes) {
    switch ($Extension) {
        'png' { return $Bytes.Length -ge 8 -and [BitConverter]::ToString($Bytes, 0, 8) -ceq '89-50-4E-47-0D-0A-1A-0A' }
        'jpg' { return $Bytes.Length -ge 3 -and [BitConverter]::ToString($Bytes, 0, 3) -ceq 'FF-D8-FF' }
        'webp' {
            return $Bytes.Length -ge 12 -and [Text.Encoding]::ASCII.GetString($Bytes, 0, 4) -ceq 'RIFF' -and
                [Text.Encoding]::ASCII.GetString($Bytes, 8, 4) -ceq 'WEBP'
        }
        'svg' { return $utf8.GetString($Bytes) -match '^[\s\uFEFF]*(?:(?:<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)*<svg[\s>]' }
    }
    return $false
}

function Save-Logo([string]$Name, [byte[]]$Bytes) {
    $extension = [IO.Path]::GetExtension($Name).Substring(1)
    if (!(Test-Image $extension $Bytes)) { throw "Invalid project image: $Name" }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-', '')
    } finally {
        $sha.Dispose()
    }
    $relative = $logoDirectory + '/import-' + $hash.ToLowerInvariant() + '.' + $extension
    $target = Join-Path $AppDirectory $relative
    if (![IO.File]::Exists($target)) {
        $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
        $temporary = $target + '-' + [guid]::NewGuid().ToString('N') + '.tmp'
        try {
            [IO.File]::WriteAllBytes($temporary, $Bytes)
            try { [IO.File]::Move($temporary, $target) } catch [IO.IOException] {
                if (![IO.File]::Exists($target)) { throw }
            }
        } finally {
            [IO.File]::Delete($temporary)
        }
    }
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -cne $hash) { throw 'A stored project image is damaged.' }
    $relative
}

if ($Operation -eq 'Export') {
    if ([IO.Path]::GetExtension($archivePath) -ine '.zip') { throw 'Choose a .zip file for the backup.' }
    $manifest = [IO.File]::ReadAllText($ManifestPath, $utf8) | ConvertFrom-Json
    $assets = @{}
    $total = 0L
    foreach ($project in $manifest.projects) {
        if (!$project.logo) { continue }
        if ($project.logo -cnotmatch $managedLogo) { throw 'An installed project image has an unexpected path.' }
        $name = 'logos/' + [IO.Path]::GetFileName($project.logo)
        if (!$assets.ContainsKey($name)) {
            $file = Get-Item -LiteralPath (Join-Path $AppDirectory $project.logo)
            if ($file.Length -gt 8MB) { throw 'A project image is larger than 8 MB.' }
            $total += $file.Length
            if ($total -gt $maxArchiveBytes) { throw 'The project images exceed 256 MB in total.' }
            $assets[$name] = $file.FullName
        }
        $project.logo = $name
    }
    $document = $utf8.GetBytes((ConvertTo-Json -InputObject $manifest -Depth 12 -Compress))
    if ($document.Length -gt 1MB) { throw 'The settings manifest exceeds 1 MB.' }
    $original = Get-Item -LiteralPath $archivePath -ErrorAction SilentlyContinue
    if ($original) {
        $originalLength = $original.Length
        $originalWriteTime = $original.LastWriteTimeUtc
    }
    $temporary = Join-Path ([IO.Path]::GetDirectoryName($archivePath)) ('.rekindle-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $file = [IO.File]::Open($temporary, 'CreateNew')
        try {
            $archive = [IO.Compression.ZipArchive]::new($file, 'Create', $true)
            try {
                $entry = $archive.CreateEntry('settings.json').Open()
                try { $entry.Write($document, 0, $document.Length) } finally { $entry.Dispose() }
                foreach ($name in $assets.Keys) {
                    $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $assets[$name], $name)
                }
            } finally { $archive.Dispose() }
        } finally { $file.Dispose() }
        if ((Get-Item -LiteralPath $temporary).Length -gt $maxArchiveBytes) { throw 'The backup exceeds 256 MB.' }
        if ($original) {
            $current = Get-Item -LiteralPath $archivePath
            if ($current.Length -ne $originalLength -or $current.LastWriteTimeUtc -ne $originalWriteTime) {
                throw 'The destination file changed while the backup was being created.'
            }
            [IO.File]::Replace($temporary, $archivePath, [NullString]::Value)
        } else {
            [IO.File]::Move($temporary, $archivePath)
        }
    } finally {
        [IO.File]::Delete($temporary)
    }
    return
}

$file = [IO.File]::Open($archivePath, 'Open', 'Read', 'Read')
try {
    if ($file.Length -gt $maxArchiveBytes) { throw 'The backup exceeds 256 MB.' }
    $hash = (Get-FileHash -InputStream $file -Algorithm SHA256).Hash
    if ($Operation -eq 'Restore' -and $hash -cne $Fingerprint) { throw 'The backup changed after it was reviewed.' }
    $file.Position = 0
    $archive = [IO.Compression.ZipArchive]::new($file, 'Read', $true)
    try {
        $manifest = $utf8.GetString((Read-Entry ($archive.GetEntry('settings.json')) 1MB)) | ConvertFrom-Json
        if ($manifest.format -cne 'rekindle-settings' -or $manifest.version -ne 1) { throw 'Unsupported settings backup.' }
        $assets = @{}
        $total = 0L
        foreach ($project in $manifest.projects) {
            $name = $project.logo
            if (!$name) { continue }
            if ($name -isnot [string] -or $name -cnotmatch $archiveLogo) { throw 'The backup contains an invalid project image path.' }
            if ($assets.ContainsKey($name)) { continue }
            $entry = $archive.GetEntry($name)
            if (!$entry -or $entry.Length -gt 8MB) { throw "A project image is missing or larger than 8 MB: $name" }
            $total += $entry.Length
            if ($total -gt $maxArchiveBytes) { throw 'The project images exceed 256 MB in total.' }
            $assets[$name] = $entry
        }
        if ($Operation -eq 'Inspect') {
            ConvertTo-Json -InputObject @{ fingerprint = $hash; manifest = $manifest } -Depth 12 -Compress
            return
        }
        $restored = @{}
        foreach ($name in $assets.Keys) {
            $restored[$name] = Save-Logo $name (Read-Entry $assets[$name] 8MB)
        }
        ConvertTo-Json -InputObject $restored -Compress
    } finally { $archive.Dispose() }
} finally { $file.Dispose() }
