# pipeline

筛选管道（evowork 13 §7.1）。TypeScript，用 `tsx` 跑；审计规则与索引协议**从 evowork 源码引用**
（CLAUDE.md H4），evowork 的提交钉在根目录的 `evowork.lock`。

| 闸 | 实现 | 状态 |
| --- | --- | --- |
| G1 采集 | `collect.ts`：按 `sources.yaml` 签出钉死的提交到 `.work/<id>/`（不进仓库） | ✅ |
| G2 许可 | `gates.ts` `gateLicense`：**逐个技能**判，由近到远：技能目录 LICENSE → frontmatter `license` → 插件清单 → 插件目录 LICENSE → 仓库根 | ✅ |
| G3 安全 | evowork `services/catalog` 的审计（规则版本见报告）；诱导安装 / 二进制拒收，P2 进人工 | ✅ |
| G4 兼容 | `gates.ts` `gateCompat`：HF9 长度、宿主专有写法、Python import 能否由办公运行时满足、运行时装 npm 包、引用技能目录外的插件代码 | ✅ |
| G5 试跑 | — | ⏳ H4 |
| G6 改写 | — | ⏳ H4 |
| G7 签名发布 | `publish.ts`（打包 + 未签名 payload）· `sign.ts`（签名）· `release.ts`（发版机上的一条命令）· `s3put.ts`（SigV4 PUT） | ✅ 2026-10-03 已上线 `https://hub.nucleant.cn:9443`（evowork build-and-deploy §5.3.2） |

```bash
pnpm install
pnpm pipeline --source <id>                       # G1–G4，按 sources.yaml
pnpm pipeline --from <已有签出> --as <名字>        # 对一份本机签出跑（V2 就是这么跑的）
pnpm tsx pipeline/publish.ts --sequence <n>       # content/ → dist/
pnpm tsx pipeline/sign.ts --key <仓库外的 pem> --kid <kid> --in dist/payload.online.json --out dist/v1/evowork/index.json
pnpm check                                        # 类型 + 测试
pnpm release --dry-run                            # 发版机：打包 + 签名 + 用 App 钉死的公钥核对，不上传
pnpm release                                      # 发版机：上传（先内容包、最后 index.json）并从线上取回验证
```

## 发布（发版机）

签名私钥与写入凭据**只在发版机上、仓库之外**（`~/.evowork-hub-keys/`，0600）：

| 文件 | 内容 |
| --- | --- |
| `evowork-hub-1.pem` | 日常签名私钥（kid `evowork-hub-1`） |
| `minio-publisher.env` | MinIO 写入账号 `hub-publisher`（只有 hub 桶的读写） |
| （离线保存） | 备份私钥 `evowork-hub-2`，平时不在任何联网的机器上 |

`pnpm release` 的顺序与理由写在 `pipeline/release.ts` 头注释里。要点：序号取线上的 + 1；签完先用 **App 里钉死的公钥**
（evowork `apps/desktop/src/main/hub-config.ts`）验一遍，对不上就不发；先传内容包、最后传 `index.json`。

CI（`.github/workflows/pipeline.yml`）只跑检查并产出**未签名**的 payload 与内容包，**不碰私钥**。

报告写到 `dist/report/<名字>.{json,md}`：每个技能的许可、审计结论、兼容问题与去向。
**只有元数据，不复制上游正文**（H1）。

**只有被某道闸标记出来的条目才需要人工看**，这是数量能做上去的前提（13 §7.1）。
每道闸拒收或跳过一个条目，都在报告里写清是哪道闸、为什么，不静默丢弃。

## 第一次真实数字（V2，2026-10-02）

对 `openai/plugins` @ `d416fd5a`（本机内核同步的 curated 快照）跑 G2–G4，办公运行时口径：

| 去向 | 数量 |
| --- | --- |
| 收 | 302 |
| 只做索引（没写许可） | 37 |
| 人工看（P2） | 13 |
| 拒：G2 许可 / G3 安全 / G4 兼容 | 133 / 6 / 15 |
| 合计 | 506 |

还没过 G5 试跑，也还没判「适不适合职场场景」，所以 302 是上限，不是能上线的数。
