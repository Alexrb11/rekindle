# SPDX-License-Identifier: MIT
#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $project 'Install.ps1'
$sourceRuntime = Join-Path $project 'src\herdr-codex-session.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('herdr-codex-resume-test-' + [guid]::NewGuid().ToString('N'))
$utf8 = [Text.UTF8Encoding]::new($false)
$eol = [Environment]::NewLine

function Assert([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
}

function Read-Json([string]$Path) {
    [IO.File]::ReadAllText($Path) | ConvertFrom-Json
}

function Get-FileFingerprint([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Assert-Parses([string]$Path) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors) | Out-Null
    Assert (!$errors.Count) "PowerShell could not parse $Path."
}

[IO.Directory]::CreateDirectory($testRoot) | Out-Null
try {
    Assert-Parses $installer
    Assert-Parses $sourceRuntime

    $codex = Join-Path $testRoot 'Codex''s $ folder'
    $hooks = Join-Path $codex 'hooks.json'
    $runtime = Join-Path $codex 'hooks\herdr-codex-session.ps1'
    $herdr = Join-Path $testRoot 'Herdr app'
    $panel = Join-Path $herdr 'mods\rekindle'
    $panelScript = Join-Path $panel 'main.js'
    $panelManifest = Join-Path $panel 'mod.json'
    $profile = Join-Path $testRoot 'PowerShell profiles\Microsoft.PowerShell_profile.ps1'
    $legacyProfile = Join-Path (Split-Path -Parent $profile) 'second.ps1'
    $profiles = @($profile, $legacyProfile)
    [IO.Directory]::CreateDirectory($codex) | Out-Null
    [IO.Directory]::CreateDirectory((Split-Path -Parent $profile)) | Out-Null
    [IO.File]::WriteAllText($profile, ('# existing comment' + $eol), $utf8)
    [IO.File]::WriteAllText($legacyProfile, ('# UTF-16 profile ' + [char]0x00F1 + $eol), [Text.Encoding]::Unicode)
    $profileBefore = Get-FileFingerprint $profile
    $legacyBefore = Get-FileFingerprint $legacyProfile
    $existingHooks = @'
{
  "description": "existing hooks",
  "hooks": {
    "SessionStart": [{"matcher": "startup", "hooks": [{"type": "command", "command": "echo first"}]}],
    "Stop": [{"hooks": [{"type": "command", "command": "echo last"}]}]
  }
}
'@
    [IO.File]::WriteAllText($hooks, $existingHooks, $utf8)
    $hooksBefore = Get-FileFingerprint $hooks
    $target = @{ CodexDirectory = $codex; ProfilePaths = $profiles; HerdrAppDirectory = $herdr }

    & $installer @target -WhatIf | Out-Null
    Assert (!(Test-Path -LiteralPath $runtime)) 'WhatIf wrote the runtime.'
    Assert (!(Test-Path -LiteralPath $panel)) 'WhatIf wrote the panel.'
    Assert ((Get-FileFingerprint $hooks) -eq $hooksBefore) 'WhatIf changed hooks.json.'
    Assert ((Get-FileFingerprint $profile) -eq $profileBefore) 'WhatIf changed the profile.'

    & $installer @target | Out-Null
    Assert ((Get-FileFingerprint $runtime) -eq (Get-FileFingerprint $sourceRuntime)) 'The runtime copy differs.'
    Assert ((Get-FileFingerprint $panelScript) -eq (Get-FileFingerprint (Join-Path $project 'mods\rekindle\main.js'))) 'The panel script copy differs.'
    Assert ((Get-FileFingerprint $panelManifest) -eq (Get-FileFingerprint (Join-Path $project 'mods\rekindle\mod.json'))) 'The panel manifest copy differs.'
    foreach ($file in $profiles) {
        Assert-Parses $file
        $contents = [IO.File]::ReadAllText($file)
        Assert ($contents.Contains('# >>> herdr-codex-resume >>>')) 'The profile block is missing.'
    }
    $settings = Read-Json $hooks
    Assert ($settings.description -eq 'existing hooks') 'The existing description changed.'
    Assert ($settings.hooks.Stop[0].hooks[0].command -eq 'echo last') 'An unrelated event changed.'
    Assert ($settings.hooks.SessionStart.Count -eq 2) 'One managed SessionStart group was expected.'
    Assert ($settings.hooks.SessionStart[0].matcher -eq 'startup') 'An existing matcher changed.'
    $installedCommand = $settings.hooks.SessionStart[1].hooks[0].command
    $savedTerminal = $env:HC_TERMINAL_ID
    $env:HC_TERMINAL_ID = $null
    try {
        $hookOutput = & ([scriptblock]::Create($installedCommand)) 2>&1
        Assert ($LASTEXITCODE -eq 0 -and !$hookOutput) 'The installed hook could not launch from its quoted path.'
    } finally {
        $env:HC_TERMINAL_ID = $savedTerminal
    }

    $installedFiles = @($runtime, $hooks, $panelScript, $panelManifest) + $profiles
    $firstInstall = $installedFiles | ForEach-Object { Get-FileFingerprint $_ }
    & $installer @target | Out-Null
    $secondInstall = $installedFiles | ForEach-Object { Get-FileFingerprint $_ }
    Assert (($firstInstall -join ',') -ceq ($secondInstall -join ',')) 'A second install rewrote files.'

    # Uninstall just the managed handler even if someone put it in a shared group.
    $settings.hooks.SessionStart[0].hooks += $settings.hooks.SessionStart[1].hooks[0]
    $settings.hooks.SessionStart = @($settings.hooks.SessionStart[0])
    [IO.File]::WriteAllText($hooks, ($settings | ConvertTo-Json -Depth 10), $utf8)
    $panelNote = Join-Path $panel 'notes.txt'
    [IO.File]::WriteAllText($panelNote, 'Keep this file.', $utf8)
    & $installer @target -Uninstall | Out-Null
    & $installer @target -Uninstall | Out-Null
    Assert (!(Test-Path -LiteralPath $runtime)) 'Uninstall left the managed runtime.'
    Assert (!(Test-Path -LiteralPath $panelScript) -and !(Test-Path -LiteralPath $panelManifest)) 'Uninstall left the managed panel.'
    Assert (Test-Path -LiteralPath $panelNote) 'Uninstall removed an unrelated file under mods.'
    Assert ((Get-FileFingerprint $profile) -eq $profileBefore) 'Uninstall changed the original profile bytes.'
    Assert ((Get-FileFingerprint $legacyProfile) -eq $legacyBefore) 'Uninstall changed the UTF-16 profile bytes.'
    $remaining = Read-Json $hooks
    Assert ($remaining.hooks.SessionStart[0].hooks.Count -eq 1) 'Uninstall removed the wrong handler.'
    Assert ($remaining.hooks.SessionStart[0].hooks[0].command -eq 'echo first') 'Uninstall changed the other handler.'

    $freshCodex = Join-Path $testRoot 'new-codex'
    $freshProfile = Join-Path $testRoot 'new-profile.ps1'
    & $installer -CodexDirectory $freshCodex -ProfilePaths $freshProfile -HerdrAppDirectory $herdr | Out-Null
    $freshSettings = Read-Json (Join-Path $freshCodex 'hooks.json')
    Assert ($freshSettings.hooks.SessionStart.Count -eq 1) 'Fresh install did not create one group.'
    & $installer -CodexDirectory $freshCodex -ProfilePaths $freshProfile -HerdrAppDirectory $herdr -Uninstall | Out-Null
    Assert (!(Read-Json (Join-Path $freshCodex 'hooks.json')).hooks.PSObject.Properties['SessionStart']) 'Fresh uninstall left an empty SessionStart.'

    $failed = $false
    $damaged = Join-Path $testRoot 'damaged'
    [IO.Directory]::CreateDirectory($damaged) | Out-Null
    [IO.File]::WriteAllText((Join-Path $damaged 'hooks.json'), '{', $utf8)
    try { & $installer -CodexDirectory $damaged -ProfilePaths $freshProfile -HerdrAppDirectory $herdr | Out-Null } catch { $failed = $true }
    Assert $failed 'Malformed JSON was accepted.'
    Assert (!(Test-Path -LiteralPath (Join-Path $damaged 'hooks\herdr-codex-session.ps1'))) 'An invalid configuration left a runtime behind.'

    $failed = $false
    $rollback = Join-Path $testRoot 'rollback'
    $lock = [IO.File]::Open($profile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try { & $installer -CodexDirectory $rollback -ProfilePaths $profile -HerdrAppDirectory $herdr | Out-Null } catch { $failed = $true } finally { $lock.Dispose() }
    Assert $failed 'Expected the locked profile to prevent installation.'
    Assert (!(Test-Path -LiteralPath (Join-Path $rollback 'hooks.json'))) 'Rollback left a hook configuration behind.'
    Assert (!(Test-Path -LiteralPath (Join-Path $rollback 'hooks\herdr-codex-session.ps1'))) 'Rollback left a runtime behind.'
    Assert ((Get-FileFingerprint $profile) -eq $profileBefore) 'Rollback altered the locked profile.'

    $failed = $false
    [IO.File]::WriteAllText($panelScript, '// An unrelated mod.', $utf8)
    try { & $installer @target | Out-Null } catch { $failed = $true }
    Assert $failed 'Install accepted a mod name collision.'
    Assert ([IO.File]::ReadAllText($panelScript) -eq '// An unrelated mod.') 'Install overwrote the other mod.'
    Assert (!(Test-Path -LiteralPath $runtime)) 'A mod name collision left a runtime behind.'

    Write-Output 'Installer, quoted paths, profile encoding, idempotence, uninstall and rollback passed.'
} finally {
    $temp = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).ProviderPath.TrimEnd('\')
    $testDirectory = Get-Item -LiteralPath $testRoot
    $resolvedRoot = (Resolve-Path -LiteralPath $testRoot).ProviderPath
    if ($resolvedRoot -eq $testRoot -and $testDirectory.Parent.FullName -eq $temp -and
        $testDirectory.Name -match '^herdr-codex-resume-test-[a-f0-9]{32}$' -and
        ($testDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}
