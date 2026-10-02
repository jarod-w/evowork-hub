# content

我们托管的条目，**一个条目一个目录**。目前还是空的。

```
content/
  skills/<id>/        技能目录原样（SKILL.md + 脚本 + 资源）+ interface.json（中文元数据）
  experts/<id>.toml   agent-role TOML（evowork 05 §5.1 的格式），只收我们自己写的（CLAUDE.md H7）
  connectors/<id>/    connector.json（与 evowork connectors.json 的条目同构）；stdio 类另带 server 源码（H6）
```

从上游收编的条目，目录里还必须有：

| 文件 | 内容 |
| --- | --- |
| `LICENSE`（上游原名） | 上游的原许可文件，原样保留 |
| `NOTICE` | 上游有就原样保留（Apache-2.0 要求） |
| `MODIFICATIONS.md` | 我们改了什么（G6）：翻译、去品牌、依赖预打包等 |
| `UPSTREAM` | 上游地址与提交号，与 `sources.yaml` 一致 |

上游**没写许可**的条目不在这里（CLAUDE.md H1）。它们只出现在索引里，用户安装时由客户端从上游直接下载。
