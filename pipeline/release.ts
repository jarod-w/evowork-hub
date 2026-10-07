/**
 * 发版机上的一条命令：打包 → 签名 → 核对钉死的公钥 → 上传 → 从线上取回验证（evowork 13 §4 / H2）。
 *
 * ```bash
 * pnpm release --dry-run     # 打包、签名、核对，不上传
 * pnpm release               # 真发布
 * ```
 *
 * 默认值（都能用参数改）：
 *
 * | 参数 | 默认 | 说明 |
 * | --- | --- | --- |
 * | `--origin` | `https://hub.nucleant.cn` | 线上地址（取当前序号、发布后验证） |
 * | `--ssh` | `root@43.143.248.70` | 服务器；上传走 ssh 隧道直连它本机的 MinIO（127.0.0.1:9000） |
 * | `--key` / `--kid` | `~/.evowork-hub-keys/evowork-hub-1.pem` / `evowork-hub-1` | 日常签名私钥（**仓库之外**，H2） |
 * | `--creds` | `~/.evowork-hub-keys/minio-publisher.env` | `hub-publisher` 账号（只有 hub 桶的读写权） |
 *
 * 为什么是这个顺序：
 * - **先核对再上传**：签出来的索引用 App 里钉死的公钥（evowork `hub-config.ts`）验一遍。
 *   发版机上的私钥和 App 钉的公钥对不上时，发出去的索引所有人都验不过 —— 要在这里失败。
 * - **先传内容包，最后传 `index.json`**：客户端只有拿到索引才会去取包，
 *   反过来就会有一段时间索引指向还不存在的包。
 * - **序号取线上的 + 1**：客户端拒绝回退的序号；两个人各发一份同序号的不同索引，客户端也拒。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { checkPin, evoworkDir, HUB_ROOT, loadHubProtocol } from "./evowork.ts";
import { publish } from "./publish.ts";
import { putObject, type S3Target } from "./s3put.ts";
import { signPayload } from "./sign.ts";

const DEFAULTS = {
  origin: "https://hub.nucleant.cn",
  ssh: "root@43.143.248.70",
  key: join(homedir(), ".evowork-hub-keys", "evowork-hub-1.pem"),
  kid: "evowork-hub-1",
  creds: join(homedir(), ".evowork-hub-keys", "minio-publisher.env"),
  tunnelPort: 19000,
};

interface PinnedKey {
  readonly kid: string;
  readonly publicPem?: string | undefined;
}

async function pinnedKeys(): Promise<readonly PinnedKey[]> {
  const mod = (await import(
    pathToFileURL(
      join(evoworkDir(), "apps", "desktop", "src", "main", "hub-config.ts"),
    ).href
  )) as { OFFICIAL_HUB_KEYS: readonly PinnedKey[] };
  return mod.OFFICIAL_HUB_KEYS;
}

/** 线上当前的序号；还没有索引就是 0。拿到了但验不过 → 报错（不能在一份来历不明的索引上 +1）。 */
async function liveSequence(
  origin: string,
  keys: readonly PinnedKey[],
): Promise<number> {
  const hub = await loadHubProtocol();
  const res = await fetch(`${origin}/v1/evowork/index.json`, {
    redirect: "error",
  });
  if (res.status === 404) return 0;
  if (res.status !== 200) throw new Error(`取线上索引失败：${res.status}`);
  const envelope = (await res.json()) as Parameters<
    typeof hub.verifyHubIndex
  >[0];
  const verified = hub.verifyHubIndex(envelope, keys);
  if (!verified.ok)
    throw new Error(`线上索引验签失败（${verified.reason}）：先查清楚再发`);
  return verified.payload.sequence;
}

function readCreds(path: string): {
  readonly access: string;
  readonly secret: string;
} {
  const text = readFileSync(path, "utf8");
  const access = /^HUB_S3_ACCESS_KEY=(.+)$/m.exec(text)?.[1]?.trim();
  const secret = /^HUB_S3_SECRET_KEY=(.+)$/m.exec(text)?.[1]?.trim();
  if (!access || !secret)
    throw new Error(`${path} 里没有 HUB_S3_ACCESS_KEY / HUB_S3_SECRET_KEY`);
  return { access, secret };
}

async function openTunnel(ssh: string, port: number): Promise<ChildProcess> {
  const child = spawn(
    "ssh",
    [
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "BatchMode=yes",
      "-L",
      `${port}:127.0.0.1:9000`,
      ssh,
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  for (let i = 0; i < 50; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/minio/health/live`);
      if (res.status === 200) return child;
    } catch {
      /* 还没通 */
    }
    if (child.exitCode !== null) break;
  }
  child.kill();
  throw new Error(`ssh 隧道没建起来（${ssh} → 127.0.0.1:9000）`);
}

function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory())
      out.push(...listFiles(full, `${prefix}${name}/`));
    else out.push(`${prefix}${name}`);
  }
  return out;
}

async function main(argv: readonly string[]) {
  const arg = (k: string, d: string) => {
    const i = argv.indexOf(k);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : d;
  };
  const dryRun = argv.includes("--dry-run");
  // 审计规则与钉死的公钥都从 evowork 读：必须是 evowork.lock 钉的那个提交，且那几个文件没有本地改动 ——
  // 否则签名用的「App 里的公钥」可能是一份还没发出去的草稿
  process.stdout.write(`${checkPin(true).message}\n`);
  const dirty = spawnSync(
    "git",
    [
      "-C",
      evoworkDir(),
      "status",
      "--porcelain",
      "--",
      "apps/desktop/src/main/hub-config.ts",
      "services/catalog/src",
      "packages/hub-protocol/src",
      "packages/account/src",
    ],
    { encoding: "utf8" },
  ).stdout.trim();
  if (dirty !== "")
    throw new Error(
      `evowork 签出里这些文件有未提交的改动，先提交并更新 evowork.lock：\n${dirty}`,
    );
  const origin = arg("--origin", DEFAULTS.origin).replace(/\/+$/, "");
  const keyPath = arg("--key", DEFAULTS.key);
  const kid = arg("--kid", DEFAULTS.kid);
  const hub = await loadHubProtocol();
  const pinned = await pinnedKeys();
  if (!pinned.some((k) => k.kid === kid))
    throw new Error(`App 里没有钉 ${kid} 这把公钥`);

  const current = await liveSequence(origin, pinned);
  const sequence = current + 1;
  process.stdout.write(`线上序号 ${current} → 这次 ${sequence}\n`);

  const outDir = join(HUB_ROOT, "dist");
  const now = Math.floor(Date.now() / 1000);
  const built = await publish({
    contentDir: join(HUB_ROOT, "content"),
    outDir,
    sequence,
    now,
  });
  const indexDir = join(outDir, "v1", "evowork");
  for (const [payload, index] of [
    ["payload.online.json", "index.json"],
    ["payload.offline.json", "index.offline.json"],
  ] as const) {
    const signed = await signPayload({
      keyPath,
      kid,
      payloadText: readFileSync(join(outDir, payload), "utf8"),
    });
    const verified = hub.verifyHubIndex(JSON.parse(signed), pinned);
    if (!verified.ok) {
      throw new Error(
        `${index} 用 App 钉死的公钥验不过（${verified.reason}）：发版机的私钥与 App 不配套，不发`,
      );
    }
    mkdirSync(indexDir, { recursive: true });
    writeFileSync(join(indexDir, index), signed);
  }
  process.stdout.write(
    `打包 ${built.items} 个条目；两份索引已签名，并用 App 钉死的公钥验过\n`,
  );
  if (dryRun) {
    process.stdout.write(`--dry-run：不上传。产物在 ${indexDir}\n`);
    return;
  }

  const { access, secret } = readCreds(arg("--creds", DEFAULTS.creds));
  const port = DEFAULTS.tunnelPort;
  const tunnel = await openTunnel(arg("--ssh", DEFAULTS.ssh), port);
  const target: S3Target = {
    endpoint: `http://127.0.0.1:${port}`,
    bucket: "hub",
    accessKey: access,
    secretKey: secret,
  };
  try {
    const pkgsDir = join(indexDir, "pkgs");
    const pkgs = existsSync(pkgsDir) ? listFiles(pkgsDir) : [];
    for (const rel of pkgs) {
      await putObject(
        target,
        `v1/evowork/pkgs/${rel}`,
        readFileSync(join(pkgsDir, rel)),
        "application/gzip",
      );
    }
    for (const index of ["index.offline.json", "index.json"]) {
      await putObject(
        target,
        `v1/evowork/${index}`,
        readFileSync(join(indexDir, index)),
        "application/json",
      );
    }
    process.stdout.write(`上传了 ${pkgs.length} 个内容包 + 两份索引\n`);
  } finally {
    tunnel.kill();
  }
  process.stdout.write("已上传（内容包 → 离线索引 → 在线索引）\n");

  // 从线上取回，用客户端同一套逻辑验
  const live = await liveSequence(origin, pinned);
  if (live !== sequence)
    throw new Error(`线上序号是 ${live}，不是刚发的 ${sequence}`);
  process.stdout.write(
    `✅ 线上验证通过：${origin}/v1/evowork/index.json 序号 ${live}\n`,
  );
}

if (process.argv[1]?.endsWith("release.ts")) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `✗ ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
