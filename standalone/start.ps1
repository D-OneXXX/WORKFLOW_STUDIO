$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    & node standalone/build.mjs
    if ($LASTEXITCODE -ne 0) { throw '独立版构建失败' }
    & node standalone/server.mjs
    if ($LASTEXITCODE -ne 0) { throw '独立服务退出异常' }
} finally {
    Pop-Location
}
