# SPDX-License-Identifier: MIT
#requires -Version 5.1
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop') { throw 'Run this test in Windows PowerShell 5.1 to compile the test executable.' }
$hc = (Get-Command hc.exe -CommandType Application).Source
$project = Split-Path -Parent $PSScriptRoot
$testId = [guid]::NewGuid().ToString('N').Substring(0, 12)
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('herdr-codex-resume-test-' + $testId)
$testCoreId = $null
$envOverrides = @{
    HC_SESSION = 'resume-' + $testId
    HC_TERMINAL_ID = $null
    HC_TERMINAL_SOCKET = $null
    HC_SCOPE = $null
    CODEX_SESSION_ID = $null
    XDG_STATE_HOME = Join-Path $testRoot 'state'
    XDG_CONFIG_HOME = Join-Path $testRoot 'config'
}
$originalEnv = @{}
foreach ($key in $envOverrides.Keys) {
    $originalEnv[$key] = [Environment]::GetEnvironmentVariable($key)
    [Environment]::SetEnvironmentVariable($key, $envOverrides[$key])
}

function Invoke-TestCore {
    $result = & $hc @args
    if ($LASTEXITCODE -ne 0) { throw "Herdr test command failed: $($args[0]) $($args[1])" }
    $result | ConvertFrom-Json
}

function Wait-TestResult([scriptblock]$Check, [string]$Failure) {
    $deadline = [DateTime]::UtcNow.AddSeconds(18)
    do {
        if (& $Check) { return }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    throw $Failure
}

function Stop-IsolatedCore {
    $status = Invoke-TestCore server status --json
    if (!$testCoreId -or $status.core.id -ne $testCoreId) { throw 'Unexpected core ID during test cleanup.' }
    $null = Invoke-TestCore server stop --json
}

try {
    [IO.Directory]::CreateDirectory($testRoot) | Out-Null
    $profile = Join-Path $testRoot 'powershell-profile.ps1'
    $codexDirectory = Join-Path $testRoot 'Codex config'
    $runtime = Join-Path $codexDirectory 'hooks\herdr-codex-session.ps1'
    $fixture = Join-Path $testRoot 'codex.exe'
    Add-Type -Path (Join-Path $PSScriptRoot 'CodexFixture.cs') -OutputAssembly $fixture -OutputType ConsoleApplication
    $appDirectory = Join-Path $testRoot 'Herdr app'
    & (Join-Path $project 'Install.ps1') -CodexDirectory $codexDirectory -ProfilePaths $profile -HerdrAppDirectory $appDirectory | Out-Null

    $bootstrap = @'
$env:PATH = $PSScriptRoot + [IO.Path]::PathSeparator + $env:PATH
. (Join-Path $PSScriptRoot 'powershell-profile.ps1')
'@
    $bootstrapPath = Join-Path $testRoot 'bootstrap.ps1'
    [IO.File]::WriteAllText($bootstrapPath, $bootstrap)
    $configFolder = Join-Path $env:XDG_CONFIG_HOME 'herdr-core'
    [IO.Directory]::CreateDirectory($configFolder) | Out-Null
    $shell = @('powershell.exe', '-NoLogo', '-NoProfile', '-NoExit', '-File', $bootstrapPath)
    [IO.File]::WriteAllText((Join-Path $configFolder 'config.toml'), ('shell = ' + (ConvertTo-Json -InputObject $shell -Compress)))

    $null = Invoke-TestCore server start --json
    $statusBefore = Invoke-TestCore server status --json
    $stateDirectory = Join-Path $env:XDG_STATE_HOME ('herdr-core\' + $env:HC_SESSION)
    if ($statusBefore.live -ne 0 -or !(Test-Path -LiteralPath (Join-Path $stateDirectory 'core.json'))) {
        throw 'The test could not verify that it is using a dedicated Herdr instance.'
    }
    $testCoreId = $statusBefore.core.id
    $panes = foreach ($name in @('resume-one', 'resume-two')) {
        $id = [guid]::NewGuid().ToString()
        $null = Invoke-TestCore run --bg --keep --no-parent --name $name --cwd $testRoot --label "herdr.tab=$name" --json -- $fixture $id $runtime
        $pane = Invoke-TestCore get $name --json
        [pscustomobject]@{ Address = $pane.address; ProcessId = $pane.pid; Id = $id }
    }
    foreach ($pane in $panes) {
        Wait-TestResult {
            $terminal = Invoke-TestCore get $pane.Address --json
            $terminal.labels.'codex.resume' -like "$($pane.Id)@*"
        } "The hook did not save the exact ID for $($pane.Address)."
    }

    Stop-IsolatedCore
    $null = Invoke-TestCore server start --json
    $statusAfter = Invoke-TestCore server status --json
    if ($statusAfter.core.id -ne $testCoreId -or $statusAfter.pid -eq $statusBefore.pid) {
        throw 'The isolated Herdr core was not started in a new process.'
    }
    foreach ($pane in $panes) {
        Wait-TestResult {
            $terminal = Invoke-TestCore get $pane.Address --json
            $terminal.pid -ne $pane.ProcessId -and $terminal.foreground.argv -contains 'resume' -and
                $terminal.foreground.argv -contains $pane.Id -and $terminal.labels.'codex.resume' -like "$($pane.Id)@*"
        } "The replacement shell did not resume the exact chat for $($pane.Address)."
    }
    Write-Output 'Two independent session IDs were recorded and resumed in their original panes after an isolated Herdr restart.'
} finally {
    try {
        if ($testCoreId) { Stop-IsolatedCore }
    } finally {
        foreach ($key in $originalEnv.Keys) { [Environment]::SetEnvironmentVariable($key, $originalEnv[$key]) }
    }
    if (Test-Path -LiteralPath $testRoot) {
        $temp = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).ProviderPath.TrimEnd('\')
        $testDirectory = Get-Item -LiteralPath $testRoot
        $resolvedRoot = (Resolve-Path -LiteralPath $testRoot).ProviderPath
        if ($resolvedRoot -eq $testRoot -and $testDirectory.Parent.FullName -eq $temp -and
            $testDirectory.Name -match '^herdr-codex-resume-test-[a-f0-9]{12}$' -and
            ($testDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
            Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
        }
    }
}
