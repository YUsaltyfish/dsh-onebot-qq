# dsh-onebot-qq

A **QQ bot plugin for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH)**, running in-process and speaking the
OneBot v11 protocol through [NapCat](https://napcat.napneko.icu/).
Microkernel + pluggable sub-plugins. Works on **Linux / Windows / macOS**, and is install-and-go once you fill in a few
fields in the console.

![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-green) ![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2-7c3aed)

> **Start here**: [docs/使用说明书.md](docs/使用说明书.md) — the user manual (install → connect → feature usage → persona
> authoring, currently in Chinese). Want DSH to install it for you? hand [docs/安装前准备.md](docs/安装前准备.md)
> to the agent.

## Features

| Capability | Details |
|---|---|
| **Native DSH plugin** | ships `dsh.bundle.patch`, one-line mount, fully in-process (no daemon/systemd) |
| **Microkernel + 9 sub-plugins** | gate/wake, commands, files, persona lines, group welcome, imagegen, link parser, stickers, group memory — auto-discovered, one failure never breaks the rest |
| **Single outbound path** | text goes through `deliver()`, media through `sendMedia()`: `[AT:]` extraction → six-step redaction → plugin decoration → send + archive |
| **QQ console** | 16 tabs, hot-reloaded config (atomic write + backup + rollback); one sub-plugin per page; misc config grouped under “Other”, each control with a hover explanation |
| **Ready-made persona** | built-in “蓝色大肥鱼” persona + `_template.md`, auto-seeded on first start; persona wake words merged with config |
| **QQ-side features** | images in/out, generation & editing (`openai-images` / `openai-chat`), avatars, sticker library, group welcome, group memory injection, optional link parsing |
| **Cross-platform** | paths, temp dirs, CQ file refs, atomic writes and persona symlink fallback all live in `platform/` |
| **No private defaults** | no real QQ numbers, tokens or server paths in the package; pack guard + secret scan |

## Requirements

| Component | Requirement |
|---|---|
| Node.js | `>= 22` |
| DSH | `>= 0.2.1-rc.2 < 0.3.0` (declared in `engines.dsh`) |
| NapCat | QQNT client + OneBot v11; **forward WebSocket** and **HTTP API** enabled |
| QQ account | used by NapCat (a spare account is recommended) |

## Install

```bash
# 1) install the plugin (pick one)
dsh plugin --profile web add github:YUsaltyfish/dsh-onebot-qq
dsh plugin --profile web add /abs/path/dsh-onebot-qq-0.1.0.tgz   # local tgz (npm pack)
dsh plugin --profile web add link:/abs/path/dsh-onebot-qq         # local dir (live edits)

# 2) create data dir + config template + default persona (first time only)
node bin/dsh-onebot-qq.mjs init

# 3) start DSH
dsh web
```

You can also install from GitHub inside the DSH desktop app: Settings → Plugins.

> **Optional**: to hide **global** tools (`ops_*`, agent-team, MCP resources) from QQ sessions as well, install the companion plugin `dsh-onebot-qq-opsgate`:
> `dsh plugin --profile web add github:YUsaltyfish/dsh-onebot-qq-opsgate` (must be installed **after** `dsh-onebot-qq`).
> Everything works without it — QQ sessions just see a larger tool surface. See [`docs/安装与卸载.md`](docs/安装与卸载.md).

## Quick start (4 steps)

1. Log in to QQ in NapCat, enable WebSocket (default `ws://127.0.0.1:3001`) and HTTP (default `http://127.0.0.1:3000`).
2. DSH Settings → “QQ console” → “NapCat connection”: fill URL/token → “Test NapCat connection”.
3. Fill **owner QQ** at the top of the “Groups” tab (required) → it connects automatically.
4. @ the bot in QQ (or DM it) → you should get a reply.

> Without `adminQq` the plugin starts in “pending config” mode: console/tools work, NapCat is not connected yet.
> Upgrading from the old name? The legacy data dir `$DSH_HOME/dsh-qq-bot` is reused automatically — no migration.

## Console at a glance

Overview · Ops · Groups · NapCat connection · Message settings · Proactive replies · Wake · Files & images · Persona
lines · Group welcome · Imagegen · Link parser · Stickers · Other (permissions/gates/dirs/avatars) · Sub-plugins · Group memory.
See [docs/使用说明书.md](docs/使用说明书.md) (Chinese) for the details.

## Persona (short version)

A persona is three files under `<dataDir>/personas/`:

- `<name>.md` — who it is and how it talks
- `<name>.lines.txt` — canned lines (poke / call ack / imagegen)
- `<name>.wake.txt` — wake words, one per line

Easiest: ask an AI to follow the bundled `personas/_template.md`. Switch with the console overview or:

```bash
node bin/dsh-onebot-qq.mjs persona use 蓝色大肥鱼
```

## Documentation

| Doc | Contents |
|---|---|
| [docs/使用说明书.md](docs/使用说明书.md) | **user manual (Chinese)** |
| [docs/安装前准备.md](docs/安装前准备.md) | the only two external prerequisites + acceptance |
| [docs/安装与卸载.md](docs/安装与卸载.md) | install / upgrade / uninstall / first configuration |
| [docs/配置参考.md](docs/配置参考.md) | every instance config key, path rules, credentials |
| [docs/Windows安装.md](docs/Windows安装.md) | Windows from zero to working |
| [docs/排错.md](docs/排错.md) | NapCat connection, missing tools, images |
| [docs/插件开发.md](docs/插件开发.md) | sub-plugin contract, `bot` capabilities, red lines |
| [docs/架构说明.md](docs/架构说明.md) | implementation contract for contributors |
| [docs/运维接口.md](docs/运维接口.md) | optional ops provider interface |

## Development

```bash
node --test                    # full test suite (includes fake-NapCat e2e)
npm run check                  # syntax + secret scan + pack manifest guard
npm run verify                 # all of the above (run before release)
node bin/dsh-onebot-qq.mjs doctor
```

## Privacy

- The package contains **no** real QQ numbers, tokens, API keys or server paths; every example is a placeholder.
- Runtime data (config, personas, stickers, memory, logs) stays in your own data dir — not in the repo, not in npm.

## License

[MIT](LICENSE)
