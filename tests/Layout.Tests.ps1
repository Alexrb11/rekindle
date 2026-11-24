# SPDX-License-Identifier: MIT
#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot '../Install.ps1'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ("rekindle-layout-test-" + [Guid]::NewGuid().ToString('N'))
$app = Join-Path $fixture 'herdr'
$codex = Join-Path $fixture 'codex'
$profilePath = Join-Path $fixture 'profile.ps1'
$layout = Join-Path $app 'layouts/rekindle.json'
$sprite = Join-Path $app 'mods/rekindle-sidebar/art/agent-frames.png'
$options = @{ HerdrAppDirectory = $app; CodexDirectory = $codex; ProfilePaths = @($profilePath) }

function Assert-True([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
}

try {
    & $installer @options -Component Layout -WhatIf | Out-Null
    Assert-True (!(Test-Path -LiteralPath $fixture)) 'A preview must not create files.'
    & $installer @options -Component Layout | Out-Null
    Assert-True (Test-Path -LiteralPath $layout) 'The layout is missing.'
    Assert-True (Test-Path -LiteralPath $sprite) 'The agent sprite is missing.'
    Assert-True (Test-Path -LiteralPath (Join-Path $app 'mods/rekindle-sidebar/workspace-search.js')) 'The workspace search is missing.'
    Assert-True (!(Test-Path -LiteralPath (Join-Path $app 'data/rekindle-agent-types.json'))) 'A fresh layout must start without agent types.'
    Assert-True (!(Test-Path -LiteralPath $codex) -and !(Test-Path -LiteralPath $profilePath)) 'Layout-only installation changed Codex or PowerShell.'
    $first = (Get-FileHash -LiteralPath $sprite).Hash
    & $installer @options -Component All | Out-Null
    Assert-True ((Get-FileHash -LiteralPath $sprite).Hash -eq $first) 'A repeated installation changed the installed sprite.'
    Assert-True (Test-Path -LiteralPath (Join-Path $app 'mods/rekindle/main.js')) 'The chat panel is missing.'
    Assert-True (Test-Path -LiteralPath (Join-Path $codex 'hooks.json')) 'The chat hook is missing.'

    Add-Content -LiteralPath $layout -Value ' '
    $edited = (Get-FileHash -LiteralPath $layout).Hash
    $refused = $false
    try { & $installer @options -Component Layout | Out-Null } catch { $refused = $_.Exception.Message -like '*local edits*' }
    Assert-True $refused 'The installer did not protect an edited layout.'
    & $installer @options -Component Layout -Uninstall -WarningAction SilentlyContinue | Out-Null
    Assert-True ((Get-FileHash -LiteralPath $layout).Hash -eq $edited) 'Uninstall changed an edited layout.'
    Assert-True (!(Test-Path -LiteralPath $sprite)) 'Uninstall kept a managed sprite.'
    Assert-True (Test-Path -LiteralPath (Join-Path $codex 'hooks.json')) 'Layout uninstall changed the chat integration.'
    'Rekindle layout installer checks passed.'
} finally {
    if (Test-Path -LiteralPath $fixture) {
        $absolute = (Resolve-Path -LiteralPath $fixture).ProviderPath
        if ($absolute -eq [IO.Path]::GetFullPath($fixture)) {
            Remove-Item -LiteralPath $absolute -Recurse -Force
        }
    }
}
