const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const modulePath = path.join(root, "scripts", "CodexStatusWatchdog.psm1");
const watchdogPath = path.join(root, "scripts", "codex-status-watchdog.ps1");

function powershell(script) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { cwd: root, encoding: "utf8", windowsHide: true }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function runInstallerHarness(script) {
  const harnessPath = path.join(
    os.tmpdir(),
    `codex-status-installer-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`
  );
  fs.writeFileSync(
    harnessPath,
    `\uFEFF[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n${script}`,
    "utf8"
  );
  try {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harnessPath],
      { cwd: root, encoding: "utf8", windowsHide: true }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    if (!result.stdout.trim()) {
      throw new Error(JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }));
    }
    return result.stdout.trim();
  } finally {
    fs.rmSync(harnessPath, { force: true });
  }
}

test("extracts the newest valid Quick Tunnel URL", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const output = powershell(
    `Import-Module '${escaped}' -Force; ` +
      `Get-TunnelUrlFromText 'old https://old.trycloudflare.com new https://new.trycloudflare.com'`
  );
  assert.equal(output, "https://new.trycloudflare.com");
});

test("command-line ownership requires every expected fragment", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const output = powershell(
      `Import-Module '${escaped}' -Force; ` +
      `[string](Test-ExpectedCommandLine '"node.exe" C:\\app\\server.js' @('node.exe','C:\\app\\server.js')); ` +
      `[string](Test-ExpectedCommandLine '"node.exe" C:\\other\\server.js' @('node.exe','C:\\app\\server.js')); ` +
      `[string](Test-ExpectedCommandLine '"node.exe" C:\\app\\server.js --inspect' @('node.exe','C:\\app\\server.js'))`
  ).split(/\r?\n/);
  assert.deepEqual(output, ["True", "False", "False"]);
});

test("strict health and status probes reject generic HTTP success responses", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const validStatus = JSON.stringify({
    source: "codex-local",
    state: "processing",
    light: "red",
    label: "Working",
    sessionCount: 1,
    sessions: [
      {
        title: "Focused test",
        state: "processing",
        lastStartedAt: 1785431999000,
        lastCompletedAt: 0,
        updatedAt: 1785432000000,
      },
    ],
    totalThreads: 1,
    hostname: "test-host",
    lastCompletedAt: null,
    updatedAt: 1785432000000,
    error: "",
  }).replace(/'/g, "''");
  const validIdleStatus = JSON.stringify({
    source: "codex-local",
    state: "idle",
    light: "green",
    label: "Idle",
    sessionCount: 0,
    sessions: [],
    totalThreads: 0,
    hostname: "test-host",
    lastCompletedAt: null,
    updatedAt: 1785432000000,
    error: "",
  }).replace(/'/g, "''");
  const script =
    `Import-Module '${escaped}' -Force; ` +
    `function global:Invoke-WebRequest { [CmdletBinding()] param([string]$Uri, [int]$TimeoutSec, [switch]$UseBasicParsing) ` +
    `switch ($Uri) { ` +
    `'http://test/empty' { [pscustomobject]@{ StatusCode = 204; Content = '' } } ` +
    `'http://test/html' { [pscustomobject]@{ StatusCode = 200; Content = '<html>ok</html>' } } ` +
    `'http://test/bad-json' { [pscustomobject]@{ StatusCode = 200; Content = '{broken' } } ` +
    `'http://test/bad-health' { [pscustomobject]@{ StatusCode = 200; Content = '{"ok":true,"startedAt":"1785432000000","now":1785432005000}' } } ` +
    `'http://test/health' { [pscustomobject]@{ StatusCode = 200; Content = '{"ok":true,"startedAt":1785432000000,"now":1785432005000}' } } ` +
    `'http://test/bad-status' { [pscustomobject]@{ StatusCode = 200; Content = '{"state":"processing"}' } } ` +
    `'http://test/status' { [pscustomobject]@{ StatusCode = 200; Content = '${validStatus}' } } ` +
    `'http://test/idle-status' { [pscustomobject]@{ StatusCode = 200; Content = '${validIdleStatus}' } } ` +
    `default { throw 'unexpected URL' } } }; ` +
    `@('empty','html','bad-json','bad-health','health') | ForEach-Object { [string](Test-LocalHealthEndpoint -Url ('http://test/' + $_) -TimeoutSeconds 3) }; ` +
    `@('empty','html','bad-json','bad-status','status','idle-status') | ForEach-Object { [string](Test-PublicStatusEndpoint -Url ('http://test/' + $_) -TimeoutSeconds 5) }`;

  assert.deepEqual(powershell(script).split(/\r?\n/), [
    "False",
    "False",
    "False",
    "False",
    "True",
    "False",
    "False",
    "False",
    "False",
    "True",
    "True",
  ]);
});

test("local server gate refuses a healthy listener without exact PID ownership", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const script =
    `Import-Module '${escaped}' -Force; ` +
    `$owned = [pscustomobject]@{ ProcessId = 4242 }; ` +
    `Get-LocalServerGateDecision -LocalHealthValid $true -OwnedServer $null; ` +
    `Get-LocalServerGateDecision -LocalHealthValid $true -OwnedServer $owned; ` +
    `Get-LocalServerGateDecision -LocalHealthValid $false -OwnedServer $owned`;

  assert.deepEqual(powershell(script).split(/\r?\n/), [
    "OwnershipConflict",
    "OwnedServerReady",
    "RecoverServer",
  ]);
});

test("GitHub auth preflight accepts non-empty GH_TOKEN without invoking gh", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const output = powershell(
    `Import-Module '${escaped}' -Force; ` +
      `[string](Assert-GitHubAuthentication -GhPath 'C:\\gh.exe' -EnvironmentToken 'test-only-token' -RunAuthStatus { throw 'gh must not run' })`
  );

  assert.equal(output, "True");
  assert.doesNotMatch(output, /test-only-token/);
});

test("GitHub auth preflight accepts authenticated gh CLI status", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const output = powershell(
    `Import-Module '${escaped}' -Force; ` +
      `$global:checks = 0; ` +
      `$result = Assert-GitHubAuthentication -GhPath 'C:\\gh.exe' -EnvironmentToken '' -RunAuthStatus { param($path) if ($path -ne 'C:\\gh.exe') { throw 'wrong gh path' }; $global:checks++; $true }; ` +
      `"$result|$global:checks"`
  );

  assert.equal(output, "True|1");
});

test("GitHub auth preflight rejects unauthenticated CLI with a sanitized action", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const output = powershell(
    `Import-Module '${escaped}' -Force; ` +
      `try { Assert-GitHubAuthentication -GhPath 'C:\\gh.exe' -EnvironmentToken '' -RunAuthStatus { throw 'secret-token auth failure' } | Out-Null } catch { $_.Exception.Message }`
  );

  assert.match(output, /gh auth login/);
  assert.match(output, /GH_TOKEN/);
  assert.doesNotMatch(output, /secret-token/);
});

test("configuration check returns dependency paths without starting processes", () => {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      watchdogPath,
      "-CheckConfiguration",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: "configuration-test-token" },
      windowsHide: true,
    }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout + result.stderr, /configuration-test-token/);
  const config = JSON.parse(result.stdout);
  assert.equal(config.projectRoot, root);
  assert.match(config.nodePath.toLowerCase(), /node\.exe$/);
  assert.match(config.cloudflaredPath.toLowerCase(), /cloudflared\.exe$/);
  assert.match(config.publisherPath, /endpoint-registry\.js$/);
  assert.equal(config.localHealthUrl, "http://127.0.0.1:3456/api/health");
});

test("owned PID lookup rejects invalid files before querying processes", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const pidFile = path.join(os.tmpdir(), `codex-status-invalid-${process.pid}.pid`);
  fs.writeFileSync(pidFile, "not-a-pid\n", "ascii");
  try {
    const output = powershell(
      `Import-Module '${escaped}' -Force; ` +
        `function global:Get-CimInstance { throw 'must not query' }; ` +
        `[string](Get-OwnedProcessFromPidFile -PidFile '${pidFile.replace(/'/g, "''")}' -ExpectedCommandLineFragments @('node.exe'))`
    );
    assert.equal(output, "");
  } finally {
    fs.rmSync(pidFile, { force: true });
  }
});

test("owned PID lookup queries exactly the recorded PID and validates its command line", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const pidFile = path.join(os.tmpdir(), `codex-status-owned-${process.pid}.pid`);
  fs.writeFileSync(pidFile, "4242", "ascii");
  try {
    const script =
      `Import-Module '${escaped}' -Force; ` +
      `function global:Get-CimInstance { param([string]$ClassName, [string]$Filter) ` +
      `if ($ClassName -ne 'Win32_Process' -or $Filter -ne 'ProcessId = 4242') { throw 'unexpected query' }; ` +
      `[pscustomobject]@{ ProcessId = 4242; CommandLine = '"node.exe" "C:\\app\\server.js"' } }; ` +
      `(Get-OwnedProcessFromPidFile -PidFile '${pidFile.replace(/'/g, "''")}' -ExpectedCommandLineFragments @('node.exe', 'C:\\app\\server.js')).ProcessId; ` +
      `[string]($null -eq (Get-OwnedProcessFromPidFile -PidFile '${pidFile.replace(/'/g, "''")}' -ExpectedCommandLineFragments @('other.js')))`;
    assert.deepEqual(powershell(script).split(/\r?\n/), ["4242", "True"]);
  } finally {
    fs.rmSync(pidFile, { force: true });
  }
});

test("owned process start atomically records exactly one integer PID", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-status-pid-success-"));
  const pidFile = path.join(directory, "server.pid");
  const escapedDirectory = directory.replace(/'/g, "''");
  const escapedPidFile = pidFile.replace(/'/g, "''");
  try {
    const script =
      `Import-Module '${escaped}' -Force; ` +
      `$global:child = [pscustomobject]@{ Id = 4242 }; ` +
      `$result = Start-OwnedProcess -FilePath 'C:\\node.exe' -Arguments @('C:\\app path\\server.js') -WorkingDirectory '${escapedDirectory}' -PidFile '${escapedPidFile}' -OutputLog '${escapedDirectory}\\server.out.log' -ErrorLog '${escapedDirectory}\\server.err.log' -StartProcessAction { param($filePath, $arguments, $workingDirectory, $outputLog, $errorLog) $global:child }; ` +
      `"$($result.Id)|$([System.IO.File]::ReadAllText('${escapedPidFile}'))"`;

    assert.equal(powershell(script), "4242|4242");
    assert.deepEqual(
      fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")),
      []
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("PID write failure kills and waits only for the just-created child", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-status-pid-write-"));
  const pidFile = path.join(directory, "server.pid");
  const escapedDirectory = directory.replace(/'/g, "''");
  const escapedPidFile = pidFile.replace(/'/g, "''");
  try {
    const script =
      `Import-Module '${escaped}' -Force; ` +
      `function global:Stop-Process { throw 'unrelated PID termination is forbidden' }; ` +
      `$global:child = [pscustomobject]@{ Id = 4242; Killed = 0; Waited = 0; Disposed = 0 }; ` +
      `$global:child | Add-Member ScriptMethod Kill { $this.Killed++ }; ` +
      `$global:child | Add-Member ScriptMethod WaitForExit { $this.Waited++; $true }; ` +
      `$global:child | Add-Member ScriptMethod Dispose { $this.Disposed++ }; ` +
      `$global:unrelated = [pscustomobject]@{ Id = 9999; Killed = 0 }; ` +
      `$global:tempPath = ''; ` +
      `try { Start-OwnedProcess -FilePath 'C:\\node.exe' -Arguments @('C:\\app path\\server.js') -WorkingDirectory '${escapedDirectory}' -PidFile '${escapedPidFile}' -OutputLog '${escapedDirectory}\\server.out.log' -ErrorLog '${escapedDirectory}\\server.err.log' -StartProcessAction { $global:child } -WritePidAction { param($tempPath, $processId) $global:tempPath = $tempPath; [System.IO.File]::WriteAllText($tempPath, 'partial'); throw 'injected write failure' } -CommitPidAction { throw 'must not commit' } | Out-Null } catch { $message = $_.Exception.Message }; ` +
      `"$message|$($global:child.Killed)|$($global:child.Waited)|$($global:child.Disposed)|$($global:unrelated.Killed)|$(Test-Path -LiteralPath $global:tempPath)|$(Test-Path -LiteralPath '${escapedPidFile}')"`;

    assert.equal(
      powershell(script),
      "injected write failure|1|1|1|0|False|False"
    );
    assert.deepEqual(
      fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")),
      []
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("PID replace failure preserves the prior claim and cleans the exact new child", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-status-pid-replace-"));
  const pidFile = path.join(directory, "server.pid");
  fs.writeFileSync(pidFile, "7777", "ascii");
  const escapedDirectory = directory.replace(/'/g, "''");
  const escapedPidFile = pidFile.replace(/'/g, "''");
  try {
    const script =
      `Import-Module '${escaped}' -Force; ` +
      `function global:Stop-Process { throw 'unrelated PID termination is forbidden' }; ` +
      `$global:child = [pscustomobject]@{ Id = 5252; Killed = 0; Waited = 0; Disposed = 0 }; ` +
      `$global:child | Add-Member ScriptMethod Kill { $this.Killed++ }; ` +
      `$global:child | Add-Member ScriptMethod WaitForExit { $this.Waited++; $true }; ` +
      `$global:child | Add-Member ScriptMethod Dispose { $this.Disposed++ }; ` +
      `$global:unrelated = [pscustomobject]@{ Id = 7777; Killed = 0 }; ` +
      `$global:tempPath = ''; ` +
      `try { Start-OwnedProcess -FilePath 'C:\\node.exe' -Arguments @('C:\\app path\\server.js') -WorkingDirectory '${escapedDirectory}' -PidFile '${escapedPidFile}' -OutputLog '${escapedDirectory}\\server.out.log' -ErrorLog '${escapedDirectory}\\server.err.log' -StartProcessAction { $global:child } -CommitPidAction { param($tempPath, $targetPath) $global:tempPath = $tempPath; throw 'injected replace failure' } | Out-Null } catch { $message = $_.Exception.Message }; ` +
      `"$message|$($global:child.Killed)|$($global:child.Waited)|$($global:child.Disposed)|$($global:unrelated.Killed)|$(Test-Path -LiteralPath $global:tempPath)|$([System.IO.File]::ReadAllText('${escapedPidFile}'))"`;

    assert.equal(
      powershell(script),
      "injected replace failure|1|1|1|0|False|7777"
    );
    assert.deepEqual(
      fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")),
      []
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("configuration check does not create the watchdog state directory", () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-status-config-"));
  try {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", watchdogPath, "-CheckConfiguration"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GH_TOKEN: "configuration-test-token",
          LOCALAPPDATA: stateRoot,
        },
        windowsHide: true,
      }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(path.join(stateRoot, "CodexStatusLight")), false);
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("stop path revalidates the exact PID and never terminates an ownership mismatch", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const pidFile = path.join(os.tmpdir(), `codex-status-stop-${process.pid}.pid`);
  fs.writeFileSync(pidFile, "4242", "ascii");
  try {
    const script =
      `Import-Module '${escaped}' -Force; ` +
      `$global:queries = 0; $global:terminated = 0; ` +
      `function global:Get-Process { throw 'process-name enumeration is forbidden' }; ` +
      `function global:Get-CimInstance { param([string]$ClassName, [string]$Filter) ` +
      `$global:queries++; if ($ClassName -ne 'Win32_Process' -or $Filter -ne 'ProcessId = 4242') { throw 'unexpected query' }; ` +
      `[pscustomobject]@{ ProcessId = 4242; CommandLine = '"node.exe" C:\\other\\server.js' } }; ` +
      `function global:Invoke-CimMethod { $global:terminated++; throw 'must not terminate' }; ` +
      `[string]((Stop-OwnedProcessFromPidFile -PidFile '${pidFile.replace(/'/g, "''")}' -ExpectedCommandLineFragments @('node.exe', 'C:\\app\\server.js')).Status); ` +
      `"$global:queries|$global:terminated"`;
    assert.deepEqual(powershell(script).split(/\r?\n/), ["NoOwnedProcess", "1|0"]);
  } finally {
    fs.rmSync(pidFile, { force: true });
  }
});

test("stop path terminates the revalidated WMI process object without a bare PID lookup", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const pidFile = path.join(os.tmpdir(), `codex-status-stop-success-${process.pid}.pid`);
  fs.writeFileSync(pidFile, "4242", "ascii");
  try {
    const script =
      `Import-Module '${escaped}' -Force; ` +
      `$global:queries = 0; $global:terminated = 0; ` +
      `function global:Stop-Process { throw 'bare PID termination is forbidden' }; ` +
      `function global:Get-CimInstance { param([string]$ClassName, [string]$Filter) ` +
      `$global:queries++; if ($ClassName -ne 'Win32_Process' -or $Filter -ne 'ProcessId = 4242') { throw 'unexpected query' }; ` +
      `[pscustomobject]@{ ProcessId = 4242; CommandLine = '"node.exe" "C:\\app\\server.js"' } }; ` +
      `function global:Invoke-CimMethod { param($InputObject, $MethodName) if ($InputObject.ProcessId -ne 4242 -or $MethodName -ne 'Terminate') { throw 'unexpected termination' }; $global:terminated++; [pscustomobject]@{ ReturnValue = 0 } }; ` +
      `[string]((Stop-OwnedProcessFromPidFile -PidFile '${pidFile.replace(/'/g, "''")}' -ExpectedCommandLineFragments @('node.exe', 'C:\\app\\server.js')).Status); ` +
      `"$global:queries|$global:terminated"`;
    assert.deepEqual(powershell(script).split(/\r?\n/), ["Terminated", "1|1"]);
  } finally {
    fs.rmSync(pidFile, { force: true });
  }
});

test("newest tunnel URL follows the newest valid log file timestamp", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-status-logs-"));
  const outputLog = path.join(directory, "tunnel.out.log");
  const errorLog = path.join(directory, "tunnel.err.log");
  fs.writeFileSync(outputLog, "https://new.trycloudflare.com", "utf8");
  fs.writeFileSync(errorLog, "https://old.trycloudflare.com", "utf8");
  fs.utimesSync(outputLog, new Date("2026-08-01T00:00:20Z"), new Date("2026-08-01T00:00:20Z"));
  fs.utimesSync(errorLog, new Date("2026-08-01T00:00:10Z"), new Date("2026-08-01T00:00:10Z"));
  try {
    const output = powershell(
      `Import-Module '${escaped}' -Force; ` +
        `Get-NewestTunnelUrlFromLogFiles -OutputLog '${outputLog.replace(/'/g, "''")}' -ErrorLog '${errorLog.replace(/'/g, "''")}'`
    );
    assert.equal(output, "https://new.trycloudflare.com");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("public failure transition rotates only on the third consecutive failure", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const script =
    `Import-Module '${escaped}' -Force; ` +
    `$state = [pscustomobject]@{ PublicFailures = 0; LastPublishedUrl = $null }; $global:rotations = 0; $global:publishes = 0; ` +
    `$publish = { param($url) $global:publishes++; $true }; $rotate = { $global:rotations++; $true }; ` +
    `1..3 | ForEach-Object { $result = Invoke-PublicStatusTransition -State $state -TunnelUrl 'https://new.trycloudflare.com' -PublicStatusHealthy $false -PublishTunnel $publish -RotateTunnel $rotate; $state = $result.State; "$($state.PublicFailures)|$global:rotations|$global:publishes" }`;
  assert.deepEqual(powershell(script).split(/\r?\n/), ["1|0|0", "2|0|0", "0|1|0"]);
});

test("public success resets failures and publishes only changed URLs after a successful publisher exit", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const script =
    `Import-Module '${escaped}' -Force; ` +
    `$state = [pscustomobject]@{ PublicFailures = 2; LastPublishedUrl = 'https://old.trycloudflare.com' }; $global:publishes = 0; ` +
    `$publish = { param($url) $global:publishes++; $true }; $rotate = { throw 'must not rotate' }; ` +
    `$result = Invoke-PublicStatusTransition -State $state -TunnelUrl 'https://new.trycloudflare.com' -PublicStatusHealthy $true -PublishTunnel $publish -RotateTunnel $rotate; $state = $result.State; "$($state.PublicFailures)|$($state.LastPublishedUrl)|$global:publishes|$($result.PublicationSucceeded)"; ` +
    `$result = Invoke-PublicStatusTransition -State $state -TunnelUrl 'https://new.trycloudflare.com' -PublicStatusHealthy $true -PublishTunnel $publish -RotateTunnel $rotate; $state = $result.State; "$($state.PublicFailures)|$($state.LastPublishedUrl)|$global:publishes|$($result.PublicationAttempted)"; ` +
    `$failedPublish = { param($url) $global:publishes++; $false }; $result = Invoke-PublicStatusTransition -State $state -TunnelUrl 'https://failed.trycloudflare.com' -PublicStatusHealthy $true -PublishTunnel $failedPublish -RotateTunnel $rotate; $state = $result.State; "$($state.LastPublishedUrl)|$global:publishes|$($result.PublicationSucceeded)"`;
  assert.deepEqual(powershell(script).split(/\r?\n/), [
    "0|https://new.trycloudflare.com|1|True",
    "0|https://new.trycloudflare.com|1|False",
    "https://new.trycloudflare.com|2|False",
  ]);
});

test("publisher process timeout and nonzero exit remain unpublished and bounded", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const script =
    `Import-Module '${escaped}' -Force; ` +
    `$timeoutProcess = [pscustomobject]@{ ExitCode = 0; Killed = 0; Disposed = 0; Waits = 0 }; ` +
    `$timeoutProcess | Add-Member ScriptMethod WaitForExit { param($timeout) $this.Waits++; if ($null -eq $timeout) { return $true }; return $false }; ` +
    `$timeoutProcess | Add-Member ScriptMethod Kill { $this.Killed++ }; ` +
    `$timeoutProcess | Add-Member ScriptMethod Dispose { $this.Disposed++ }; ` +
    `$failureProcess = [pscustomobject]@{ ExitCode = 17; Killed = 0; Disposed = 0; Waits = 0 }; ` +
    `$failureProcess | Add-Member ScriptMethod WaitForExit { param($timeout) $this.Waits++; return $true }; ` +
    `$failureProcess | Add-Member ScriptMethod Kill { $this.Killed++ }; ` +
    `$failureProcess | Add-Member ScriptMethod Dispose { $this.Disposed++ }; ` +
    `$global:nextProcess = $timeoutProcess; ` +
    `function global:Start-Process { [CmdletBinding()] param([string]$FilePath, [string[]]$ArgumentList, [string]$WorkingDirectory, [string]$WindowStyle, [switch]$PassThru) $global:nextProcess }; ` +
    `$timedOut = Invoke-EndpointPublisherProcess -NodePath 'C:\\node.exe' -PublisherPath 'C:\\app path\\endpoint-registry.js' -TunnelUrl 'https://new.trycloudflare.com' -WorkingDirectory 'C:\\app path' -TimeoutMilliseconds 25; ` +
    `"$($timedOut.Status)|$($timedOut.Succeeded)|$($timeoutProcess.Killed)|$($timeoutProcess.Waits)|$($timeoutProcess.Disposed)"; ` +
    `$global:nextProcess = $failureProcess; ` +
    `$failed = Invoke-EndpointPublisherProcess -NodePath 'C:\\node.exe' -PublisherPath 'C:\\app path\\endpoint-registry.js' -TunnelUrl 'https://new.trycloudflare.com' -WorkingDirectory 'C:\\app path' -TimeoutMilliseconds 25; ` +
    `"$($failed.Status)|$($failed.Succeeded)|$($failed.ExitCode)|$($failureProcess.Killed)|$($failureProcess.Disposed)"`;

  assert.deepEqual(powershell(script).split(/\r?\n/), [
    "TimedOut|False|1|2|1",
    "Failed|False|17|0|1",
  ]);
});

test("external failure backoff progresses to sixty seconds and resets on success", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const script =
    `Import-Module '${escaped}' -Force; ` +
    `$state = [pscustomobject]@{ ExternalFailures = 0 }; ` +
    `1..6 | ForEach-Object { $delay = Update-WatchdogBackoff -State $state -Succeeded $false -BaseDelaySeconds 10; "$delay|$($state.ExternalFailures)" }; ` +
    `$delay = Update-WatchdogBackoff -State $state -Succeeded $true -BaseDelaySeconds 10; "$delay|$($state.ExternalFailures)"; ` +
    `$delay = Update-WatchdogBackoff -State $state -Succeeded $false -BaseDelaySeconds 10; "$delay|$($state.ExternalFailures)"`;

  assert.deepEqual(powershell(script).split(/\r?\n/), [
    "10|1",
    "20|2",
    "40|3",
    "60|4",
    "60|5",
    "60|6",
    "10|0",
    "10|1",
  ]);
});

test("RunOnce executes without invoking the sleep action", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const script =
    `Import-Module '${escaped}' -Force; ` +
    `$global:sleeps = @(); ` +
    `$sleep = { param($seconds) $global:sleeps += $seconds }; ` +
    `$runOnceSlept = Invoke-WatchdogSleep -RunOnce -DelaySeconds 60 -SleepAction $sleep; ` +
    `$continuousSlept = Invoke-WatchdogSleep -DelaySeconds 10 -SleepAction $sleep; ` +
    `"$runOnceSlept|$continuousSlept|$($global:sleeps -join ',')"`;

  assert.equal(powershell(script), "False|True|10");
});

test("tunnel cleanup removes only exact owned tunnel logs", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-status-cleanup-"));
  const names = ["tunnel.out.log", "tunnel.err.log", "server.out.log", "server.err.log", "unrelated.log"];
  for (const name of names) fs.writeFileSync(path.join(directory, name), name, "utf8");
  try {
    const output = powershell(
      `Import-Module '${escaped}' -Force; ` +
        `Clear-OwnedTunnelLogs -StateDirectory '${directory.replace(/'/g, "''")}'; ` +
        `@('tunnel.out.log','tunnel.err.log','server.out.log','server.err.log','unrelated.log') | ForEach-Object { [string](Test-Path -LiteralPath (Join-Path '${directory.replace(/'/g, "''")}' $_)) }`
    );
    assert.deepEqual(output.split(/\r?\n/), ["False", "False", "True", "True", "True"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("minimum watchdog interval is five seconds", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const output = powershell(
    `Import-Module '${escaped}' -Force; ` +
      `Get-WatchdogIntervalSeconds -IntervalSeconds 1; Get-WatchdogIntervalSeconds -IntervalSeconds 5; Get-WatchdogIntervalSeconds -IntervalSeconds 9`
  );
  assert.deepEqual(output.split(/\r?\n/), ["5", "5", "9"]);
});

test("mutex contention returns successfully and owned mutex release is guaranteed in finally", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const script =
    `Import-Module '${escaped}' -Force; ` +
    `$contention = [pscustomobject]@{ WaitResult = $false; Released = 0; Disposed = 0 }; ` +
    `$contention | Add-Member ScriptMethod WaitOne { param($timeout) $this.WaitResult }; ` +
    `$contention | Add-Member ScriptMethod ReleaseMutex { $this.Released++ }; $contention | Add-Member ScriptMethod Dispose { $this.Disposed++ }; $global:ran = 0; $global:logged = 0; ` +
    `$result = Invoke-WatchdogMutex -Mutex $contention -OnContention { $global:logged++ } -Action { $global:ran++ }; "$result|$global:ran|$global:logged|$($contention.Released)|$($contention.Disposed)"; ` +
    `$owned = [pscustomobject]@{ WaitResult = $true; Released = 0; Disposed = 0 }; ` +
    `$owned | Add-Member ScriptMethod WaitOne { param($timeout) $this.WaitResult }; ` +
    `$owned | Add-Member ScriptMethod ReleaseMutex { $this.Released++ }; $owned | Add-Member ScriptMethod Dispose { $this.Disposed++ }; ` +
    `try { Invoke-WatchdogMutex -Mutex $owned -OnContention {} -Action { throw 'iteration failure' } | Out-Null } catch {}; "$($owned.Released)|$($owned.Disposed)"`;
  assert.deepEqual(powershell(script).split(/\r?\n/), ["False|0|1|0|1", "1|1"]);
});

test("nonzero and throwing termination retain the owned PID and report hard failure", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const pidFile = path.join(os.tmpdir(), `codex-status-stop-failure-${process.pid}.pid`);
  fs.writeFileSync(pidFile, "4242", "ascii");
  try {
    const script =
      `Import-Module '${escaped}' -Force; ` +
      `function global:Get-CimInstance { [pscustomobject]@{ ProcessId = 4242; CommandLine = '"node.exe" "C:\\app\\server.js"' } }; ` +
      `function global:Invoke-CimMethod { [pscustomobject]@{ ReturnValue = 5 } }; ` +
      `$first = (Stop-OwnedProcessFromPidFile -PidFile '${pidFile.replace(/'/g, "''")}' -ExpectedCommandLineFragments @('node.exe', 'C:\\app\\server.js')).Status; "$first|$(Test-Path -LiteralPath '${pidFile.replace(/'/g, "''")}')"; ` +
      `function global:Invoke-CimMethod { throw 'access denied' }; ` +
      `$second = (Stop-OwnedProcessFromPidFile -PidFile '${pidFile.replace(/'/g, "''")}' -ExpectedCommandLineFragments @('node.exe', 'C:\\app\\server.js')).Status; "$second|$(Test-Path -LiteralPath '${pidFile.replace(/'/g, "''")}')"`;
    assert.deepEqual(powershell(script).split(/\r?\n/), ["TerminationFailed|True", "TerminationFailed|True"]);
  } finally {
    fs.rmSync(pidFile, { force: true });
  }
});

test("server recovery retains ownership and suppresses replacement after termination failure", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const pidFile = path.join(os.tmpdir(), `codex-status-server-recovery-${process.pid}.pid`);
  fs.writeFileSync(pidFile, "4242", "ascii");
  try {
    const script =
      `Import-Module '${escaped}' -Force; $global:clears = 0; $global:starts = 0; ` +
      `$result = Invoke-OwnedProcessReplacement -StopOwned { [pscustomobject]@{ Status = 'TerminationFailed' } } -ClearPid { $global:clears++; Remove-Item -LiteralPath '${pidFile.replace(/'/g, "''")}' -Force } -StartReplacement { $global:starts++ }; ` +
      `"$($result.ReplacementStarted)|$($result.TerminationFailed)|$global:clears|$global:starts|$(Test-Path -LiteralPath '${pidFile.replace(/'/g, "''")}')"`;
    assert.deepEqual(powershell(script).split(/\r?\n/), ["False|True|0|0|True"]);
  } finally {
    fs.rmSync(pidFile, { force: true });
  }
});

test("installer describes the exact current-user task without mutating Task Scheduler", () => {
  const installerPath = path.join(
    root,
    "scripts",
    "install-codex-status-watchdog.ps1"
  );
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      installerPath,
      "-Describe",
    ],
    { cwd: root, encoding: "utf8", windowsHide: true }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const descriptor = JSON.parse(result.stdout);
  assert.equal(descriptor.taskName, "CodexStatusLightWatchdog");
  assert.equal(descriptor.trigger, "AtLogOn");
  assert.equal(descriptor.restartIntervalMinutes, 1);
  assert.equal(descriptor.restartCount, 999);
  assert.match(descriptor.arguments, /codex-status-watchdog\.ps1/);
});

test("installer describe mode never calls Task Scheduler cmdlets", () => {
  const installerPath = path.join(root, "scripts", "install-codex-status-watchdog.ps1");
  const escapedInstallerPath = installerPath.replace(/'/g, "''");
  const output = runInstallerHarness(`
function global:Start-Process { throw 'configuration or auth preflight in Describe' }
function global:Get-ScheduledTask { throw 'scheduler mutation in Describe' }
function global:New-ScheduledTaskAction { throw 'scheduler mutation in Describe' }
function global:New-ScheduledTaskTrigger { throw 'scheduler mutation in Describe' }
function global:New-ScheduledTaskSettingsSet { throw 'scheduler mutation in Describe' }
function global:New-ScheduledTaskPrincipal { throw 'scheduler mutation in Describe' }
function global:Register-ScheduledTask { throw 'scheduler mutation in Describe' }
function global:Start-ScheduledTask { throw 'scheduler mutation in Describe' }
function global:Unregister-ScheduledTask { throw 'scheduler mutation in Describe' }
. '${escapedInstallerPath}' -Describe
`);
  const descriptor = JSON.parse(output);
  assert.equal(descriptor.taskName, "CodexStatusLightWatchdog");
  assert.equal(descriptor.trigger, "AtLogOn");
});

test("installer registers the exact task descriptor after configuration check", () => {
  const installerPath = path.join(root, "scripts", "install-codex-status-watchdog.ps1");
  const escapedInstallerPath = installerPath.replace(/'/g, "''");
  const output = runInstallerHarness(`
$global:events = @()
function global:Start-Process {
  param([string]$FilePath, [string[]]$ArgumentList, [switch]$Wait, [switch]$PassThru, [string]$WindowStyle)
  $global:events += 'check'
  $global:check = [ordered]@{ FilePath = $FilePath; Arguments = @($ArgumentList); Wait = [bool]$Wait; PassThru = [bool]$PassThru }
  [pscustomobject]@{ ExitCode = 0 }
}
function global:New-ScheduledTaskAction {
  param([string]$Execute, [string]$Argument)
  $global:events += 'action'
  [pscustomobject]@{ Execute = $Execute; Argument = $Argument }
}
function global:New-ScheduledTaskTrigger {
  param([switch]$AtLogOn, [string]$User)
  $global:events += 'trigger'
  [pscustomobject]@{ AtLogOn = [bool]$AtLogOn; User = $User }
}
function global:New-ScheduledTaskSettingsSet {
  param(
    [switch]$AllowStartIfOnBatteries,
    [switch]$DontStopIfGoingOnBatteries,
    [TimeSpan]$RestartInterval,
    [int]$RestartCount,
    [TimeSpan]$ExecutionTimeLimit
  )
  $global:events += 'settings'
  [pscustomobject]@{
    AllowStartIfOnBatteries = [bool]$AllowStartIfOnBatteries
    DontStopIfGoingOnBatteries = [bool]$DontStopIfGoingOnBatteries
    RestartIntervalMinutes = $RestartInterval.TotalMinutes
    RestartCount = $RestartCount
    ExecutionTimeLimitSeconds = $ExecutionTimeLimit.TotalSeconds
  }
}
function global:New-ScheduledTaskPrincipal {
  param([string]$UserId, [string]$LogonType, [string]$RunLevel)
  $global:events += 'principal'
  [pscustomobject]@{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel }
}
function global:Register-ScheduledTask {
  param([string]$TaskName, $Action, $Trigger, $Settings, $Principal, [switch]$Force)
  $global:events += 'register'
  $global:registration = [ordered]@{
    TaskName = $TaskName
    Force = [bool]$Force
    Execute = $Action.Execute
    Argument = $Action.Argument
    Trigger = $Trigger
    Settings = $Settings
    Principal = $Principal
  }
}
function global:Start-ScheduledTask {
  param([string]$TaskName)
  $global:events += 'start'
  $global:startTaskName = $TaskName
}
. '${escapedInstallerPath}' -StartNow
[ordered]@{ Events = $global:events; Check = $global:check; Registration = $global:registration; StartTaskName = $global:startTaskName } | ConvertTo-Json -Compress -Depth 8
`);
  const result = JSON.parse(output);
  assert.deepEqual(result.Events, ["check", "action", "trigger", "settings", "principal", "register", "start"]);
  assert.equal(result.Check.Arguments[result.Check.Arguments.length - 1], "-CheckConfiguration");
  assert.equal(result.Check.Wait, true);
  assert.equal(result.Check.PassThru, true);
  assert.equal(result.Registration.TaskName, "CodexStatusLightWatchdog");
  assert.equal(result.Registration.Force, true);
  assert.match(result.Registration.Execute.toLowerCase(), /powershell\.exe$/);
  assert.equal(result.Registration.Argument, `-NoProfile -ExecutionPolicy Bypass -File "${path.join(root, "scripts", "codex-status-watchdog.ps1")}"`);
  assert.equal(result.Registration.Trigger.AtLogOn, true);
  assert.equal(result.Registration.Trigger.User, process.env.USERNAME);
  assert.equal(result.Registration.Settings.AllowStartIfOnBatteries, true);
  assert.equal(result.Registration.Settings.DontStopIfGoingOnBatteries, true);
  assert.equal(result.Registration.Settings.RestartIntervalMinutes, 1);
  assert.equal(result.Registration.Settings.RestartCount, 999);
  assert.equal(result.Registration.Settings.ExecutionTimeLimitSeconds, 0);
  assert.equal(result.Registration.Principal.LogonType, "Interactive");
  assert.equal(result.Registration.Principal.RunLevel, "Limited");
  assert.match(result.Registration.Principal.UserId, new RegExp(`${process.env.USERNAME}$`, "i"));
  assert.equal(result.StartTaskName, "CodexStatusLightWatchdog");
});

test("installer uses Force for repeated registrations without creating another task name", () => {
  const installerPath = path.join(root, "scripts", "install-codex-status-watchdog.ps1");
  const escapedInstallerPath = installerPath.replace(/'/g, "''");
  const output = runInstallerHarness(`
$global:registrations = @()
function global:Start-Process { param([string]$FilePath, [string[]]$ArgumentList, [switch]$Wait, [switch]$PassThru, [string]$WindowStyle) [pscustomobject]@{ ExitCode = 0 } }
function global:New-ScheduledTaskAction { param([string]$Execute, [string]$Argument) [pscustomobject]@{ Execute = $Execute; Argument = $Argument } }
function global:New-ScheduledTaskTrigger { param([switch]$AtLogOn, [string]$User) [pscustomobject]@{ AtLogOn = [bool]$AtLogOn; User = $User } }
function global:New-ScheduledTaskSettingsSet { param([switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, [TimeSpan]$RestartInterval, [int]$RestartCount, [TimeSpan]$ExecutionTimeLimit) [pscustomobject]@{} }
function global:New-ScheduledTaskPrincipal { param([string]$UserId, [string]$LogonType, [string]$RunLevel) [pscustomobject]@{} }
function global:Register-ScheduledTask { param([string]$TaskName, $Action, $Trigger, $Settings, $Principal, [switch]$Force) $global:registrations += [pscustomobject]@{ TaskName = $TaskName; Force = [bool]$Force } }
. '${escapedInstallerPath}'
. '${escapedInstallerPath}'
$global:registrations | ConvertTo-Json -Compress
`);
  const registrations = JSON.parse(output);
  assert.deepEqual(registrations, [
    { TaskName: "CodexStatusLightWatchdog", Force: true },
    { TaskName: "CodexStatusLightWatchdog", Force: true },
  ]);
});

test("installer stops before registration with actionable auth guidance when preflight fails", () => {
  const installerPath = path.join(root, "scripts", "install-codex-status-watchdog.ps1");
  const escapedInstallerPath = installerPath.replace(/'/g, "''");
  const output = runInstallerHarness(`
$global:events = @()
function global:Start-Process { $global:events += 'check'; [pscustomobject]@{ ExitCode = 17 } }
function global:New-ScheduledTaskAction { throw 'registration was attempted after failed configuration' }
try { . '${escapedInstallerPath}' } catch { $global:errorMessage = $_.Exception.Message }
[ordered]@{ Events = $global:events; Error = $global:errorMessage } | ConvertTo-Json -Compress
`);
  const result = JSON.parse(output);
  assert.deepEqual(result.Events, ["check"]);
  assert.match(result.Error, /configuration check failed with exit code 17/);
  assert.match(result.Error, /gh auth status/);
  assert.match(result.Error, /GH_TOKEN/);
});

test("installer uninstalls only an existing exact task name", () => {
  const installerPath = path.join(root, "scripts", "install-codex-status-watchdog.ps1");
  const escapedInstallerPath = installerPath.replace(/'/g, "''");
  const output = runInstallerHarness(`
$global:getNames = @()
$global:unregisterNames = @()
function global:Get-ScheduledTask {
  param([string]$TaskName)
  $global:getNames += $TaskName
  if ($global:getNames.Count -eq 1) {
    return @([pscustomobject]@{ TaskName = 'OtherTask' }, [pscustomobject]@{ TaskName = 'CodexStatusLightWatchdog' })
  }
  return @([pscustomobject]@{ TaskName = 'CodexStatusLightWatchdogBackup' })
}
function global:Unregister-ScheduledTask { param([string]$TaskName, [switch]$Confirm) $global:unregisterNames += $TaskName }
. '${escapedInstallerPath}' -Uninstall
. '${escapedInstallerPath}' -Uninstall
[ordered]@{ GetNames = $global:getNames; UnregisterNames = $global:unregisterNames } | ConvertTo-Json -Compress
`);
  const result = JSON.parse(output);
  assert.deepEqual(result.GetNames, ["CodexStatusLightWatchdog", "CodexStatusLightWatchdog"]);
  assert.deepEqual(result.UnregisterNames, ["CodexStatusLightWatchdog"]);
});

test("failed tunnel rotation retains ownership and the third public failure state", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const pidFile = path.join(os.tmpdir(), `codex-status-tunnel-rotation-${process.pid}.pid`);
  fs.writeFileSync(pidFile, "4242", "ascii");
  try {
    const script =
      `Import-Module '${escaped}' -Force; $global:clears = 0; ` +
      `$state = [pscustomobject]@{ PublicFailures = 2; LastPublishedUrl = $null }; $publish = { throw 'must not publish' }; ` +
      `$rotate = { (Invoke-OwnedProcessRetirement -StopOwned { [pscustomobject]@{ Status = 'TerminationFailed' } } -ClearPid { $global:clears++; Remove-Item -LiteralPath '${pidFile.replace(/'/g, "''")}' -Force }).Succeeded }; ` +
      `$result = Invoke-PublicStatusTransition -State $state -TunnelUrl 'https://new.trycloudflare.com' -PublicStatusHealthy $false -PublishTunnel $publish -RotateTunnel $rotate; ` +
      `"$($result.State.PublicFailures)|$($result.RotationRequested)|$($result.RotationFailed)|$global:clears|$(Test-Path -LiteralPath '${pidFile.replace(/'/g, "''")}')"`;
    assert.deepEqual(powershell(script).split(/\r?\n/), ["3|False|True|0|True"]);
  } finally {
    fs.rmSync(pidFile, { force: true });
  }
});
