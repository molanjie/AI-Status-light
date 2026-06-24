$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Tools = Join-Path $Root '.tools'
$Downloads = Join-Path $Tools 'downloads'
$JdkHomeRoot = Join-Path $Tools 'jdk'
$GradleRoot = Join-Path $Tools 'gradle'
$SdkRoot = Join-Path $Tools 'android-sdk'

$JdkZipUrl = 'https://aka.ms/download-jdk/microsoft-jdk-17-windows-x64.zip'
$GradleZipUrl = 'https://services.gradle.org/distributions/gradle-8.10.2-bin.zip'
$AndroidToolsUrl = 'https://dl.google.com/android/repository/commandlinetools-win-14742923_latest.zip'

New-Item -ItemType Directory -Force -Path $Downloads, $JdkHomeRoot, $GradleRoot, $SdkRoot | Out-Null

function Test-ZipFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
    $zip.Dispose()
    return $true
  }
  catch {
    return $false
  }
}

function Download-File {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Path
  )
  if (Test-Path $Path) {
    if ($Path.ToLowerInvariant().EndsWith('.zip') -and -not (Test-ZipFile -Path $Path)) {
      Write-Output "[bad zip] removing $Path"
      Remove-Item -LiteralPath $Path -Force
    }
    else {
      Write-Output "[skip] $Path"
      return
    }
  }
  Write-Output "[download] $Url"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $tmp = "$Path.part"
  if (Test-Path $tmp) {
    Remove-Item -LiteralPath $tmp -Force
  }

  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    & curl.exe -L --fail --retry 8 --retry-delay 3 --connect-timeout 30 -o $tmp $Url
    if ($LASTEXITCODE -ne 0) {
      throw "curl failed with exit code $LASTEXITCODE for $Url"
    }
  }
  else {
    Invoke-WebRequest -Uri $Url -OutFile $tmp
  }

  Move-Item -LiteralPath $tmp -Destination $Path -Force
  if ($Path.ToLowerInvariant().EndsWith('.zip') -and -not (Test-ZipFile -Path $Path)) {
    Remove-Item -LiteralPath $Path -Force
    throw "Downloaded zip is corrupt: $Path"
  }
}

function Find-FirstFile {
  param(
    [Parameter(Mandatory = $true)][string]$RootPath,
    [Parameter(Mandatory = $true)][string]$Filter
  )
  $item = Get-ChildItem -Path $RootPath -Recurse -Filter $Filter -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $item) {
    throw "Cannot find $Filter under $RootPath"
  }
  return $item.FullName
}

function Ensure-Jdk {
  $java = Get-ChildItem -Path $JdkHomeRoot -Recurse -Filter java.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like '*\bin\java.exe' } |
    Select-Object -First 1
  if ($java) {
    return Split-Path -Parent (Split-Path -Parent $java.FullName)
  }

  $zip = Join-Path $Downloads 'microsoft-jdk-17-windows-x64.zip'
  Download-File -Url $JdkZipUrl -Path $zip
  Write-Output "[extract] JDK"
  Expand-Archive -Path $zip -DestinationPath $JdkHomeRoot -Force

  $java = Find-FirstFile -RootPath $JdkHomeRoot -Filter 'java.exe'
  return Split-Path -Parent (Split-Path -Parent $java)
}

function Ensure-Gradle {
  $gradle = Get-ChildItem -Path $GradleRoot -Recurse -Filter gradle.bat -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($gradle) {
    return $gradle.FullName
  }

  $zip = Join-Path $Downloads 'gradle-8.10.2-bin.zip'
  Download-File -Url $GradleZipUrl -Path $zip
  Write-Output "[extract] Gradle"
  Expand-Archive -Path $zip -DestinationPath $GradleRoot -Force

  return Find-FirstFile -RootPath $GradleRoot -Filter 'gradle.bat'
}

function Ensure-Android-Tools {
  $sdkmanager = Join-Path $SdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'
  if (Test-Path $sdkmanager) {
    return $sdkmanager
  }

  $zip = Join-Path $Downloads 'commandlinetools-win_latest.zip'
  $extract = Join-Path $Tools 'cmdline-tools-extract'
  $latest = Join-Path $SdkRoot 'cmdline-tools\latest'

  Download-File -Url $AndroidToolsUrl -Path $zip
  if (Test-Path $extract) {
    Remove-Item -LiteralPath $extract -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $extract | Out-Null
  Write-Output "[extract] Android command line tools"
  Expand-Archive -Path $zip -DestinationPath $extract -Force

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $latest) | Out-Null
  if (Test-Path $latest) {
    Remove-Item -LiteralPath $latest -Recurse -Force
  }
  Move-Item -LiteralPath (Join-Path $extract 'cmdline-tools') -Destination $latest
  Remove-Item -LiteralPath $extract -Recurse -Force

  if (-not (Test-Path $sdkmanager)) {
    throw "sdkmanager not found after extract: $sdkmanager"
  }
  return $sdkmanager
}

$JdkHome = Ensure-Jdk
$GradleBat = Ensure-Gradle
$SdkManager = Ensure-Android-Tools

$env:JAVA_HOME = $JdkHome
$env:ANDROID_HOME = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot
$env:Path = "$JdkHome\bin;$SdkRoot\platform-tools;$env:Path"

Write-Output "[java] $JdkHome"
Write-Output "[gradle] $GradleBat"
Write-Output "[sdk] $SdkRoot"

Write-Output "[licenses] accepting Android SDK licenses"
$yes = ("y`n" * 120)
$yes | & $SdkManager "--sdk_root=$SdkRoot" "--licenses" | Out-Host

Write-Output "[sdkmanager] installing required packages"
& $SdkManager "--sdk_root=$SdkRoot" "platform-tools" "platforms;android-35" "build-tools;35.0.0"

Write-Output "[gradle] building APK"
& $GradleBat -p $Root ":app:assembleDebug" --no-daemon --stacktrace

$Apk = Join-Path $Root 'app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path $Apk)) {
  throw "APK not found after build: $Apk"
}

$OutApk = Join-Path $Root 'MiniWatchCodex-debug.apk'
Copy-Item -LiteralPath $Apk -Destination $OutApk -Force

Write-Output "[OK] APK built: $OutApk"
