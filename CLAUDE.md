# CLAUDE.md — evowork-hub

EvoWork 插件 Hub 的源头仓库：上游清单 · 筛选管道 · 托管内容。

**设计的唯一真源**是 evowork 仓库的 [`docs/design/13-plugin-hub.md`](../evowork/docs/design/13-plugin-hub.md)（同一工作区里的 `../evowork`）。动手前先读它的 §3、§4、§7、§10。本文件只写「在这个仓库里必须遵守什么」，不复制设计。

在这里工作时，evowork 的 CLAUDE.md **加载不到**：Claude Code 从工作目录往上找，而上一层是空的。所以 evowork 那边与本仓库相关的规则，都在下面写了一遍；**不要把 evowork 的 CLAUDE.md 整份复制过来**，两份会慢慢分叉。

---

## 1. 硬约束（本仓库是公开的）

违反任何一条，代价都不是「代码丑」：要么是把别人的内容未经授权公开再分发，要么是把签名信任链交了出去。

| # | 约束 | 依据 |
| --- | --- | --- |
| H1 | **没写许可的内容永远不提交进本仓库**。只能在 CI 的临时目录里分析，仓库里只存索引元数据 | 13 HUB-Q5a=A；提交到公开仓库本身就是再分发 |
| H2 | **签名私钥永远不进仓库，也不进 CI 的环境变量 / secrets**。CI 只能请求离线签名 | 13 §4.3 |
| H3 | 根目录的 MIT 只覆盖我们自己的代码与内容。第三方内容**保留原 LICENSE**；Apache-2.0 的同时保留 NOTICE，并在 `MODIFICATIONS.md` 写明改了什么 | 13 §7.5、G6 |
| H4 | **审计规则不复制**：从 evowork 的 `services/catalog` 引用（git 依赖钉提交）。本仓库里不许出现第二份审计规则 | 13 HUB-Q9=A；云端与客户端按规则版本比对结论（13 §5.3） |
| H5 | 面向用户的文字（displayName / description / 改写后的说明）里**不出现 Codex / OpenAI / ChatGPT / Claude 字样** | evowork K5 |
| H6 | stdio 连接器**只收包内自带的 JS / Python 源码**：不收原生二进制，启动命令里不许有 `npx` / `uvx` / `pipx run` 这类运行时拉包 | 13 HUB-Q6a=A |
| H7 | 专家只收我们自己写的；开源子代理的转换是二期 | 13 HUB-Q10=A |
| H8 | **不接受第三方提交新条目**。问题反馈和下架请求可以接受 | 13 N1 / HUB-Q1 |
| H9 | ChatGPT Apps（`.app.json`）任何形式都不收 | evowork K7 |
| H10 | 许可白名单：MIT · Apache-2.0 · BSD-2/3-Clause · ISC · CC0-1.0 · CC-BY-4.0。**逐个条目判**，不只看仓库级许可；Proprietary、source-available、copyleft 不收 | 13 HUB-Q5=A |

## 2. 和 evowork 的边界

- **索引格式与内容包格式是两个仓库之间的契约**，定义在 13 §4.1 / §4.2。客户端（evowork 的 `services/hub-client`）按它验签和解析，本仓库按它生成。改格式先改 13，再两边一起改，不要单边改。
- 审计规则在 evowork（H4）。规则本身要改，去 evowork 改。
- `../codex` 是执行内核，**只读**（evowork K1）。本仓库的试跑闸（G5）只用 evowork 打过补丁的内核（带 `KERNEL_PROVENANCE.json`），不直接编 `../codex`。

## 3. 目录

| 位置 | 内容 |
| --- | --- |
| `sources.yaml` | 上游清单（G1），每个都钉死提交 |
| `pipeline/` | G1–G7 的实现 |
| `content/` | 我们托管的条目，一个条目一个目录 |
| 构建产物（`dist/`、`.work/`） | **不进仓库**（`.gitignore` 已排除）。`.work/` 是上游的临时签出，里面可能有没写许可的内容（H1） |

## 4. 约定

- 文档中文，commit message 英文（与 evowork 相同）。
- 降级、跳过、认不出来都要如实说：某道闸跳过了某个条目，要写清是哪道闸、为什么，不静默丢弃。
