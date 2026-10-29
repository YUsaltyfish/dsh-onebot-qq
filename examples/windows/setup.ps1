# dsh-onebot-qq · Windows 初始化脚本（PowerShell 5.1+ / 7+）
# 检查 Node → 委托跨平台 CLI init（建目录、保留已有模板、投递默认人设）→ 打印下一步。
# 不重复解析默认路径、不写入口令、不改系统设置。
# 用法：powershell -ExecutionPolicy Bypass -File .\examples\windows\setup.ps1 [-DataDir 'C:\dsh-data\qq-bot']
# -DataDir 仅透传显式目录；未指定时由 CLI 统一处理 DSH_QQ_DATA_DIR、DSH_HOME 与旧目录兼容。
# -Force 覆盖已有 config.json（CLI 先备份）；-SkipNodeCheck 跳过版本检查。

[CmdletBinding()]
param(
    [string]$DataDir = '',
    [switch]$Force,
    [switch]$SkipNodeCheck
)

$ErrorActionPreference = 'Stop'
$PackageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    throw '没有找到 node。请先安装 Node.js >=22，重开终端后再运行。'
}
$nodeVersion = (& node --version).Trim()
$nodeMajor = [int](($nodeVersion -replace '^v', '') -split '\.')[0]
if ($nodeMajor -lt 22 -and -not $SkipNodeCheck) {
    throw "Node 版本过旧：$nodeVersion（需要 >=22）。"
}

$cli = Join-Path $PackageRoot 'bin\dsh-onebot-qq.mjs'
$initArgs = @($cli, 'init')
if (-not [string]::IsNullOrWhiteSpace($DataDir)) { $initArgs += @('--data-dir', $DataDir) }
if ($Force) { $initArgs += '--force' }
# 保留 CLI 的实际路径、配置及人设投递结果输出；失败不继续打印成功提示。
& node @initArgs
if ($LASTEXITCODE -ne 0) { throw "CLI init 失败（退出码 $LASTEXITCODE）" }

Write-Host @"
下一步：
  1) 若尚未安装：dsh plugin --profile web add "$PackageRoot"
  2) 若指定了自定义目录，启动 DSH 前设置 DSH_QQ_DATA_DIR 为同一目录，或配置 profile patch 的 dataDir。
  3) 启动 dsh web → 设置 → QQ 控制台 → 新手向导。
     填主人 QQ、OneBot wsUrl/httpUrl 及协议端要求的 token；保存后到「运维」测试 OneBot 连接。
  4) init 已尝试投递默认人设；是否成功以以上 CLI 输出为准，不必再指定另一套人设名。
  5) 群里 @ 机器人、私聊各验证一次；无 QQ 时先运行 node "$cli" doctor --no-net（自定义目录另加 --data-dir）。
安全提示：config.json 可能含 token/API Key；请用 Windows ACL 收紧权限，勿提交到仓库。
"@ -ForegroundColor Gray
