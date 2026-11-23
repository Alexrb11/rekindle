param(
  [ValidateSet('usage', 'quota', 'diff')]
  [string] $Operation = 'usage',
  [string] $TerminalList = '%5B%5D',
  [string] $ReviewSpec = '%7B%7D',
  [string] $CodexRoot = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' })
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Convert-Quota($Snapshot, [bool] $FromAccount, [long] $Time) {
  $windows = foreach ($window in @($Snapshot.primary, $Snapshot.secondary)) {
    $used = if ($FromAccount) { $window.usedPercent } else { $window.used_percent }
    if ($null -eq $used) { continue }
    @{
      used = [double]$used
      minutes = if ($FromAccount) { $window.windowDurationMins } else { $window.window_minutes }
      resets = if ($FromAccount) { $window.resetsAt } else { $window.resets_at }
    }
  }
  if (@($windows).Count) {
    @{ windows = @($windows); captured = $Time; source = if ($FromAccount) { 'account' } else { 'history' } }
  }
}

function Read-RpcReply($Process, [int] $Id, $Deadline) {
  while ($true) {
    $remaining = [int][Math]::Max(0, ($Deadline - [DateTime]::UtcNow).TotalMilliseconds)
    if (!$remaining) { throw 'Codex no ha respondido a tiempo.' }
    $read = $Process.StandardOutput.ReadLineAsync()
    if (!$read.Wait($remaining) -or $null -eq $read.Result) { throw 'Codex no ha devuelto una respuesta.' }
    try { $reply = ConvertFrom-Json -InputObject $read.Result } catch { continue }
    if ($reply.id -ne $Id) { continue }
    if ($reply.error) { throw 'Codex no pudo devolver los límites de la cuenta.' }
    return $reply.result
  }
}

function Get-AccountQuota {
  $binary = Get-Command codex.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $binary.Source
  $start.Arguments = 'app-server --listen stdio://'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = [Diagnostics.Process]::Start($start)
  try {
    $stderr = $process.StandardError.ReadToEndAsync()
    $deadline = [DateTime]::UtcNow.AddSeconds(16)
    $process.StandardInput.AutoFlush = $true
    $process.StandardInput.WriteLine('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"rekindle","title":"Rekindle","version":"1.0"}}}')
    $null = Read-RpcReply $process 1 $deadline
    $process.StandardInput.WriteLine('{"method":"initialized"}')
    $process.StandardInput.WriteLine('{"id":2,"method":"account/rateLimits/read"}')
    $response = Read-RpcReply $process 2 $deadline
    $limits = $response.rateLimitsByLimitId.codex
    if (!$limits -and (!$response.rateLimits.limitId -or $response.rateLimits.limitId -eq 'codex')) {
      $limits = $response.rateLimits
    }
    Convert-Quota $limits $true ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  } finally {
    $process.StandardInput.Close()
    if (!$process.WaitForExit(1000)) { $process.Kill() }
    $process.Dispose()
  }
}

if ($Operation -eq 'quota') {
  $quota = Get-AccountQuota
  ConvertTo-Json -InputObject $quota -Depth 6 -Compress
  exit
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class RekindleCodexIndex {
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_open_v2(byte[] path, out IntPtr db, int flags, IntPtr vfs);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_close(IntPtr db);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_busy_timeout(IntPtr db, int timeout);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int length, out IntPtr stmt, IntPtr tail);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_step(IntPtr stmt);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_finalize(IntPtr stmt);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_column_count(IntPtr stmt);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_column_bytes(IntPtr stmt, int i);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_column_text(IntPtr stmt, int i);

    public static string[][] Query(string file, string query) {
        IntPtr db = IntPtr.Zero;
        IntPtr stmt = IntPtr.Zero;
        try {
            if (sqlite3_open_v2(Encoding.UTF8.GetBytes(file + "\0"), out db, 1, IntPtr.Zero) != 0)
                throw new IOException("Could not open the Codex index for reading.");
            sqlite3_busy_timeout(db, 500);
            if (sqlite3_prepare_v2(db, Encoding.UTF8.GetBytes(query + "\0"), -1, out stmt, IntPtr.Zero) != 0)
                throw new IOException("The Codex index has an unsupported format.");
            var rows = new List<string[]>();
            var columns = sqlite3_column_count(stmt);
            int status;
            while ((status = sqlite3_step(stmt)) == 100) {
                var row = new string[columns];
                for (int i = 0; i < columns; i++) {
                    IntPtr text = sqlite3_column_text(stmt, i);
                    if (text == IntPtr.Zero) continue;
                    byte[] bytes = new byte[sqlite3_column_bytes(stmt, i)];
                    Marshal.Copy(text, bytes, 0, bytes.Length);
                    row[i] = Encoding.UTF8.GetString(bytes);
                }
                rows.Add(row);
            }
            if (status != 101) throw new IOException("Could not read the Codex index.");
            return rows.ToArray();
        } finally {
            if (stmt != IntPtr.Zero) sqlite3_finalize(stmt);
            if (db != IntPtr.Zero) sqlite3_close(db);
        }
    }

    public static IEnumerable<string> RecentEvents(string file, string[] kinds) {
        using (var stream = File.Open(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
            var markers = Array.ConvertAll(kinds, kind => "\"" + kind + "\"");
            var buffer = new byte[64 * 1024];
            long offset = stream.Length;
            string leading = "";
            while (offset > 0) {
                var size = (int)Math.Min(buffer.Length, offset);
                offset -= size;
                stream.Position = offset;
                var read = stream.Read(buffer, 0, size);
                var lines = (Encoding.UTF8.GetString(buffer, 0, read) + leading).Split('\n');
                for (int i = lines.Length - 1; i >= (offset == 0 ? 0 : 1); i--) {
                    foreach (var marker in markers) {
                        if (lines[i].IndexOf(marker, StringComparison.Ordinal) < 0) continue;
                        yield return lines[i];
                        break;
                    }
                }
                leading = lines[0];
            }
        }
    }
}
'@

. (Join-Path $PSScriptRoot 'codex-reviews.ps1')

function Get-IndexFile([string] $Pattern) {
  Get-ChildItem -LiteralPath $CodexRoot -Filter $Pattern -File -ErrorAction SilentlyContinue |
    Where-Object { $_.BaseName -match '_\d+$' } |
    Sort-Object { [int]($_.BaseName.Split('_')[-1]) } -Descending |
    Select-Object -First 1
}

function Read-UsageCounter([string] $Path) {
  if (![IO.File]::Exists($Path)) { return }
  try {
    foreach ($line in [RekindleCodexIndex]::RecentEvents($Path, @('token_count'))) {
      try { $event = ConvertFrom-Json -InputObject $line } catch { continue }
      if ($event.type -eq 'event_msg' -and $event.payload.type -eq 'token_count' -and $event.payload.info.total_token_usage) {
        return $event.payload.info.total_token_usage
      }
    }
  } catch [IO.IOException] {}
}

function Read-LastTurnCounter($Thread) {
  if (![IO.File]::Exists($Thread.path)) { return }
  $latest = $null
  $beforeTurn = $false
  try {
    foreach ($line in [RekindleCodexIndex]::RecentEvents($Thread.path, @('token_usage_record','task_started','token_count'))) {
      $event = Read-RolloutEvent $line
      if (!$beforeTurn -and $event.type -eq 'token_usage_record' -and $event.payload.thread_id -eq $Thread.id) {
        $tokens = $event.payload.turn_token_usage.total_tokens
        if ($null -ne $tokens) { return [long]$tokens }
      }
      if ($event.type -ne 'event_msg') { continue }
      if ($event.payload.type -eq 'task_started' -and $null -ne $latest) {
        $beforeTurn = $true
      }
      if ($event.payload.type -eq 'token_count') {
        $total = $event.payload.info.total_token_usage.total_tokens
        if ($null -eq $total) { continue }
        if ($beforeTurn -and $latest -ge [long]$total) { return $latest - [long]$total }
        if ($null -eq $latest) { $latest = [long]$total }
      }
    }
  } catch [IO.IOException] {}
}

function Read-ForkCounter($Thread) {
  if (![IO.File]::Exists($Thread.path)) { return }
  $reader = $null
  try {
    $stream = [IO.File]::Open($Thread.path, 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)
    $header = $reader.ReadLine()
    if ($header -notmatch '"forked_from_id"\s*:\s*"') { return }
    try { $meta = ConvertFrom-Json -InputObject $header } catch { return }
    if ($meta.type -ne 'session_meta' -or !$meta.payload.forked_from_id) { return }

    # A fork can inherit the parent's cumulative counters. Sum only its own model responses.
    $counters = @{ total_tokens = $null; input_tokens = 0L; output_tokens = 0L; cached_input_tokens = 0L }
    $responses = [Collections.Generic.HashSet[string]]::new()
    while ($null -ne ($line = $reader.ReadLine())) {
      if ($line -notmatch '"type"\s*:\s*"token_usage_record"') { continue }
      try { $event = ConvertFrom-Json -InputObject $line } catch { continue }
      $record = $event.payload
      if ($event.type -ne 'token_usage_record' -or $record.thread_id -ne $Thread.id -or !$record.usage) { continue }
      if ($record.response_id -and !$responses.Add($record.response_id)) { continue }
      $counters.total_tokens = [long]$counters.total_tokens + [long]$record.usage.total_tokens
      $counters.input_tokens += [long]$record.usage.input_tokens
      $counters.output_tokens += [long]$record.usage.output_tokens
      $counters.cached_input_tokens += [long]$record.usage.cached_input_tokens
    }
    return $counters
  } catch [IO.IOException] {
  } finally {
    if ($reader) { $reader.Dispose() }
  }
}

function Read-LocalQuota($Threads) {
  foreach ($thread in $Threads) {
    if (![IO.File]::Exists($thread.path)) { continue }
    try {
      foreach ($line in [RekindleCodexIndex]::RecentEvents($thread.path, @('token_count'))) {
        try { $event = ConvertFrom-Json -InputObject $line } catch { continue }
        if ($event.type -ne 'event_msg' -or $event.payload.type -ne 'token_count') { continue }
        $limits = $event.payload.rate_limits
        if (!$limits -or ($limits.limit_id -and $limits.limit_id -ne 'codex')) { continue }
        $time = [DateTimeOffset]::Parse($event.timestamp).ToUnixTimeMilliseconds()
        $quota = Convert-Quota $limits $false $time
        if ($quota) { return $quota }
      }
    } catch [IO.IOException] {}
  }
}

function Get-Processes {
  try {
    Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate
  } catch {
    foreach ($process in Get-Process -Name codex -ErrorAction SilentlyContinue) {
      @{ ProcessId = $process.Id; ParentProcessId = 0; Name = 'codex.exe'; CreationDate = $process.StartTime }
    }
  }
}

function Get-ChatLinks($Terminals, $Threads, $LogDb) {
  $links = @{}
  if (!$LogDb -or !@($Terminals).Count) { return $links }
  $processes = @{}
  foreach ($process in Get-Processes) { $processes[[int]$process.ProcessId] = $process }
  $owners = @{}
  $logFilters = [Collections.Generic.List[string]]::new()
  foreach ($process in $processes.Values) {
    if ($process.Name -notmatch '^codex(?:-.*)?\.exe$' -or !$process.CreationDate) { continue }
    $pidNumber = [int]$process.ProcessId
    $ancestors = [Collections.Generic.HashSet[int]]::new()
    $cursor = $process
    while ($cursor -and $ancestors.Add([int]$cursor.ProcessId)) {
      $ancestor = $processes[[int]$cursor.ParentProcessId]
      if (!$ancestor -or !$ancestor.CreationDate -or $ancestor.CreationDate -gt $cursor.CreationDate) { break }
      $cursor = $ancestor
    }
    foreach ($terminal in $Terminals) {
      if (!$ancestors.Contains([int]$terminal.process) -and !$ancestors.Contains([int]$terminal.foreground)) { continue }
      $owners[$pidNumber] = @($owners[$pidNumber] | Where-Object { $_ }) + @($terminal.address)
    }
    if (!$owners.ContainsKey($pidNumber)) { continue }
    $since = ([DateTimeOffset]$process.CreationDate).ToUnixTimeSeconds()
    $logFilters.Add("(process_uuid >= 'pid:${pidNumber}:' AND process_uuid < 'pid:${pidNumber};' AND ts >= $since)")
  }
  if (!$logFilters.Count) { return $links }
  $filter = $logFilters -join ' OR '
  $query = "SELECT process_uuid, thread_id, MAX(id) FROM logs WHERE thread_id IS NOT NULL AND ($filter) GROUP BY process_uuid, thread_id ORDER BY MAX(id) DESC"
  foreach ($row in [RekindleCodexIndex]::Query($LogDb.FullName, $query)) {
    $thread = $Threads[$row[1]]
    if (!$thread -or $thread.source -ne 'cli' -or $row[0] -notmatch '^pid:(\d+):') { continue }
    foreach ($address in $owners[[int]$Matches[1]]) {
      if (!$links.ContainsKey($address)) { $links[$address] = $thread.id }
    }
  }
  return $links
}

$stateDb = Get-IndexFile 'state_*.sqlite'
if (!$stateDb) {
  ConvertTo-Json -InputObject @{ sessions = @(); links = @{}; quota = $null } -Compress
  exit
}
$threads = [Collections.Generic.List[object]]::new()
$byId = @{}
foreach ($row in [RekindleCodexIndex]::Query($stateDb.FullName, 'SELECT id, cwd, tokens_used, rollout_path, source FROM threads ORDER BY updated_at_ms DESC')) {
  if (!$row[0]) { continue }
  $thread = @{ id = $row[0]; cwd = $row[1]; total = [long]$row[2]; path = $row[3]; source = $row[4] }
  $threads.Add($thread)
  $byId[$thread.id] = $thread
}
$reviewOptions = ConvertFrom-Json -InputObject ([Uri]::UnescapeDataString($ReviewSpec))
if ($Operation -eq 'diff') {
  $thread = if ($reviewOptions.session) { $byId[$reviewOptions.session] }
  $diff = Read-DeliveryDiff $thread $reviewOptions
  ConvertTo-Json -InputObject $diff -Depth 5 -Compress
  exit
}
$decodedTerminals = ConvertFrom-Json -InputObject ([Uri]::UnescapeDataString($TerminalList))
$terminals = @($decodedTerminals | Where-Object { $_.address })
$links = @{}
try { $links = Get-ChatLinks $terminals $byId (Get-IndexFile 'logs_*.sqlite') } catch {}
foreach ($terminal in $terminals) {
  if (!$links.ContainsKey($terminal.address) -and $terminal.session -and $byId.ContainsKey($terminal.session)) {
    $links[$terminal.address] = $terminal.session
  }
}
$chatIds = [Collections.Generic.HashSet[string]]::new([string[]]@($links.Values))
$sessions = foreach ($thread in $threads) {
  $result = @{ id = $thread.id; cwd = $thread.cwd; total = $thread.total }
  $usage = Read-ForkCounter $thread
  if (!$usage -and $chatIds.Contains($thread.id)) { $usage = Read-UsageCounter $thread.path }
  if ($usage) {
    $result.total = $usage.total_tokens
    $result.input = $usage.input_tokens
    $result.output = $usage.output_tokens
    $result.cached = $usage.cached_input_tokens
  }
  if ($chatIds.Contains($thread.id)) {
    $turn = Read-LastTurnCounter $thread
    if ($null -ne $turn) { $result.lastTurn = $turn }
  }
  $result
}
$deliveries = if ($reviewOptions.since) {
  $ids = @($links.Values) + @($reviewOptions.tracked)
  foreach ($sessionId in $ids | Where-Object { $_ } | Sort-Object -Unique) {
    $thread = $byId[$sessionId]
    if (!$thread) { continue }
    $lastDelivery = if ($reviewOptions.seen) { $reviewOptions.seen.PSObject.Properties[$sessionId].Value }
    $cutoff = [Math]::Max([long]$reviewOptions.since, [long]$lastDelivery)
    try { Read-CompletedDeliveries $thread $cutoff } catch {}
  }
}
ConvertTo-Json -InputObject @{
  sessions = @($sessions); links = $links; quota = (Read-LocalQuota $threads); deliveries = @($deliveries | Where-Object { $_ })
} -Depth 9 -Compress
