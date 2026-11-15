import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateEs256KeyPair } from "../../../evowork/packages/account/src/jwt.ts";
import {
  signHubIndex,
  unpackTarGz,
  verifyHubIndex,
} from "../../../evowork/packages/hub-protocol/src/index.ts";
import { HUB_ROOT } from "../evowork.ts";
import { EXPERT_MANIFEST, importExpert } from "../import-expert.ts";
import { publish } from "../publish.ts";

const id = "accessibility-auditor";
const pilot = join(HUB_ROOT, "content", "experts", id);
let tmp: string;
let dir: string;
let manifest: Record<string, unknown>;
let license: Record<string, unknown>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ew-hub-expert-"));
  dir = join(tmp, "content", "experts", id);
  cpSync(pilot, dir, { recursive: true });
  manifest = JSON.parse(readFileSync(join(dir, EXPERT_MANIFEST), "utf8"));
  license = JSON.parse(readFileSync(join(dir, "hub.json"), "utf8")).license;
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("WorkBuddy 单人专家导入", () => {
  it("从清单生成可验签的精选条目，保留许可和完整角色正文", async () => {
    const outDir = join(tmp, "dist");
    const now = 1_800_000_000;
    await publish({
      contentDir: join(tmp, "content"),
      outDir,
      sequence: 1,
      now,
    });
    const payload = JSON.parse(
      readFileSync(join(outDir, "payload.online.json"), "utf8"),
    );
    const { privatePem, publicPem } = generateEs256KeyPair();
    const verified = verifyHubIndex(signHubIndex(privatePem, payload, "test"), [
      { kid: "test", publicPem },
    ]);
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("专家目录验签失败");
    const [item] = verified.payload.items;
    expect(item).toMatchObject({
      kind: "expert",
      id,
      version: manifest.version,
      interface: {
        displayName: "无障碍审计师",
        sampleTasks: expect.arrayContaining([
          "检查这段 HTML 的键盘导航和可访问名称。",
        ]),
      },
      license: { spdx: "MIT", commit: license.commit },
    });
    if (!item || !("path" in item.package))
      throw new Error("专家应使用单独的托管包");
    const output = unpackTarGz(
      readFileSync(join(outDir, "v1", "evowork", item.package.path)),
    );
    if (!output.ok) throw new Error(output.reason);
    const files = new Map(
      output.files.map((file) => [file.path, Buffer.from(file.bytes)]),
    );
    expect([...files.keys()].sort()).toEqual(
      [`${id}.toml`, "LICENSE", "MODIFICATIONS.md", "NOTICE"].sort(),
    );
    expect(files.get("LICENSE")).toEqual(readFileSync(join(dir, "LICENSE")));
    const toml = files.get(`${id}.toml`)?.toString("utf8") ?? "";
    const role = readFileSync(join(dir, "agents", `${id}.md`), "utf8");
    expect(JSON.parse(/^instructions = (.+)$/m.exec(toml)?.[1] ?? "null")).toBe(
      role.replace(/^---\n[\s\S]*?\n---\n/, "").trim(),
    );
  });

  it.each([
    [{ expertType: "team" }, /仅支持单人专家/],
    [{ agents: ["../outside.md"] }, /唯一的 agents Markdown 文件/],
    [{ skills: ["./skills/required"] }, /请先处理依赖/],
    [{ license: "Proprietary" }, /宽松许可证/],
  ])("拒绝不支持或许可冲突的配置 %j", (change, reason) => {
    writeFileSync(
      join(dir, EXPERT_MANIFEST),
      JSON.stringify({ ...manifest, ...change }),
    );
    expect(() => importExpert(dir, id, license)).toThrow(reason);
  });
});
