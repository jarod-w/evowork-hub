/** 把经审核的 WorkBuddy 单人专家转换成现有 Hub 专家包。 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

import { classifySpdx, gateLicense } from "./gates.ts";

export const EXPERT_MANIFEST = ".codebuddy-plugin/plugin.json";
const COMPONENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ROLE_FILE = /^(?:\.\/)?agents\/([a-z0-9][a-z0-9-]{0,63})\.md$/;

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function label(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  const translations = object(value);
  const localized = [translations.zh, translations["zh-CN"], translations.en];
  return localized
    .find(
      (text): text is string => typeof text === "string" && text.trim() !== "",
    )
    ?.trim();
}

function readPackageFile(root: string, path: string): Buffer {
  let full = root;
  const segments = path.split("/");
  for (const [index, segment] of segments.entries()) {
    full = join(full, segment);
    const stat = lstatSync(full);
    if (index === segments.length - 1 ? !stat.isFile() : !stat.isDirectory())
      throw new Error(`专家包路径类型不受支持：${path}`);
  }
  return readFileSync(full);
}

/** 只生成基本字符串和字符串数组，供现有客户端读取。 */
function quote(value: string): string {
  if (/[\uD800-\uDFFF]/u.test(value))
    throw new Error("专家文本包含无效 Unicode");
  return JSON.stringify(value).replace(/\u007f/g, "\\u007f");
}

export function importExpert(
  dir: string,
  id: string,
  license: Record<string, unknown>,
): {
  version: string;
  interface: Record<string, unknown>;
  files: { path: string; bytes: Uint8Array }[];
} {
  if (!lstatSync(dir).isDirectory()) throw new Error("专家目录不能是符号链接");
  const manifest = object(
    JSON.parse(readPackageFile(dir, EXPERT_MANIFEST).toString("utf8")),
  );
  if (manifest.expertType !== "agent" || manifest.teamInfo || manifest.members)
    throw new Error("仅支持单人专家");
  if (manifest.name !== id || !COMPONENT_ID.test(id))
    throw new Error("专家清单名称必须与 Hub 条目 ID 一致");
  if (typeof manifest.version !== "string") throw new Error("专家清单缺少版本");
  const agents = Array.isArray(manifest.agents) ? manifest.agents : [];
  const rolePath =
    agents.length === 1 && typeof agents[0] === "string"
      ? ROLE_FILE.exec(agents[0])
      : null;
  if (!rolePath?.[1] || rolePath[1] !== manifest.agentName)
    throw new Error("必须由 agentName 指向唯一的 agents Markdown 文件");
  for (const key of ["skills", "mcpServers", "connectors", "hooks", "apps"]) {
    const value = manifest[key];
    if (value !== undefined && !(Array.isArray(value) && value.length === 0))
      throw new Error(`单人专家必须独立运行，请先处理依赖：${key}`);
  }

  const role = readPackageFile(dir, `agents/${rolePath[1]}.md`).toString(
    "utf8",
  );
  const header =
    /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(role);
  const frontmatter = object(parse(header?.[1] ?? ""));
  const instructions = header ? role.slice(header[0].length).trim() : "";
  if (frontmatter.name !== manifest.agentName || instructions === "")
    throw new Error("角色文件缺少匹配的 name 或正文指令");
  // 上游工具和权限字段仅用于 WorkBuddy。转换只携带描述和角色正文。

  const licenseFile = readPackageFile(dir, "LICENSE");
  const spdx = license.spdx;
  const licenseText = licenseFile.toString("utf8");
  const verdict = gateLicense({
    skillFiles: [{ relativePath: "LICENSE", text: licenseText }],
  });
  if (
    typeof spdx !== "string" ||
    classifySpdx(spdx) !== "permissive" ||
    verdict.spdx !== spdx ||
    (manifest.license !== undefined && manifest.license !== spdx) ||
    (frontmatter.license !== undefined && frontmatter.license !== spdx) ||
    typeof license.upstream !== "string" ||
    !license.upstream.startsWith("https://") ||
    typeof license.commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(license.commit)
  )
    throw new Error("第三方专家需要可核对的宽松许可证、上游地址和固定提交");

  const displayName = label(manifest.displayName) ?? id;
  const description =
    label(manifest.displayDescription) ??
    label(manifest.description) ??
    label(frontmatter.description);
  if (!description) throw new Error("专家清单或角色文件必须提供描述");
  const category = label(manifest.categoryId) ?? "未分类";
  const defaultPrompt = label(manifest.defaultInitPrompt);
  const sampleTasks = Array.isArray(manifest.quickPrompts)
    ? [
        ...new Set(
          manifest.quickPrompts
            .map(label)
            .filter((value) => value !== undefined),
        ),
      ]
    : [];
  const details = {
    displayName,
    description,
    category,
    sampleTasks,
    ...(defaultPrompt ? { defaultPrompt } : {}),
  };
  const toml = [
    `name = ${quote(id)}`,
    `description = ${quote(description)}`,
    `instructions = ${quote(instructions)}`,
    "",
    "[interface]",
    `display_name = ${quote(displayName)}`,
    `category = ${quote(category)}`,
    `sample_tasks = [${sampleTasks.map(quote).join(", ")}]`,
    "",
  ].join("\n");
  const files = [
    { path: `${id}.toml`, bytes: Buffer.from(toml) },
    { path: "LICENSE", bytes: licenseFile },
    {
      path: "MODIFICATIONS.md",
      bytes: readPackageFile(dir, "MODIFICATIONS.md"),
    },
  ];
  const notice = join(dir, "NOTICE");
  if (spdx === "Apache-2.0" || existsSync(notice))
    files.push({ path: "NOTICE", bytes: readPackageFile(dir, "NOTICE") });
  return { version: manifest.version, interface: details, files };
}
