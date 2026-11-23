function Read-RolloutEvent([string] $Line) {
  try { ConvertFrom-Json -InputObject $Line } catch {}
}

function Get-TestLabel([string] $Program, [string[]] $Arguments) {
  if (!$Program) { return }
  $name = (($Program -split '[/\\]')[-1] -replace '\.(exe|cmd|bat)$', '').ToLowerInvariant()
  $first = $Arguments | Select-Object -First 1
  if ($name -eq 'cargo') {
    if ($first -eq 'test') { return 'cargo test' }
    if ($first -eq 'nextest' -and $Arguments[1] -eq 'run') { return 'cargo nextest run' }
  }
  if ($name -in @('npm','pnpm','yarn','bun') -and ($first -eq 'test' -or ($first -eq 'run' -and $Arguments[1] -match '^test(:[\w-]+)?$'))) {
    return "$name test"
  }
  if ($name -in @('go','dotnet','gradle','gradlew','mvn','make') -and $first -eq 'test') { return "$name test" }
  if ($name -in @('pytest','vitest','jest','ctest')) { return $name }
  if ($name -in @('python','python3','py') -and $first -eq '-m' -and $Arguments[1] -in @('pytest','unittest')) {
    return "$name -m " + $Arguments[1]
  }
  if ($name -in @('npx','uv','playwright') -and $Arguments -contains 'test' -and $Arguments -contains 'playwright') { return 'playwright test' }
  if ($name -eq 'playwright' -and $first -eq 'test') { return 'playwright test' }
  if ($name -eq 'uv' -and $first -eq 'run' -and $Arguments[1] -eq 'pytest') { return 'uv run pytest' }
  if ($name -eq 'npx' -and $first -in @('jest','vitest','pytest')) { return "npx $first" }
}

function Read-TestExecution($Item) {
  $argv = @($Item.command)
  if (!$argv[0]) { return }
  $program = ($argv[0] -split '[/\\]')[-1]
  $label = Get-TestLabel $argv[0] @($argv | Select-Object -Skip 1)
  $isolated = $true
  if (!$label -and $program -match '^(powershell|pwsh|cmd|bash|sh)(\.exe)?$') {
    $script = ''
    for ($i = 1; $i -lt $argv.Count - 1; $i++) {
      if ($argv[$i] -notin @('-Command','-c','-lc','/c')) { continue }
      $script = @($argv | Select-Object -Skip ($i + 1)) -join ' '
      break
    }
    if (!$script) { return }
    $syntax = [Management.Automation.Language.Parser]::ParseInput($script, [ref]$null, [ref]$null)
    $commands = @($syntax.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] }, $true))
    $labels = @(foreach ($command in $commands) {
      Get-TestLabel ($command.GetCommandName()) @($command.CommandElements | Select-Object -Skip 1 | ForEach-Object {
        if ($_ -is [Management.Automation.Language.StringConstantExpressionAst]) { $_.Value } else { $_.Extent.Text }
      })
    })
    $label = $labels | Select-Object -First 1
    # Only a single command at script scope has an attributable exit code.
    $statements = @($syntax.EndBlock.Statements)
    $isolated = $commands.Count -eq 1 -and $statements.Count -eq 1 -and $statements[0].PipelineElements.Count -eq 1
  }
  if (!$label) { return }
  $result = 'unknown'
  if ($isolated -and $null -ne $Item.exit_code) {
    $result = if ([int]$Item.exit_code -eq 0) { 'passed' } else { 'failed' }
  }
  @{ label = $label; result = $result; code = if ($result -ne 'unknown') { [int]$Item.exit_code } else { $null } }
}

function Get-ReviewGit {
  if ($script:reviewGit) { return $script:reviewGit }
  if ($script:reviewGitMissing) { return }
  $command = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) {
    $script:reviewGit = $command.Source
    return $script:reviewGit
  }
  if ($env:LOCALAPPDATA) {
    $desktop = Join-Path $env:LOCALAPPDATA 'GitHubDesktop'
    foreach ($installed in Get-ChildItem -LiteralPath $desktop -Directory -Filter 'app-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending) {
      $binary = Join-Path $installed.FullName 'resources/app/git/cmd/git.exe'
      if (![IO.File]::Exists($binary)) { continue }
      $script:reviewGit = $binary
      return $script:reviewGit
    }
  }
  $script:reviewGitMissing = $true
}

function Read-WorktreeFiles([string] $Folder) {
  $ErrorActionPreference = 'Continue'
  $git = Get-ReviewGit
  if (!$git -or ![IO.Directory]::Exists($Folder)) { return }
  try {
    $files = @(& $git --no-optional-locks -C $Folder -c core.fsmonitor=false status --porcelain=v1 -z --untracked-files=all 2>$null)
    if ($LASTEXITCODE -ne 0) { return }
    $records = ($files -join "`n").Split([char]0)
    for ($i = 0; $i -lt $records.Count; $i++) {
      $record = $records[$i]
      if ($record.Length -le 3) { continue }
      $record.Substring(3)
      if ($record.Substring(0,2) -match '[RC]') { $i++ }
    }
  } catch {}
}

function Read-ReviewChanges($Payload) {
  if ($Payload.type -eq 'item_completed' -and $Payload.item.type -eq 'FileChange' -and $Payload.item.status -eq 'completed') {
    return $Payload.item.changes
  }
  if ($Payload.type -eq 'patch_apply_end' -and $Payload.success) { return $Payload.changes }
}

function Complete-Delivery($Task, $Thread) {
  $files = @($Task.files | Sort-Object)
  $source = 'recorded'
  if (!$files.Count) {
    $files = @(Read-WorktreeFiles $Thread.cwd)
    $source = 'worktree'
  }
  if (!$Task.summary -and !$files.Count -and !$Task.tests.Count) { return }
  @{
    session = $Thread.id; turn = $Task.turn; time = $Task.time; cwd = $Thread.cwd
    summary = $Task.summary; files = $files; filesSource = $source
    tests = @($Task.tests.Values | Sort-Object { $_.label })
  }
}

function Read-CompletedDeliveries($Thread, [long] $Since) {
  if (![IO.File]::Exists($Thread.path)) { return }
  $task = $null
  try {
    foreach ($line in [RekindleCodexIndex]::RecentEvents($Thread.path, @('task_complete','task_started','item_completed','patch_apply_end','exec_command_end'))) {
      $event = Read-RolloutEvent $line
      if ($event.type -ne 'event_msg') { continue }
      $value = $event.payload
      if ($value.thread_id -and $value.thread_id -ne $Thread.id) { continue }
      if (!$task -or $value.type -eq 'task_complete') {
        $timestamp = [DateTimeOffset]::MinValue
        if (![DateTimeOffset]::TryParse($event.timestamp,[ref]$timestamp)) { continue }
        $time = $timestamp.ToUnixTimeMilliseconds()
        if ($time -le $Since) { break }
      }
      if ($value.type -eq 'task_complete' -and $value.turn_id) {
        if ($task) { Complete-Delivery $task $Thread }
        $summary = [string]$value.last_agent_message
        if ($summary.Length -gt 8000) { $summary = $summary.Substring(0,8000) + ' ...' }
        $task = @{
          turn = $value.turn_id; time = $time; summary = $summary
          files = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase); tests = @{}
        }
        continue
      }
      if (!$task -or ($value.turn_id -and $value.turn_id -ne $task.turn)) { continue }
      if ($value.type -eq 'task_started') {
        Complete-Delivery $task $Thread
        $task = $null
        continue
      }
      $changes = Read-ReviewChanges $value
      if ($changes) {
        foreach ($file in $changes.PSObject.Properties.Name) { $null = $task.files.Add($file) }
      }
      $execution = if ($value.type -eq 'item_completed' -and $value.item.type -eq 'CommandExecution') { $value.item }
        elseif ($value.type -eq 'exec_command_end') { @{ command = $value.command; exit_code = $value.exit_code } }
      if ($execution) {
        $test = Read-TestExecution $execution
        if ($test -and !$task.tests.ContainsKey($test.label)) { $task.tests[$test.label] = $test }
      }
    }
    if ($task) { Complete-Delivery $task $Thread }
  } catch [IO.IOException] {}
}

function Format-RecordedChange([string] $Path, $Change) {
  $label = $Path.Replace('\','/')
  $destination = if ($Change.move_path) { $Change.move_path.Replace('\','/') } else { $label }
  $from = if ($Change.type -eq 'add') { '/dev/null' } else { "a/$label" }
  $to = if ($Change.type -eq 'delete') { '/dev/null' } else { "b/$destination" }
  $header = "diff --git a/$label b/$destination"
  if ($Change.type -eq 'update') {
    $patch = [string]$Change.unified_diff
    if ($patch.StartsWith('diff --git ')) { return $patch }
    if ($patch.StartsWith('--- ')) { return $header + "`n" + $patch }
    return @($header, "--- $from", "+++ $to", $patch) -join "`n"
  }
  $content = [string]$Change.content
  $lines = @($content -split "\r?\n")
  if ($lines[-1] -eq '') { $lines = @($lines | Select-Object -First ($lines.Count - 1)) }
  $prefix = if ($Change.type -eq 'delete') { '-' } else { '+' }
  $hunk = if ($prefix -eq '-') { '@@ -1,' + $lines.Count + ' +0,0 @@' } else { '@@ -0,0 +1,' + $lines.Count + ' @@' }
  @($header, "--- $from", "+++ $to", $hunk) + @($lines | ForEach-Object { $prefix + $_ }) -join "`n"
}

function Read-RecordedDiff($Thread, [string] $Turn) {
  if (!$Thread -or ![IO.File]::Exists($Thread.path)) { return }
  $patches = [Collections.Generic.List[string]]::new()
  try {
    foreach ($line in [RekindleCodexIndex]::RecentEvents($Thread.path, @('task_started','item_completed','patch_apply_end'))) {
      if (!$line.Contains($Turn)) { continue }
      $event = Read-RolloutEvent $line
      $value = $event.payload
      if ($event.type -ne 'event_msg' -or $value.turn_id -ne $Turn -or ($value.thread_id -and $value.thread_id -ne $Thread.id)) { continue }
      if ($value.type -eq 'task_started') { break }
      $changes = Read-ReviewChanges $value
      if (!$changes) { continue }
      foreach ($property in $changes.PSObject.Properties) {
        $patches.Add((Format-RecordedChange $property.Name $property.Value))
      }
    }
    $patches.Reverse()
    $patches -join "`n`n"
  } catch [IO.IOException] {}
}

function Read-WorktreeDiff([string] $Folder) {
  $ErrorActionPreference = 'Continue'
  $git = Get-ReviewGit
  if (!$git -or ![IO.Directory]::Exists($Folder)) { return }
  try {
    $roots = @(& $git --no-optional-locks -C $Folder rev-parse --show-toplevel 2>$null)
    if (!$roots.Count -or $LASTEXITCODE -ne 0) { return }
    $root = $roots[0]
    $options = @('--no-color','--no-ext-diff','--no-textconv')
    $gitRead = @('--no-pager','--no-optional-locks','-C',$root,'-c','core.fsmonitor=false')
    $tracked = @(& $git @gitRead diff @options HEAD -- 2>$null)
    if ($LASTEXITCODE -ne 0) {
      $tracked = @(& $git @gitRead diff @options -- 2>$null)
      $tracked += @(& $git @gitRead diff @options --cached -- 2>$null)
    }
    $untracked = @(& $git --no-optional-locks -C $root -c core.quotepath=false ls-files --others --exclude-standard -z 2>$null)
    $addition = foreach ($path in ($untracked -join "`n") -split "`0") {
      if (!$path) { continue }
      $diff = @(& $git @gitRead diff @options --no-index -- /dev/null $path 2>$null)
      if ($LASTEXITCODE -le 1) { $diff }
    }
    (@($tracked) + @($addition)) -join "`n"
  } catch {}
}

function Read-DeliveryDiff($Thread, $Request) {
  if (!$Request.turn) { return }
  $recorded = Read-RecordedDiff $Thread $Request.turn
  $title = 'Diff registrado en este turno'
  $diff = $recorded
  if (!$diff) {
    $title = 'Diff actual del worktree'
    $diff = Read-WorktreeDiff $Request.cwd
  }
  if (!$diff) { return }
  $truncated = $diff.Length -gt 180000
  if ($truncated) { $diff = $diff.Substring(0,180000) }
  @{ title = $title; text = $diff; truncated = $truncated }
}
