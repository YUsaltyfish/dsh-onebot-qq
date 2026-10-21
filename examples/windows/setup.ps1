# dsh-onebot-qq · Windows 初始化脚本（PowerShell 5.1+ / 7+）
#
# 做四件事：检查 Node 版本 → 建数据目录 → 复制示例配置/默认人设模板（不覆盖已有的）→ 打印下一步。
# 注意：本脚本只复制文件，不激活人设；激活用 `node bin\dsh-onebot-qq.mjs init`（会自动投递默认人设），
# 或启动后在控制台「总览 → 创建默认人设」一键投递。
# 不写死任何用户路径、不写入口令、不改系统设置。可重复运行（幂等）。
#
# 用法（在包根目录，或任意位置用绝对路径调用）：
#   powershell -ExecutionPolicy Bypass -File .\examples\windows\setup.ps1
#   powershell -ExecutionPolicy Bypass -File .\examples\windows\setup.ps1 -DataDir 'C:\dsh-data\onebot-qq'
#
# 参数：
#   -DataDir <路径>   数据目录。默认 $env:DSH_HOME\dsh-onebot-qq，没有 DSH_HOME 时用 $env:USERPROFILE\.dsh\dsh-onebot-qq
#   -Force            覆盖已存在的 config.json（默认保留，避免冲掉你的配置）
#   -SkipNodeCheck    跳过 Node 版本检查（例如已确认版本，只是补目录）

[CmdletBinding()]
param(
    [string]$DataDir = '',
    [switch]$Force,
    [switch]$SkipNodeCheck
)

$ErrorActionPreference = 'Stop'
$PackageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ExamplesDir = Join-Path $PackageRoot 'examples'

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  [ok] $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "  [!!] $text" -ForegroundColor Yellow }

# ── 1. 平台与 Node 版本 ─────────────────────────────────────────────
Write-Step '检查环境'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    throw ' 没有找到 node。请先安装 Node.js 22 LTS（https://nodejs.org/），重开终端后再运行本脚本。'
}
$nodeVersion = (& node --version).Trim()
$nodeMajor = [int](($nodeVersion -replace '^v', '') -split '\.')[0]
if ($nodeMajor -lt 22 -and -not $SkipNodeCheck) {
    throw " Node 版本过旧：$nodeVersion（需要 >= 22）。请升级后重试；确定要继续时加 -SkipNodeCheck。"
}
Write-Ok "node $nodeVersion"

# ── 2. 数据目录 ─────────────────────────────────────────────────────
Write-Step '创建数据目录'
if ([string]::IsNullOrWhiteSpace($DataDir)) {
    if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
        $DataDir = Join-Path $env:USERPROFILE '.dsh\dsh-onebot-qq'
    } else {
        $DataDir = Join-Path $env:DSH_HOME 'dsh-onebot-qq'
    }
}
$DataDir = [System.IO.Path]::GetFullPath($DataDir)
Write-Ok "dataDir = $DataDir"

$subDirs = @(
    'workspace', 'personas', 'qq-stickers', 'qq-memory', 'qq-welcome-images',
    'qq_uploads', 'qq-refs', 'qq_avatars', 'logs\qq_chat', 'state'
)
foreach ($sub in $subDirs) {
    $full = Join-Path $DataDir $sub
    if (-not (Test-Path -LiteralPath $full)) {
        New-Item -ItemType Directory -Path $full -Force | Out-Null
    }
}
Write-Ok ("子目录就绪（" + $subDirs.Count + " 个）")

# ── 3. 示例文件（不覆盖已有内容） ───────────────────────────────────
Write-Step '复制示例文件'
$copied = 0
$skipped = 0

function Copy-TreeIfMissing([string]$From, [string]$To) {
    if (-not (Test-Path -LiteralPath $From)) { return }
    Get-ChildItem -LiteralPath $From -File | ForEach-Object {
        $target = Join-Path $To $_.Name
        if (Test-Path -LiteralPath $target) { $script:skipped++; return }
        Copy-Item -LiteralPath $_.FullName -Destination $target
        $script:copied++
    }
}

# qq-lines 模板 → <dataDir>\workspace
Copy-TreeIfMissing (Join-Path $ExamplesDir 'qq-lines') (Join-Path $DataDir 'workspace')

# 人设模板 → <dataDir>\personas（含共享底池 _default.lines.txt）
$personaSrc = Join-Path $ExamplesDir 'personas'
foreach ($name in @(
    '_default.lines.txt',
    'example.md', 'example.lines.txt', 'example.wake.txt',
    '默认小助手.md', '默认小助手.lines.txt', '默认小助手.wake.txt'
)) {
    $src = Join-Path $personaSrc $name
    if (-not (Test-Path -LiteralPath $src)) { continue }
    $dst = Join-Path (Join-Path $DataDir 'personas') $name
    if (Test-Path -LiteralPath $dst) { $script:skipped++; continue }
    Copy-Item -LiteralPath $src -Destination $dst
    $script:copied++
}

# 实例配置 → 交给 CLI init（adminQq=0 = 待配置模式；--force 会先备份旧配置）
$configPath = Join-Path $DataDir 'config.json'
$cli = Join-Path $PackageRoot 'bin\dsh-onebot-qq.mjs'
try {
    $initArgs = @($cli, 'init', '--data-dir', $DataDir)
    if ($Force) { $initArgs += '--force' }
    & node @initArgs | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warn2 "CLI init 退出码 $LASTEXITCODE（配置可能未写入），请手动运行：node `"$cli`" init --data-dir `"$DataDir`""
    } else {
        Write-Ok "已初始化实例配置 $configPath（adminQq=0，启动后到控制台新手向导里填）"
    }
} catch {
    Write-Warn2 "CLI init 失败（$($_.Exception.Message)），请手动运行：node `"$cli`" init --data-dir `"$DataDir`""
}
Write-Ok "新复制 $copied 个文件，跳过已存在 $skipped 个"

# ── 4. 下一步 ───────────────────────────────────────────────────────
Write-Step '下一步（推荐：控制台新手向导，不用手改 JSON）'
Write-Host @"
  1) 安装插件（已安装可跳过；tgz / 目录 / git URL 三选一）：
       dsh plugin --profile web add "$PackageRoot"
       # 或: dsh plugin --profile web add C:\path\to\dsh-onebot-qq-0.1.1.tgz
       # 或: dsh plugin --profile web add github:YUsaltyfish/dsh-onebot-qq
  2) 启动：
       dsh web
       还没填 QQ/NapCat 也能启动：插件进入「待配置模式」，控制台照常可用。
  3) 打开 设置 → QQ 控制台 →「新手向导」：
       - 填主人 QQ + NapCat 的 wsUrl/httpUrl（默认 127.0.0.1:3001 / :3000；有鉴权再填 token）
       - 点「测试 NapCat 连接」确认能连上，然后保存 → 自动连接（无需重启）
       - 群聊里 @ 机器人发一句话验证。
  4) 默认人设：控制台「总览 → 创建默认人设」一键投递；
       或命令行：node "$(Join-Path $PackageRoot 'bin\dsh-onebot-qq.mjs')" persona use 默认小助手 --data-dir "$DataDir"
  5) 无 QQ 环境先自检：
       node "$(Join-Path $PackageRoot 'bin\dsh-onebot-qq.mjs')" doctor --data-dir "$DataDir"
  6) 生图（可选）：控制台「生图」页填协议/API 地址/模型/Key，点「检查生图配置」；
       或设环境变量 QQ_IMAGEGEN_PROTOCOL / QQ_IMAGEGEN_BASE_URL / QQ_IMAGEGEN_API_KEY / QQ_IMAGEGEN_MODEL 后重启。

  安全提示：config.json 里可能有 token/API Key。Windows 上可用
  icacls "$configPath" /inheritance:r /grant:r "$env:USERNAME:(R,W)"
  收紧到仅当前用户可读写（可选；密钥也可以只放环境变量）。
"@ -ForegroundColor Gray
