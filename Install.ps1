# SPDX-License-Identifier: MIT
#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$Uninstall,
    [string]$CodexDirectory,
    [string[]]$ProfilePaths,
    [string]$HerdrAppDirectory,
    [ValidateSet('Chats', 'Layout', 'All')]
    [string]$Component = 'Chats'
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Rekindle requires Windows.' }
$includeChats = $Component -ne 'Layout'
$includeLayout = $Component -ne 'Chats'
if (!$CodexDirectory) {
    $CodexDirectory = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
}
$CodexDirectory = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($CodexDirectory)
if (!$HerdrAppDirectory) {
    $HerdrAppDirectory = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $env:USERPROFILE '.config\herdr-app' }
}
$HerdrAppDirectory = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($HerdrAppDirectory)
if ($includeChats -and !$ProfilePaths) {
    $ProfilePaths = foreach ($shellName in @('powershell.exe', 'pwsh.exe')) {
        $shell = Get-Command $shellName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($shell) { & $shell.Source -NoLogo -NoProfile -NonInteractive -Command '$PROFILE.CurrentUserCurrentHost' }
    }
}
if ($includeChats -and !$ProfilePaths) { throw 'No PowerShell profiles were found. Use -ProfilePaths to specify the profile Herdr loads.' }

$runtimePath = Join-Path $CodexDirectory 'hooks\herdr-codex-session.ps1'
$hooksPath = Join-Path $CodexDirectory 'hooks.json'
$panelDirectory = Join-Path $HerdrAppDirectory 'mods\rekindle'
$panelFiles = @('main.js', 'mod.json')
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$utf8WithBom = [Text.UTF8Encoding]::new($true, $true)
$managedStart = '# >>> herdr-codex-resume >>>'
$managedEnd = '# <<< herdr-codex-resume <<<'
$managedPattern = '(?ms)^' + [regex]::Escape($managedStart) + '\r?\n.*?^' + [regex]::Escape($managedEnd) + '(?:\r?\n|\z)'
$tick = [string][char]96
$hookFileArg = $runtimePath.Replace($tick, $tick + $tick).Replace('$', $tick + '$')
$hookCommand = 'powershell.exe -NoLogo -NoProfile -NonInteractive -File "' + $hookFileArg + '" -Mode Record'
$edits = [Collections.Generic.List[object]]::new()

function Get-FileBytes([string]$Path) {
    if ([IO.File]::Exists($Path)) { return ,([IO.File]::ReadAllBytes($Path)) }
}

function Read-EditableFile([string]$Path, [switch]$Profile, [switch]$Binary) {
    $file = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($file -and ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint))) {
        throw "Expected a regular file at $Path. For a linked PowerShell profile, supply the target with -ProfilePaths."
    }
    $bytes = Get-FileBytes $Path
    if ($Binary) { return [pscustomobject]@{ Path = $Path; Bytes = $bytes } }
    $encoding = if ($Profile) { $utf8WithBom } else { $utf8 }
    $contents = ''
    if ($null -ne $bytes) {
        $reader = [IO.StreamReader]::new([IO.MemoryStream]::new($bytes), $utf8, $true)
        try {
            $contents = $reader.ReadToEnd()
            $encoding = $reader.CurrentEncoding
        } catch [Text.DecoderFallbackException] {
            if (!$Profile) { throw }
            $codePage = [Globalization.CultureInfo]::CurrentCulture.TextInfo.ANSICodePage
            $encoding = [Text.Encoding]::GetEncoding($codePage, [Text.EncoderFallback]::ExceptionFallback, [Text.DecoderFallback]::ExceptionFallback)
            $contents = $encoding.GetString($bytes)
        } finally {
            $reader.Dispose()
        }
    }
    [pscustomobject]@{ Path = $Path; Bytes = $bytes; Text = $contents; Encoding = $encoding }
}

function Test-SameBytes($First, $Second) {
    [Collections.StructuralComparisons]::StructuralEqualityComparer.Equals($First, $Second)
}

function Add-FileEdit($File, [byte[]]$Bytes) {
    if (!(Test-SameBytes $File.Bytes $Bytes)) {
        $edits.Add([pscustomobject]@{ Path = $File.Path; Before = $File.Bytes; After = $Bytes })
    }
}

function Write-FileBytes([string]$Path, [byte[]]$Bytes) {
    if ($null -eq $Bytes) {
        [IO.File]::Delete($Path)
        return
    }
    $parent = [IO.Path]::GetDirectoryName($Path)
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $tempPath = Join-Path $parent ([IO.Path]::GetRandomFileName())
    $stream = [IO.File]::Open($tempPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try {
        try {
            $stream.Write($Bytes, 0, $Bytes.Length)
            $stream.Flush($true)
        } finally {
            $stream.Dispose()
        }
        if ([IO.File]::Exists($Path)) {
            [IO.File]::Replace($tempPath, $Path, [NullString]::Value)
        } else {
            [IO.File]::Move($tempPath, $Path)
        }
    } finally {
        if ([IO.File]::Exists($tempPath)) { [IO.File]::Delete($tempPath) }
    }
}

function Add-HookEdit {
    $file = Read-EditableFile $hooksPath
    if ($null -eq $file.Bytes -and $Uninstall) { return }
    $config = if ($null -ne $file.Bytes) { $file.Text | ConvertFrom-Json } else { [pscustomobject]@{} }
    if ($config -isnot [pscustomobject]) { throw "$hooksPath must contain a JSON object." }
    if (!$config.PSObject.Properties['hooks']) { $config | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{}) }
    if ($config.hooks -isnot [pscustomobject]) { throw 'Expected a hooks object in hooks.json.' }
    $sessionStart = $config.hooks.PSObject.Properties['SessionStart']
    if ($sessionStart -and $sessionStart.Value -isnot [array]) { throw 'Expected a SessionStart array in hooks.json.' }

    $found = $false
    $groups = [Collections.Generic.List[object]]::new()
    foreach ($group in $sessionStart.Value) {
        if ($group.hooks -isnot [array]) { throw 'Expected an array of handlers in each SessionStart group.' }
        $matching = @($group.hooks | Where-Object { $_.type -eq 'command' -and $_.command -ceq $hookCommand })
        if ($matching.Count) {
            $found = $true
            if ($Uninstall) {
                $group.hooks = @($group.hooks | Where-Object { $_.type -ne 'command' -or $_.command -cne $hookCommand })
                if (!$group.hooks.Count) { continue }
            }
        }
        $groups.Add($group)
    }

    if (($Uninstall -and !$found) -or (!$Uninstall -and $found)) { return }
    if (!$Uninstall) {
        $groups.Add([pscustomobject]@{ hooks = @([pscustomobject]@{ type = 'command'; command = $hookCommand; timeout = 10 }) })
    }
    if ($groups.Count) {
        $config.hooks | Add-Member -NotePropertyName SessionStart -NotePropertyValue $groups.ToArray() -Force
    } else {
        $config.hooks.PSObject.Properties.Remove('SessionStart')
    }
    $json = ($config | ConvertTo-Json -Depth 100) + [Environment]::NewLine
    Add-FileEdit $file ($utf8.GetBytes($json))
}

function Add-ProfileEdit([string]$Path) {
    $file = Read-EditableFile $Path -Profile
    $matches = [regex]::Matches($file.Text, $managedPattern)
    if ($matches.Count -gt 1 -or (!$matches.Count -and ($file.Text.Contains($managedStart) -or $file.Text.Contains($managedEnd)))) {
        throw "The managed profile block is incomplete or repeated in $Path."
    }
    if ($Uninstall -and !$matches.Count) { return }
    if ($Uninstall) {
        $updated = $file.Text.Remove($matches[0].Index, $matches[0].Length)
    } else {
        $lf = [string][char]10
        $eol = if ($file.Text.Contains($lf) -and !$file.Text.Contains([Environment]::NewLine)) { $lf } else { [Environment]::NewLine }
        $literalPath = "'" + $runtimePath.Replace("'", "''") + "'"
        $block = @'
# >>> herdr-codex-resume >>>
if ($env:HC_TERMINAL_ID -and $env:HC_TERMINAL_SOCKET -and !$env:CODEX_SESSION_ID) {
    if (!(Get-Command codex -CommandType Alias, Function -ErrorAction SilentlyContinue)) {
        function global:codex { codex.exe --no-daemon @args }
    }
    if (Test-Path -LiteralPath __RUNTIME_PATH__ -PathType Leaf) {
        & __RUNTIME_PATH__ -Mode Resume
    }
}
# <<< herdr-codex-resume <<<
'@
        $block = $block.Replace('__RUNTIME_PATH__', $literalPath).Replace([string][char]13, '').Replace($lf, $eol) + $eol
        if ($matches.Count) {
            $updated = $file.Text.Remove($matches[0].Index, $matches[0].Length).Insert($matches[0].Index, $block)
        } else {
            $separator = if ($file.Text -and !$file.Text.EndsWith($lf)) { $eol } else { '' }
            $updated = $file.Text + $separator + $block
        }
    }
    if ($file.Encoding.CodePage -eq 65001 -and $updated -match '[^\x00-\x7f]') { $file.Encoding = $utf8WithBom }
    Add-FileEdit $file ([byte[]]($file.Encoding.GetPreamble() + $file.Encoding.GetBytes($updated)))
}

function Add-PanelEdits {
    foreach ($name in $panelFiles) {
        $file = Read-EditableFile (Join-Path $panelDirectory $name)
        $owned = if ($name -eq 'main.js') {
            $file.Text.StartsWith('// Rekindle mod for Herdr Desktop', [StringComparison]::Ordinal)
        } else {
            $file.Text -cmatch '"description"\s*:\s*"Rekindle for Herdr\b'
        }
        if ($Uninstall) {
            if ($owned) { Add-FileEdit $file $null }
            continue
        }
        if ($null -ne $file.Bytes -and !$owned) { throw "An unrelated mod file already exists at $($file.Path)." }
        Add-FileEdit $file ([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot "mods\rekindle\$name")))
    }
}

if ($includeChats) {
    $profileFiles = @($ProfilePaths | Where-Object { $_ } | ForEach-Object {
        $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($_)
    } | Sort-Object -Unique)
    $managedPaths = @($runtimePath, $hooksPath) + @($panelFiles | ForEach-Object { Join-Path $panelDirectory $_ })
    if (!$profileFiles.Count -or @($profileFiles | Where-Object { $_ -in $managedPaths }).Count) {
        throw 'Supply distinct paths for the PowerShell profiles and managed files.'
    }

    $runtime = Read-EditableFile $runtimePath
    $ownsRuntime = $runtime.Text.StartsWith('# Herdr Codex Resume', [StringComparison]::Ordinal)
    if (!$Uninstall) {
        if ($null -ne $runtime.Bytes -and !$ownsRuntime) { throw "An unrelated runtime already exists at $runtimePath." }
        Add-FileEdit $runtime ([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'src\herdr-codex-session.ps1')))
    }
    Add-HookEdit
    foreach ($profileFile in $profileFiles) { Add-ProfileEdit $profileFile }
    Add-PanelEdits
    if ($Uninstall -and $ownsRuntime) { Add-FileEdit $runtime $null }
}
if ($includeLayout) {
    . (Join-Path $PSScriptRoot 'src/install-layout.ps1')
    Add-LayoutEdits (Join-Path $PSScriptRoot 'layout')
}

if ($edits.Count) {
    $action = if ($Uninstall) { 'Remove Rekindle' } else { 'Install Rekindle' }
    if (!$PSCmdlet.ShouldProcess(($edits.Path -join ', '), $action)) { return }
    $committed = [Collections.Generic.List[object]]::new()
    try {
        foreach ($edit in $edits) {
            if (!(Test-SameBytes (Get-FileBytes $edit.Path) $edit.Before)) { throw "The file changed during setup: $($edit.Path)" }
            Write-FileBytes $edit.Path $edit.After
            $committed.Add($edit)
        }
    } catch {
        for ($index = $committed.Count - 1; $index -ge 0; $index--) {
            $edit = $committed[$index]
            try {
                if (Test-SameBytes (Get-FileBytes $edit.Path) $edit.After) { Write-FileBytes $edit.Path $edit.Before }
            } catch {
                Write-Warning "Could not roll back $($edit.Path): $($_.Exception.Message)"
            }
        }
        throw
    }
}
if ($Uninstall) {
    Write-Output 'Rekindle has been removed.'
} else {
    if ($includeChats) {
        Write-Output 'Rekindle chat recovery is installed. In a new Codex CLI session, open /hooks and trust the SessionStart hook that runs herdr-codex-session.ps1.'
        Write-Output 'Open the panel with herdr-app do mod.open --name rekindle.'
    }
    if ($includeLayout) {
        Write-Output 'Open Herdr, then select the Rekindle layout with herdr-app do layout.switch --name rekindle.'
    }
}
