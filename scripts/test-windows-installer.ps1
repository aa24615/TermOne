$ErrorActionPreference = 'Stop'
$version = (Get-Content apps/desktop/src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).version
$installer = (Resolve-Path "release-assets/TermOne_${version}_windows_x64-setup.exe").Path
$destination = Join-Path $env:RUNNER_TEMP 'TermOne-installer-smoke'
if (Test-Path $destination) { throw "测试安装目录已存在：$destination" }
try {
    $process = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$destination") -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "NSIS 静默安装失败：$($process.ExitCode)" }
    $application = Join-Path $destination 'termone.exe'
    if (!(Test-Path $application)) { throw '安装后未找到 termone.exe' }
    $actual = (Get-Item $application).VersionInfo.ProductVersion
    if ($actual -ne $version -and $actual -ne "$version.0") { throw "已安装应用版本错误：$actual" }
    Write-Host "NSIS 安装成功，已安装应用版本：$actual"
} finally {
    $uninstaller = Join-Path $destination 'uninstall.exe'
    if (Test-Path $uninstaller) {
        $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "测试应用卸载失败：$($process.ExitCode)" }
    }
}
