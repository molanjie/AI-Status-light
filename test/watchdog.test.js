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
      `[string](Test-ExpectedCommandLine '"node.exe" C:\\other\\server.js' @('node.exe','C:\\app\\server.js'))`
  ).split(/\r?\n/);
  assert.deepEqual(output, ["True", "False"]);
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
    { cwd: root, encoding: "utf8", windowsHide: true }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
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

test("configuration check does not create the watchdog state directory", () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-status-config-"));
  try {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", watchdogPath, "-CheckConfiguration"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, LOCALAPPDATA: stateRoot },
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
      `[string](Stop-OwnedProcessFromPidFile -PidFile '${pidFile.replace(/'/g, "''")}' -ExpectedCommandLineFragments @('node.exe', 'C:\\app\\server.js')); ` +
      `"$global:queries|$global:terminated"`;
    assert.deepEqual(powershell(script).split(/\r?\n/), ["False", "1|0"]);
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
      `[string](Stop-OwnedProcessFromPidFile -PidFile '${pidFile.replace(/'/g, "''")}' -ExpectedCommandLineFragments @('node.exe', 'C:\\app\\server.js')); ` +
      `"$global:queries|$global:terminated"`;
    assert.deepEqual(powershell(script).split(/\r?\n/), ["True", "1|1"]);
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
