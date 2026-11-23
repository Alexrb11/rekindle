# SPDX-License-Identifier: MIT

function Read-LayoutFile([string]$RelativePath, [switch]$Text) {
    $path = Join-Path $HerdrAppDirectory $RelativePath
    $root = [IO.Path]::GetFullPath($HerdrAppDirectory).TrimEnd([char[]]@('\', '/'))
    $parent = [IO.Path]::GetDirectoryName($path)
    while ($parent -and $parent.TrimEnd([char[]]@('\', '/')) -ne $root) {
        $entry = Get-Item -LiteralPath $parent -Force -ErrorAction SilentlyContinue
        if ($entry -and (!$entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint))) {
            throw "Expected a regular directory at $parent."
        }
        $parent = [IO.Path]::GetDirectoryName($parent)
    }
    if (!$parent) { throw "Invalid layout path $path." }
    Read-EditableFile $path -Binary:(!$Text)
}

function Get-LayoutHash([byte[]]$Bytes) {
    if ($null -eq $Bytes) { return }
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        [BitConverter]::ToString($sha256.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
}

function Add-LayoutEdits([string]$Package) {
    $payload = [ordered]@{
        'layouts/rekindle.json' = Join-Path $Package 'layouts/rekindle.json'
        'layouts/rekindle.png' = Join-Path $Package 'preview.png'
        'themes/rekindle.json' = Join-Path $Package 'themes/rekindle.json'
    }
    foreach ($name in @('rekindle-agents', 'rekindle-deliveries', 'rekindle-sidebar', 'rekindle-status', 'rekindle-tabs')) {
        $folder = Get-Item -LiteralPath (Join-Path $Package "mods/$name")
        $files = Get-ChildItem -LiteralPath $folder.FullName -File -Recurse | Sort-Object FullName
        foreach ($file in $files) {
            if ($file.Extension -notin @('.js', '.json', '.ps1', '.png', '.gif', '.svg') -or $file.Name -eq 'jsconfig.json') {
                continue
            }
            $part = $file.FullName.Substring($folder.FullName.Length + 1).Replace('\', '/')
            $payload["mods/$name/$part"] = $file.FullName
        }
    }

    $manifest = Read-LayoutFile 'data/rekindle-layout-files.json' -Text
    $record = $null
    if ($null -ne $manifest.Bytes) {
        $record = ConvertFrom-Json -InputObject $manifest.Text
        if ($record.package -ne 'Rekindle layout' -or $record.files -isnot [pscustomobject]) {
            throw "The layout file record at $($manifest.Path) is invalid."
        }
    }

    $updated = [ordered]@{}
    foreach ($relative in $payload.Keys) {
        $target = Read-LayoutFile $relative
        $installed = Get-LayoutHash $target.Bytes
        $owned = if ($record) { $record.files.PSObject.Properties[$relative].Value }
        if ($Uninstall) {
            if ($installed -and $owned -and $installed -eq $owned) {
                Add-FileEdit $target $null
            } elseif ($installed -and $owned) {
                $updated[$relative] = $owned
                Write-Warning "Keeping the edited layout file $($target.Path)."
            }
            continue
        }

        $bytes = [IO.File]::ReadAllBytes($payload[$relative])
        $hash = Get-LayoutHash $bytes
        if ($installed -and $installed -ne $owned -and $installed -ne $hash) {
            throw "The layout file at $($target.Path) already exists or has local edits."
        }
        Add-FileEdit $target $bytes
        $updated[$relative] = $hash
    }

    if ($updated.Count) {
        $json = @{ package = 'Rekindle layout'; files = $updated } | ConvertTo-Json -Compress -Depth 4
        Add-FileEdit $manifest ($utf8.GetBytes($json + "`n"))
    } else {
        Add-FileEdit $manifest $null
    }
}
