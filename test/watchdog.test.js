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

test("watchdog resets public failures on success and rotates only at the third failure", () => {
  const source = fs.readFileSync(watchdogPath, "utf8");
  assert.match(
    source,
    /elseif \(Test-HttpEndpoint -Url \(\$tunnelUrl \+ '\/api\/status'\) -TimeoutSeconds 5\) \{\s+\$publicFailures = 0/s
  );
  assert.match(source, /if \(\$publicFailures -ge 3\) \{/);
  assert.match(source, /Clear-ExactFile -Path \$tunnelPidFile\s+\$publicFailures = 0/s);
});
