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
| G7 签名发布 | `publish.ts`（打包 + 未签名 payload）· `sign.ts`（签名）· `release.ts`（发版机上的一条命令）· `s3put.ts`（SigV4 PUT） | ✅ 2026-10-03 已上线；2026-10-07 起是 `https://hub.nucleant.cn`（evowork build-and-deploy §5.3.2） |

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

## 在线目录维护

在线目录有效 7 天。发版机 `pnpm renew-index` 在剩余有效期不超过 72 小时时只续发在线目录；不会重打包、改变条目发布时间、审计或吊销列表，也不会续发离线包。首次建立批准记录、内容或吊销变更仍执行正常 `pnpm release`。

两个命令共用 `~/.evowork-hub-release/publish.lock` 与 `state.json`（可用 `--state-dir` 改位置）。正常发布成功后保存被签名的完整目录及内容指纹；续发核对线上原文、内容/吊销/依赖记录，任何未提交或未发布变更都会失败。不要让定时任务自动 `git pull`。建议用独立发版目录，`EVOWORK_DIR` 指向 `evowork.lock` 固定的、依赖已安装的 EvoWork 签出，不使用日常开发签出。

```bash
pnpm release --dry-run       # 检查打包和签名，不上传、不改变批准记录
pnpm release                 # 首次批准或发布内容/吊销变更
pnpm renew-index --dry-run   # 检查续发条件；不上传、不改变批准记录
pnpm renew-index             # 不到阈值则 skipped；失败保留检查点
pnpm schedule:renew --install # macOS 发版机：每小时检查；失败下小时重试
pnpm monitor-index           # 只读监测；不需要签名材料或发布检查点
pnpm build:monitor           # dist/monitor-index.mjs：只含公钥，可部署到另一台机器
```

`schedule:renew` 默认不带 `--install` 时只生成 LaunchAgent；用 `--out` 指定输出位置。已存在时需显式 `--replace`。续发计划使用绝对 Node/tsx 路径并保存 `EVOWORK_DIR`，不依赖交互 shell 的 pnpm/PATH。发版机休眠/关机期间不会运行，恢复后下一次检查；因此应在常开的受控发版机运行。日志在状态目录的 `logs/`；不记录密钥与上传认证头。

上传在线目录前原子保存待发布检查点。上传失败时下一次续发重传**同一份**签名原文；上传成功但确认响应丢失时，下次回读后完成检查点。待发布目录已经过期时执行正常 `release`，会跳过已使用的序号。异常退出遗留锁时，先检查 `publish.lock/owner.json` 的进程是否已停止，再删除那个锁目录；程序不自动抢锁。所有发布者必须使用同一发版机/状态目录，跨机器发布不受这把本机锁保护。

独立监测应部署在发版机以外的机器，只分发 `dist/monitor-index.mjs`，不分发私钥、上传凭据或批准记录。构建时公钥与协议来自固定的 EvoWork 签出；换公钥后需重建部署。Node >=22.12，无额外依赖；可用第一个参数指定 HTTPS 源。输出 JSON，退出码：0 健康、1 剩余不足 48 小时、2 不足 24 小时、3 已过期、4 网络/验签/来源/时钟异常。

Linux 示例将单文件安装到 `/opt/evowork-hub-monitor/monitor-index.mjs`，`ops/evowork-hub-monitor.{service,timer}` 放到 `/etc/systemd/system/` 后启用 timer。用 `systemctl start evowork-hub-monitor.service` 实测，`journalctl -u evowork-hub-monitor.service` 查看结果。非零退出保留失败状态，**还需接入运维已有的告警通知渠道**；程序本身不发送邮件、消息或调用外部 webhook。若监测与 Hub 同机，无法报告整机离线，应由外部探测补充。

### 预留告警接口

按用户决定，当前只记日志，不配置外部通知。每次检查输出一行 JSON，正常检查写 stdout，网络/校验等异常写 stderr；systemd 两者均进入 journal。稳定标识为 `schemaVersion: 1`、`event: "evowork.hub.catalog.health"`，所有事件均含 `origin`、`checkedAt`（UTC ISO 时间）、`status`、`exitCode`。验签成功的事件另含 `sequence`、`issuedAt`、`expiresAt`、`remainingSeconds`；无法取得可信目录时含 `message`，不伪造目录序号或有效期。

后续通知接收器可解析上述 JSON，或使用 `ops/monitor-alert.conf.example` 的标准 systemd `OnFailure` 接口触发自己的 `evowork-hub-notify@.service`。接收器负责地址/凭据、去重和恢复通知；没有配置接收器时无需启用 drop-in。现有监测进程不因此持有通知服务密钥，也不自动产生外发消息。

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
