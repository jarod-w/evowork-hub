/**
 * 与 evowork 仓库的连接（CLAUDE.md H4）。
 *
 * 审计规则（`services/catalog`）与索引协议（`packages/hub-protocol`）**只有一份，在 evowork 里**。
 * 这里按路径从 evowork 的源码引用它们（tsx 负责转译），不复制；版本由 `evowork.lock` 钉住：
 * 规则版本不同时，客户端与云端的结论按「取更严的」比对（13 §5.3），钉不住就无从谈起。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HUB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function evoworkDir(): string {
  return resolve(process.env.EVOWORK_DIR ?? join(HUB_ROOT, '..', 'evowork'));
}

export function pinnedCommit(): string {
  const text = readFileSync(join(HUB_ROOT, 'evowork.lock'), 'utf8');
  const m = /^commit=([0-9a-f]{40})$/m.exec(text);
  if (!m?.[1]) throw new Error('evowork.lock 里没有 commit=<40 位提交号>');
  return m[1];
}

/** 核对 evowork 签出是不是钉住的那个提交。CI 里对不上直接失败。 */
export function checkPin(ci: boolean): { readonly ok: boolean; readonly message: string } {
  const dir = evoworkDir();
  if (!existsSync(join(dir, 'services', 'catalog', 'src', 'index.ts'))) {
    throw new Error(`找不到 evowork 签出：${dir}（用 EVOWORK_DIR 指过去）`);
  }
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const pinned = pinnedCommit();
  if (head === pinned) return { ok: true, message: `evowork @ ${head.slice(0, 10)}（与 evowork.lock 一致）` };
  const message = `evowork 签出是 ${head.slice(0, 10)}，evowork.lock 钉的是 ${pinned.slice(0, 10)}`;
  if (ci) throw new Error(`${message}。CI 里必须一致`);
  return { ok: false, message: `⚠ ${message}（本机运行，只警告）` };
}

export type Catalog = typeof import('../../evowork/services/catalog/src/index.ts');
export type HubProtocol = typeof import('../../evowork/packages/hub-protocol/src/index.ts');

export async function loadCatalog(): Promise<Catalog> {
  return (await import(
    pathToFileURL(join(evoworkDir(), 'services', 'catalog', 'src', 'index.ts')).href
  )) as Catalog;
}

export async function loadHubProtocol(): Promise<HubProtocol> {
  return (await import(
    pathToFileURL(join(evoworkDir(), 'packages', 'hub-protocol', 'src', 'index.ts')).href
  )) as HubProtocol;
}
