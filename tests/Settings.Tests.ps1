# SPDX-License-Identifier: MIT
#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$tool = Join-Path $repo 'layout/mods/rekindle-agents/settings-archive.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('rekindle-settings-test-' + [guid]::NewGuid().ToString('N'))

function Assert-True([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
}

try {
    $source = Join-Path $testRoot 'source app'
    $destination = Join-Path $testRoot 'destination app'
    $relative = 'data/rekindle/logos/project.png'
    $logo = Join-Path $source $relative
    $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($logo))
    $null = [IO.Directory]::CreateDirectory($destination)
    Copy-Item -LiteralPath (Join-Path $repo 'layout/mods/rekindle-sidebar/art/project.png') -Destination $logo
    $backup = Join-Path $testRoot "Rekindle's settings.zip"
    $manifestPath = Join-Path $testRoot 'manifest.json'
    $manifest = @{
        format = 'rekindle-settings'
        version = 1
        agentTypes = @(@{ name = 'Review'; skills = @('review'); sprite = 'menta' })
        preferences = @{ language = 'en'; quotaThreshold = 17; panels = @('changes') }
        projects = @(@{
            id = 'first-project'; name = 'Studio'; folder = 'C:\source\studio'
            machine = $null; logo = $relative; sprite = 'celeste'
        })
    }
    [IO.File]::WriteAllText($manifestPath, (ConvertTo-Json -InputObject $manifest -Depth 8 -Compress))
    & $tool -Operation Export -ArchivePath $backup -AppDirectory $source -Theme rekindle -ManifestPath $manifestPath
    $inspect = & $tool -Operation Inspect -ArchivePath $backup -AppDirectory $destination -Theme taller | ConvertFrom-Json
    Assert-True ($inspect.manifest.agentTypes[0].name -eq 'Review') 'The agent type did not round-trip.'
    Assert-True ($inspect.manifest.preferences.quotaThreshold -eq 17) 'The quota preference did not round-trip.'
    Assert-True ($null -eq $inspect.manifest.preferences.options) 'An older backup should keep its original preferences.'
    Assert-True ($inspect.manifest.projects[0].logo -eq 'logos/project.png') 'The logo was not included as a portable entry.'
    Assert-True (!(Test-Path -LiteralPath (Join-Path $destination 'data'))) 'Inspect changed the destination before confirmation.'
    $restored = & $tool -Operation Restore -ArchivePath $backup -AppDirectory $destination -Theme taller -Fingerprint $inspect.fingerprint | ConvertFrom-Json
    Assert-True ($restored.'logos/project.png' -match '^data/taller/logos/import-[0-9a-f]{64}\.png$') 'The logo was not stored in the destination theme.'
    $savedLogo = Join-Path $destination $restored.'logos/project.png'
    Assert-True ((Get-FileHash -LiteralPath $logo).Hash -ceq (Get-FileHash -LiteralPath $savedLogo).Hash) 'The image changed on import.'
    $again = & $tool -Operation Restore -ArchivePath $backup -AppDirectory $destination -Theme taller -Fingerprint $inspect.fingerprint | ConvertFrom-Json
    Assert-True ($again.'logos/project.png' -eq $restored.'logos/project.png') 'Repeating an import duplicated the logo.'

    $manifest.preferences.language = 'es'
    $manifest.preferences.options = @{
        density = 'compact'; showSprites = $false; agentsPerPage = 'all'; quotaRefreshMs = 0
        codexPermissions = 'workspace-write'
    }
    [IO.File]::WriteAllText($manifestPath, (ConvertTo-Json -InputObject $manifest -Depth 8 -Compress))
    & $tool -Operation Export -ArchivePath $backup -AppDirectory $source -Theme rekindle -ManifestPath $manifestPath
    $replacement = & $tool -Operation Inspect -ArchivePath $backup -AppDirectory $destination -Theme taller | ConvertFrom-Json
    Assert-True ($replacement.manifest.preferences.language -eq 'es') 'The confirmed export did not replace the old backup.'
    $options = $replacement.manifest.preferences.options
    Assert-True ($options.density -eq 'compact' -and $options.showSprites -eq $false -and
        $options.agentsPerPage -eq 'all' -and $options.quotaRefreshMs -eq 0) 'The new preferences did not round-trip.'
    Assert-True ($options.codexPermissions -eq 'workspace-write') 'The Codex permissions did not round-trip.'
    $refused = $false
    try { & $tool -Operation Restore -ArchivePath $backup -AppDirectory $destination -Theme taller -Fingerprint $inspect.fingerprint | Out-Null }
    catch { $refused = $_.Exception.Message -like '*changed after it was reviewed*' }
    Assert-True $refused 'Restore accepted a backup that changed after review.'

    $invalidPath = Join-Path $testRoot 'invalid.zip'
    $manifest.projects[0].logo = 'logos/../settings.json'
    $archive = [IO.Compression.ZipFile]::Open($invalidPath, 'Create')
    try {
        $stream = $archive.CreateEntry('settings.json').Open()
        $writer = [IO.StreamWriter]::new($stream)
        try { $writer.Write((ConvertTo-Json -InputObject $manifest -Depth 8 -Compress)) } finally { $writer.Dispose() }
    } finally { $archive.Dispose() }
    $refused = $false
    try { & $tool -Operation Inspect -ArchivePath $invalidPath -AppDirectory $destination -Theme taller | Out-Null }
    catch { $refused = $_.Exception.Message -like '*invalid project image path*' }
    Assert-True $refused 'The importer accepted an invalid image entry path.'
    'Settings backup round-trip, overwrite, file-change detection and image validation passed.'
} finally {
    if (Test-Path -LiteralPath $testRoot) {
        $folder = Get-Item -LiteralPath $testRoot
        $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
        $links = Get-ChildItem -LiteralPath $testRoot -Directory -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }
        if ($folder.FullName -ne $testRoot -or $folder.Parent.FullName -ne $temp -or
            $folder.Name -notmatch '^rekindle-settings-test-[a-f0-9]{32}$' -or $links -or ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Unexpected settings test directory.'
        }
        Remove-Item -LiteralPath $testRoot -Recurse
    }
}
