import { generateEs256KeyPair } from "../../../evowork/packages/account/src/jwt.ts";
import {
  signHubIndex,
  type HubIndexPayload,
} from "../../../evowork/packages/hub-protocol/src/index.ts";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renewIndex, type RenewInput } from "../renew-index.ts";
import { indexHealth } from "../monitor-index.ts";
import { monitorEvent } from "../index-reader.ts";
import {
  ONLINE_TTL_SEC,
  readLiveIndex,
  readState,
  sourceRevision,
  verifiedIndex,
  withPublicationLock,
  writeState,
  type LiveIndex,
} from "../publication.ts";

const now = 1_800_000_000;
const keys = generateEs256KeyPair();
const trusted = [{ kid: "test", publicPem: keys.publicPem }];
let dir: string;
let live: LiveIndex;
let uploads: string[];
let input: RenewInput;
let server: Server | undefined;

function envelope(sequence = 4, expiresAt = now + 3600): string {
  const payload: HubIndexPayload = {
    schemaVer: 1,
    source: { id: "evowork", displayName: "EvoWork 精选" },
    sequence,
    issuedAt: now - 6 * 86400,
    expiresAt,
    items: [
      {
        id: "minutes",
        kind: "skill",
        version: "1.0.0",
        defaultEnabled: true,
        promptVisible: false,
        interface: {
          displayName: "会议纪要",
          description: "整理纪要",
          category: "办公",
        },
        package: {
          path: "pkgs/skill/minutes/1.0.0.tar.gz",
          sha256: "a".repeat(64),
          size: 123,
        },
        audit: {
          level: "p0",
          rulesVersion: "1",
          network: [],
          commands: [],
          hooks: false,
        },
        license: { spdx: "MIT" },
        publishedAt: now - 100 * 86400,
      },
    ],
    revoked: [{ id: "unsafe", versions: ["<1.2.0"], reason: "危险行为" }],
  };
  return JSON.stringify(signHubIndex(keys.privatePem, payload, "test"));
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ew-renew-"));
  writeFileSync(join(dir, "key.pem"), keys.privatePem, { mode: 0o600 });
  live = await verifiedIndex(envelope(), trusted);
  uploads = [];
  input = {
    origin: "https://hub.example",
    stateDir: dir,
    keys: trusted,
    keyPath: join(dir, "key.pem"),
    kid: "test",
    now,
    revision: () => "approved-content",
    readLive: async () => live,
    upload: async (raw) => {
      uploads.push(raw);
      live = await verifiedIndex(raw, trusted);
    },
  };
  writeState(dir, {
    origin: input.origin,
    online: live.raw,
    revision: input.revision(),
  });
});
afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((e) => (e ? reject(e) : resolve())),
    );
    server = undefined;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("已批准目录续发", () => {
  it("真实 Git 内容与吊销检查：未提交变更拒绝，已提交变更改变批准指纹", () => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "content"), { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init");
    writeFileSync(join(repo, "revoked.yaml"), "revoked: []\n");
    git("add", ".");
    git(
      "-c",
      "user.name=Hub Test",
      "-c",
      "user.email=hub-test@example.invalid",
      "commit",
      "-m",
      "Initial snapshot",
    );
    const original = sourceRevision(repo);
    writeFileSync(join(repo, "revoked.yaml"), "revoked: [unsafe]\n");
    expect(() => sourceRevision(repo)).toThrow(/未提交改动/);
    git("add", ".");
    git(
      "-c",
      "user.name=Hub Test",
      "-c",
      "user.email=hub-test@example.invalid",
      "commit",
      "-m",
      "Revoke unsafe item",
    );
    expect(sourceRevision(repo)).not.toBe(original);
    writeFileSync(join(repo, "content", "new-item.txt"), "unreviewed");
    expect(() => sourceRevision(repo)).toThrow(/未提交改动/);
  });

  it("只更新序号和有效期，保留包哈希、发布时间、审计和吊销列表，客户端仍能验签", async () => {
    const before = JSON.parse(JSON.parse(live.raw).payloadJson);
    const result = await renewIndex(input);
    expect(result).toEqual({
      status: "renewed",
      sequence: 5,
      expiresAt: now + ONLINE_TTL_SEC,
    });
    const after = JSON.parse(JSON.parse(live.raw).payloadJson);
    expect(after).toEqual({
      ...before,
      sequence: 5,
      issuedAt: now,
      expiresAt: now + ONLINE_TTL_SEC,
    });
    expect(uploads).toHaveLength(1);
    expect(readState(dir)).toEqual({
      origin: input.origin,
      online: live.raw,
      revision: "approved-content",
    });
  });

  it("还有超过 72 小时不读私钥、不上传", async () => {
    live = await verifiedIndex(envelope(4, now + 73 * 3600), trusted);
    writeState(dir, {
      origin: input.origin,
      online: live.raw,
      revision: input.revision(),
    });
    expect((await renewIndex({ ...input, keyPath: "/no-key" })).status).toBe(
      "skipped",
    );
    expect(uploads).toHaveLength(0);
  });

  it("没有批准记录不能凭线上签名自行开始续签", async () => {
    rmSync(join(dir, "state.json"));
    await expect(renewIndex(input)).rejects.toThrow(/正常 release/);
    expect(uploads).toHaveLength(0);
  });

  it("内容或吊销已改变时停止续签", async () => {
    await expect(
      renewIndex({ ...input, revision: () => "new-revocations" }),
    ).rejects.toThrow(/吊销/);
    expect(uploads).toHaveLength(0);
  });

  it("线上回退或同序号替换，即使签名正确也不再续签", async () => {
    for (const raw of [envelope(3), envelope(4, now + 100)]) {
      live = await verifiedIndex(raw, trusted);
      await expect(renewIndex(input)).rejects.toThrow(/批准记录不一致/);
    }
    expect(uploads).toHaveLength(0);
  });

  it("dry-run 不上传且不改变批准记录", async () => {
    const before = readFileSync(join(dir, "state.json"), "utf8");
    expect((await renewIndex({ ...input, dryRun: true })).status).toBe(
      "dry-run",
    );
    expect(readFileSync(join(dir, "state.json"), "utf8")).toBe(before);
    expect(uploads).toHaveLength(0);
  });

  it("上传失败后下一次重试同一份签名原文，不为同序号生成不同目录", async () => {
    await expect(
      renewIndex({
        ...input,
        upload: async () => {
          throw new Error("network down");
        },
      }),
    ).rejects.toThrow("network down");
    const pending = readState(dir)!.pending!.online;
    const result = await renewIndex({ ...input, now: now + 60 });
    expect(result.status).toBe("resumed");
    expect(uploads).toEqual([pending]);
    expect(readState(dir)?.pending).toBeUndefined();
  });

  it("上传已经成功、确认响应丢失：下一次只完成检查点，不重复上传", async () => {
    await expect(
      renewIndex({
        ...input,
        upload: async (raw) => {
          live = await verifiedIndex(raw, trusted);
          throw new Error("response lost");
        },
      }),
    ).rejects.toThrow("response lost");
    expect(readState(dir)?.pending).toBeDefined();
    expect((await renewIndex(input)).status).toBe("skipped");
    expect(readState(dir)?.pending).toBeUndefined();
    expect(readState(dir)?.online).toBe(live.raw);
    expect(uploads).toHaveLength(0);
  });

  it("并发发布/续发共用锁，第二个进程不能上传", async () => {
    await withPublicationLock(dir, async () => {
      await expect(renewIndex(input)).rejects.toThrow(/另一个发布/);
      expect(uploads).toHaveLength(0);
    });
    expect((await renewIndex(input)).status).toBe("renewed");
  });

  it("签名使用了另一把私钥时拒绝上传", async () => {
    writeFileSync(input.keyPath, generateEs256KeyPair().privatePem);
    await expect(renewIndex(input)).rejects.toThrow(/验签失败/);
    expect(uploads).toHaveLength(0);
  });

  it("上传前线上发生变化时保留原记录，不覆盖新目录", async () => {
    let reads = 0;
    const next = await verifiedIndex(envelope(5), trusted);
    await expect(
      renewIndex({
        ...input,
        readLive: async () => (++reads === 1 ? live : next),
      }),
    ).rejects.toThrow(/已经改变/);
    expect(uploads).toHaveLength(0);
    expect(readState(dir)?.pending).toBeUndefined();
  });

  it("过期的待发布目录不继续上传", async () => {
    writeState(dir, {
      ...readState(dir)!,
      pending: { online: envelope(5, now - 1), revision: input.revision() },
    });
    await expect(renewIndex(input)).rejects.toThrow(/待发布目录已过期/);
    expect(uploads).toHaveLength(0);
  });
});

describe("独立只读监测", () => {
  it("正常与异常检查使用同一个版本化告警接口，异常不伪造可信目录信息", () => {
    const checkedAt = "2026-11-07T14:00:00.000Z";
    const health = JSON.parse(
      JSON.stringify(
        monitorEvent(input.origin, indexHealth(live.payload, now), checkedAt),
      ),
    );
    const failure = JSON.parse(
      JSON.stringify(
        monitorEvent(
          input.origin,
          { status: "unavailable", exitCode: 4, message: "HTTP 503" },
          checkedAt,
        ),
      ),
    );
    for (const event of [health, failure])
      expect(event).toMatchObject({
        schemaVersion: 1,
        event: "evowork.hub.catalog.health",
        origin: input.origin,
        checkedAt,
      });
    expect(health).toMatchObject({
      sequence: live.payload.sequence,
      status: "critical",
      exitCode: 2,
    });
    expect(failure).toMatchObject({
      status: "unavailable",
      exitCode: 4,
      message: "HTTP 503",
    });
    expect(failure).not.toHaveProperty("expiresAt");
    expect(failure).not.toHaveProperty("sequence");
  });

  it.each([
    [72 * 3600, "healthy", 0],
    [48 * 3600, "healthy", 0],
    [48 * 3600 - 1, "warning", 1],
    [24 * 3600, "warning", 1],
    [24 * 3600 - 1, "critical", 2],
    [0, "expired", 3],
    [-1, "expired", 3],
  ])("剩余 %i 秒返回 %s 与非零告警退出码", (remaining, status, exitCode) => {
    expect(
      indexHealth({ ...live.payload, expiresAt: now + remaining }, now),
    ).toMatchObject({ status, exitCode });
  });

  it("真实 HTTP 获取、验签与监测贯通；篡改、错误来源和 HTTP 错误都不能报健康", async () => {
    let body = live.raw;
    let statusCode = 200;
    server = createServer((_req, res) => {
      res.statusCode = statusCode;
      res.end(body);
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    const origin = `http://127.0.0.1:${typeof address === "object" ? address!.port : 0}`;
    const fetched = await readLiveIndex(origin, trusted);
    expect(indexHealth(fetched!.payload, now).status).toBe("critical");
    body = live.raw.replace("整理纪要", "危险内容");
    await expect(readLiveIndex(origin, trusted)).rejects.toThrow(/验签失败/);
    body = JSON.stringify(
      signHubIndex(
        keys.privatePem,
        { ...live.payload, source: { id: "other", displayName: "Other" } },
        "test",
      ),
    );
    await expect(readLiveIndex(origin, trusted)).rejects.toThrow(/来源/);
    statusCode = 503;
    await expect(readLiveIndex(origin, trusted)).rejects.toThrow(/503/);
  });
});
