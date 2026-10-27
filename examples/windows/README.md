# Windows 示例

`setup.ps1` 做四件事：检查 Node ≥ 22 → 在数据目录下建好全部子目录 → 复制示例配置与模板（含默认人设文件，不覆盖已有文件）→ 打印下一步（控制台新手向导流程）。

> 脚本只复制文件、**不激活人设**（插件首次启动会自动投递默认人设）；想要「建目录 + 配置 + 自动投递」一步到位，用跨平台 CLI：
> `node bin\dsh-onebot-qq.mjs init --data-dir <dataDir>`（也无需这样做：插件首次启动会自动投递默认人设）。

```powershell
# 默认数据目录：%USERPROFILE%\.dsh\dsh-onebot-qq（有 DSH_HOME 时用 %DSH_HOME%\dsh-onebot-qq）
powershell -ExecutionPolicy Bypass -File .\examples\windows\setup.ps1

# 自定义数据目录
powershell -ExecutionPolicy Bypass -File .\examples\windows\setup.ps1 -DataDir 'C:\dsh-data\onebot-qq'

# 覆盖已有 config.json（谨慎：会冲掉你的配置）
powershell -ExecutionPolicy Bypass -File .\examples\windows\setup.ps1 -Force
```

完整步骤（协议端配置、路径写法、真机验证清单）见 [`docs/Windows安装.md`](../../docs/Windows安装.md)。

> 脚本只是便利工具：任何一步失败都可以手动做（建目录、复制 `examples/qq-lines` 与 `examples/personas`、把 `examples/config.example.json` 复制成 `<dataDir>\config.json`）。也可以直接用跨平台 CLI：`node bin/dsh-onebot-qq.mjs init --data-dir <dataDir>`。
