# Herdr Codex Resume
# SPDX-License-Identifier: MIT
#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Record', 'Resume')]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
$terminalId = $env:HC_TERMINAL_ID
if ($terminalId -notmatch '^t[0-9a-z]+$' -or !$env:HC_TERMINAL_SOCKET) { return }
if ($Mode -eq 'Resume' -and $env:CODEX_SESSION_ID) { return }

$hc = (Get-Command hc.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (!$hc -and $env:LOCALAPPDATA) { $hc = Join-Path $env:LOCALAPPDATA 'Programs\herdr-core\hc.exe' }
if (!$hc -or !(Test-Path -LiteralPath $hc -PathType Leaf)) { return }

$label = 'codex.resume'
$uuidPattern = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
$recordPattern = "^$uuidPattern@[0-9]{1,19}$"

function Get-HerdrTerminal {
    try {
        $response = & $hc get $terminalId --json 2>$null
        if ($LASTEXITCODE -eq 0 -and $response) { $response | ConvertFrom-Json }
    } catch {
        # A restored shell can start before the core is ready to serve its terminal.
        return
    }
}

function Save-HerdrSession($Terminal, [string]$SessionId, [long]$ProcessStart) {
    $record = "$SessionId@$ProcessStart"
    if ($Terminal.labels.$label -ceq $record) { return }

    & $hc label $terminalId "$label=$record" --json 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Herdr could not save the Codex session ID.' }
}

function Test-InteractiveCodex([int]$TerminalProcessId) {
    $processId = $PID
    $foundCodex = $false
    for ($depth = 0; $depth -lt 12 -and $processId -gt 0; $depth++) {
        $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$processId" -Property ProcessId, ParentProcessId, Name, CommandLine
        if (!$process) { return $false }
        if ($process.Name -eq 'codex.exe') {
            # A Codex running under the pane's Codex must not replace its chat.
            $noninteractive = $process.CommandLine -match '^\s*(?:"[^"]+"|\S+)\s+(?:--no-daemon\s+)?(?:exec|e|review|app-server)\b'
            if ($foundCodex -or $noninteractive) { return $false }
            $foundCodex = $true
        }
        if ($processId -eq $TerminalProcessId) { return $foundCodex }
        $processId = $process.ParentProcessId
    }
    return $false
}

try {
    if ($Mode -eq 'Record') {
        $event = [Console]::In.ReadToEnd() | ConvertFrom-Json
        if ($event.hook_event_name -ne 'SessionStart' -or $event.session_id -notmatch "^$uuidPattern$") { return }

        $terminal = Get-HerdrTerminal
        if ($terminal.state -ne 'live' -or !$terminal.keep -or !$terminal.labels.'herdr.tab' -or !$terminal.pid) { return }
        if (!(Test-InteractiveCodex $terminal.pid)) { return }

        $processStart = (Get-Process -Id $terminal.pid).StartTime.ToUniversalTime().Ticks
        Save-HerdrSession $terminal $event.session_id $processStart
        return
    }

    for ($attempt = 0; $attempt -lt 16; $attempt++) {
        $terminal = Get-HerdrTerminal
        $record = $terminal.labels.$label
        if ($terminal -and (!$terminal.keep -or !$terminal.labels.'herdr.tab' -or $record -notmatch $recordPattern)) { return }
        if ($terminal.state -eq 'live' -and $terminal.pid -eq $PID) { break }
        if ($terminal.state -eq 'live' -and $terminal.pid) {
            $otherProcess = Get-Process -Id $terminal.pid -ErrorAction SilentlyContinue
            if ($otherProcess -and $record.EndsWith("@$($otherProcess.StartTime.ToUniversalTime().Ticks)")) { return }
        }
        Start-Sleep -Milliseconds 120
    }

    if ($terminal.state -ne 'live' -or $terminal.pid -ne $PID -or $record -notmatch $recordPattern) { return }
    $sessionId, $recordedProcessStart = $record.Split('@')
    $processStart = (Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks
    if ($recordedProcessStart -eq [string]$processStart) { return }

    $codex = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$codex) { return }

    # Claim this shell before launch so reloading its profile cannot open a second client.
    Save-HerdrSession $terminal $sessionId $processStart
    & $codex.Source --no-daemon resume $sessionId
} catch {
    if ($Mode -eq 'Record') {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
    Write-Warning "Herdr could not resume the Codex session. $($_.Exception.Message)"
}
