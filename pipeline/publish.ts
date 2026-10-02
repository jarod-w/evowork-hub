/**
 * G7（前半）：把 `content/` 打成内容包 + **未签名**的索引 payload（evowork 13 §4.1 / §4.2 / §4.7 ③）。
 *
 * ```bash
 * pnpm tsx pipeline/publish.ts --sequence <上一份 + 1> [--previous dist/prev-payload.json]
 * ```
 *
 * 产出（`dist/`，不进仓库）：
 *
 * ```
 * dist/v1/evowork/pkgs/<kind>/<id>/<version>.tar.gz   确定性 tar.gz（同样的内容 → 同样的字节）
 * dist/payload.online.json                             在线索引的 payload，有效期 7 天
 * dist/payload.offline.json                            离线索引的 payload，有效期 180 天（4.7 ③）
 * ```
 *
 * **这一步不碰私钥**（CLAUDE.md H2）：payload 交给离线签名机，由 `pipeline/sign.ts` 在那里签。
 * CI 只能「请求签名」，拿不到私钥。
 *
 * 没写许可的条目（HUB-Q5a=A）**不在 `content/` 里**（H1），它们的索引条目由 `upstream.yaml`
 * 登记（只有上游地址、固定提交、子目录、树哈希），这一步原样并进 payload，不下载、不打包。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { parse } from 'yaml';

import { HUB_ROOT, loadCatalog, loadHubProtocol } from './evowork.ts';

const ONLINE_TTL_SEC = 7 * 24 * 3600;
const OFFLINE_TTL_SEC = 180 * 24 * 3600;

export interface PublishInput {
  readonly contentDir: string;
  readonly outDir: string;
  readonly sequence: number;
  readonly now: number;
  /** 上一份已发布的 payload：用来判 `sequence` 必须递增、版本不许回退。 */
  readonly previous?: { readonly sequence: number; readonly items: readonly { kind: string; id: string; version: string }[] } | undefined;
  readonly upstreamFile?: string | undefined;
}

export async function publish(input: PublishInput) {
  const catalog = await loadCatalog();
  const hub = await loadHubProtocol();
  if (input.previous !== undefined && input.sequence <= input.previous.sequence) {
    throw new Error(`sequence 必须比上一份大（上一份 ${input.previous.sequence}）：客户端会拒绝回退的索引`);
  }
  const items: unknown[] = [];
  for (const kind of ['skill', 'expert', 'connector'] as const) {
    const base = join(input.contentDir, `${kind}s`);
    if (!existsSync(base)) continue;
    for (const id of readdirSync(base).sort()) {
      const dir = join(base, id);
      if (!statSync(dir).isDirectory()) continue;
      const meta = readMeta(dir, kind, id);
      const files = readFiles(dir).filter((f) => f.path !== 'hub.json');
      const auditFiles = files.map((f) => ({
        relativePath: f.path,
        ...(/\.(md|json|py|mjs|cjs|js|ts|toml|txt|ya?ml|sh)$/i.test(f.path)
          ? { text: Buffer.from(f.bytes).toString('utf8') }
          : {}),
      }));
      const audit = catalog.auditSkillFiles(auditFiles);
      if (audit.findings.some((f) => f.lure === true)) {
        throw new Error(`${kind}:${id} 命中诱导安装规则，不能发布（G3）`);
      }
      const caps = catalog.extractCapabilities(auditFiles);
      const prev = input.previous?.items.find((i) => i.kind === kind && i.id === id);
      if (prev !== undefined && hub.compareVersions(meta.version, prev.version) < 0) {
        throw new Error(`${kind}:${id} 的版本 ${meta.version} 比已发布的 ${prev.version} 旧`);
      }
      const archive = hub.packTarGz(files);
      const path = `pkgs/${kind}/${id}/${meta.version}.tar.gz`;
      const dest = join(input.outDir, 'v1', 'evowork', path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, archive);
      items.push({
        id,
        kind,
        version: meta.version,
        package: { path, sha256: hub.sha256Hex(archive), size: archive.length },
        ...(meta.minAppVersion !== undefined ? { minAppVersion: meta.minAppVersion } : {}),
        defaultEnabled: meta.defaultEnabled,
        promptVisible: meta.promptVisible,
        interface: meta.interface,
        audit: {
          level: audit.level,
          rulesVersion: catalog.AUDIT_RULES_VERSION,
          network: caps.network,
          commands: caps.commands,
          hooks: caps.hooks,
        },
        license: meta.license,
        ...(kind === 'connector' ? { connector: { transport: meta.transport } } : {}),
        publishedAt: meta.publishedAt ?? input.now,
      });
    }
  }
  items.push(...readUpstream(input.upstreamFile ?? join(HUB_ROOT, 'upstream.yaml')));
  const payloadFor = (ttl: number) => ({
    schemaVer: 1,
    source: { id: 'evowork', displayName: 'EvoWork 精选' },
    sequence: input.sequence,
    issuedAt: input.now,
    expiresAt: input.now + ttl,
    items,
    revoked: readRevoked(join(HUB_ROOT, 'revoked.yaml')),
  });
  const written: string[] = [];
  for (const [name, ttl] of [
    ['payload.online.json', ONLINE_TTL_SEC],
    ['payload.offline.json', OFFLINE_TTL_SEC],
  ] as const) {
    const payload = payloadFor(ttl);
    // 用客户端的解析器过一遍：这里能生成、客户端却不认的索引，发出去就是一次全网「目录读不出来」
    const encoded = hub.encodeHubIndexPayload(payload as never);
    if (hub.parseHubIndexPayload(encoded) === undefined) {
      throw new Error(`${name} 不符合索引协议（evowork packages/hub-protocol 的解析器不认）`);
    }
    mkdirSync(input.outDir, { recursive: true });
    writeFileSync(join(input.outDir, name), `${encoded}\n`);
    written.push(name);
  }
  return { items: items.length, written };
}

interface ItemMeta {
  readonly version: string;
  readonly minAppVersion?: string | undefined;
  readonly defaultEnabled: boolean;
  readonly promptVisible: boolean;
  readonly interface: Record<string, unknown>;
  readonly license: Record<string, unknown>;
  readonly transport?: string | undefined;
  readonly publishedAt?: number | undefined;
}

/** 每个条目目录里的 `hub.json`：版本、中文元数据、许可、是否进 prompt。不打进内容包。 */
function readMeta(dir: string, kind: string, id: string): ItemMeta {
  const path = join(dir, 'hub.json');
  if (!existsSync(path)) throw new Error(`${kind}:${id} 缺 hub.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (typeof raw.version !== 'string') throw new Error(`${kind}:${id} 的 hub.json 缺 version`);
  return {
    version: raw.version,
    ...(typeof raw.minAppVersion === 'string' ? { minAppVersion: raw.minAppVersion } : {}),
    defaultEnabled: raw.defaultEnabled !== false,
    promptVisible: raw.promptVisible !== false,
    interface: (raw.interface ?? {}) as Record<string, unknown>,
    license: (raw.license ?? { spdx: 'MIT' }) as Record<string, unknown>,
    ...(typeof raw.transport === 'string' ? { transport: raw.transport } : {}),
    ...(typeof raw.publishedAt === 'number' ? { publishedAt: raw.publishedAt } : {}),
  };
}

function readFiles(dir: string): { path: string; bytes: Uint8Array }[] {
  const out: { path: string; bytes: Uint8Array }[] = [];
  const walk = (here: string) => {
    for (const name of readdirSync(here)) {
      if (name === '.DS_Store' || name === 'node_modules' || name === '.git') continue;
      const full = join(here, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ path: relative(dir, full).split(sep).join('/'), bytes: new Uint8Array(readFileSync(full)) });
    }
  };
  walk(dir);
  return out;
}

function readUpstream(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const raw = parse(readFileSync(path, 'utf8')) as { items?: unknown };
  return Array.isArray(raw.items) ? raw.items : [];
}

function readRevoked(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const raw = parse(readFileSync(path, 'utf8')) as { revoked?: unknown };
  return Array.isArray(raw.revoked) ? raw.revoked : [];
}

async function main(argv: readonly string[]) {
  const arg = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const sequence = Number(arg('--sequence'));
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error('需要 --sequence <正整数>（上一份 + 1）');
  const previousPath = arg('--previous');
  const previous = previousPath !== undefined ? JSON.parse(readFileSync(previousPath, 'utf8')) : undefined;
  const result = await publish({
    contentDir: join(HUB_ROOT, 'content'),
    outDir: join(HUB_ROOT, 'dist'),
    sequence,
    now: Math.floor(Date.now() / 1000),
    ...(previous !== undefined ? { previous } : {}),
  });
  process.stdout.write(`▸ ${result.items} 个条目；写了 ${result.written.join('、')}。下一步：交给离线签名机跑 pipeline/sign.ts\n`);
}

if (process.argv[1]?.endsWith('publish.ts')) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
