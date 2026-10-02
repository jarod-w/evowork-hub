# evowork-hub

EvoWork 插件 Hub 的**源头仓库**：上游清单、筛选管道、我们托管的内容（技能 · 专家 · 连接器）。

设计的唯一真源是 evowork 仓库的 [13 · 插件 Hub](https://github.com/jarod-w/evowork/blob/ui_based_codex/docs/design/13-plugin-hub.md)。本仓库不重复它，只写「在这里怎么做」。

> **状态**：只有骨架。管道（G1–G7）与内容都还没有开始做。

---

## Hub 是什么形态

没有 Web 界面，就是一个静态目录，和 apt / rpm 仓库同一类：签过名的元数据 + 一堆包。

```
<cdn>/v1/<sourceId>/index.json                         签名信封（13 §4.1）
<cdn>/v1/<sourceId>/pkgs/<kind>/<id>/<version>.tar.gz  内容包（13 §4.2），sha256 写在索引里
```

- **本仓库是源头，CDN 上的目录是产物。**产物由 CI 生成，不回写进仓库。
- 用户在 EvoWork 桌面 App 的「插件」页浏览和安装，Hub 本身不提供任何页面。
- 我们发布内容的方式是：提交 / 提 PR → CI 跑管道 → 请求离线签名 → 上传 CDN。PR 评审就是管理后台。

## 目录

| 位置 | 内容 |
| --- | --- |
| [`sources.yaml`](sources.yaml) | 上游仓库清单，每个都钉死提交（G1） |
| [`pipeline/`](pipeline/) | 七道闸：采集 · 许可 · 安全 · 兼容 · 试跑 · 改写 · 签名发布（13 §7.1） |
| [`content/`](content/) | 我们托管的内容：自己写的，以及从上游收编、许可允许再分发的 |

## 许可边界

根目录的 [LICENSE](LICENSE)（MIT）**只覆盖我们自己写的代码与内容**。

从上游收编的第三方内容**各自保留原来的许可**：每个条目目录里都带着上游原 LICENSE，Apache-2.0 的同时保留 NOTICE，并在 `MODIFICATIONS.md` 里写明我们改了什么。它们不因为放进本仓库就变成 MIT。

上游**没写许可**的条目不会出现在本仓库里（13 HUB-Q5a=A：只做索引、不托管）。

## 问题反馈与下架

- 发现某个条目有问题，请提 issue。
- 你是某个条目的上游作者，希望我们下架，请提 issue。我们会在下一份索引里吊销它。
- **本仓库不接受第三方提交新条目**（13 N1）。
