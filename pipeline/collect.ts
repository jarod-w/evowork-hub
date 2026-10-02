/**
 * G1 采集与技能发现（evowork 13 §7.1）。
 *
 * 上游签出到 `.work/<id>/`（**不进仓库**：里面可能有没写许可的内容，CLAUDE.md H1），
 * 只取 `sources.yaml` 钉死的那个提交 —— 上游有新提交时改清单、整条管道重跑，不做增量放行。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { parse } from 'yaml';

import { HUB_ROOT } from './evowork.ts';
import type { SkillFile } from './gates.ts';

export interface SourceSpec {
  readonly id: string;
  readonly repo: string;
  readonly commit: string;
  readonly include?: readonly string[] | undefined;
  readonly exclude?: readonly string[] | undefined;
  readonly kinds: readonly ('skill' | 'connector')[];
  readonly note?: string | undefined;
}

export function readSources(path = join(HUB_ROOT, 'sources.yaml')): readonly SourceSpec[] {
  const raw = parse(readFileSync(path, 'utf8')) as { sources?: unknown };
  if (!Array.isArray(raw.sources)) throw new Error('sources.yaml：顶层要有 sources 列表');
  return raw.sources.map((s, i) => {
    const r = s as Record<string, unknown>;
    if (typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(r.id)) throw new Error(`sources[${i}].id 不对`);
    if (typeof r.repo !== 'string' || !r.repo.startsWith('https://')) throw new Error(`${r.id}：repo 必须是 https 地址`);
    if (typeof r.commit !== 'string' || !/^[0-9a-f]{40}$/.test(r.commit)) {
      throw new Error(`${r.id}：commit 必须钉死成 40 位完整提交号`);
    }
    return {
      id: r.id,
      repo: r.repo,
      commit: r.commit,
      ...(Array.isArray(r.include) ? { include: r.include as string[] } : {}),
      ...(Array.isArray(r.exclude) ? { exclude: r.exclude as string[] } : {}),
      kinds: Array.isArray(r.kinds) ? (r.kinds as ('skill' | 'connector')[]) : ['skill'],
      ...(typeof r.note === 'string' ? { note: r.note } : {}),
    };
  });
}

/** 签出钉死的提交。已经在那个提交上就不重拉。 */
export function checkout(source: SourceSpec): string {
  const dir = join(HUB_ROOT, '.work', source.id);
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (existsSync(join(dir, '.git'))) {
    try {
      if (git('rev-parse', 'HEAD') === source.commit) return dir;
    } catch {
      /* 坏了就重来 */
    }
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  git('init', '-q');
  git('remote', 'add', 'origin', source.repo);
  git('fetch', '-q', '--depth', '1', 'origin', source.commit);
  git('checkout', '-q', '--detach', 'FETCH_HEAD');
  const head = git('rev-parse', 'HEAD');
  if (head !== source.commit) throw new Error(`${source.id}：签出的是 ${head}，不是钉死的 ${source.commit}`);
  return dir;
}

/* ── 发现技能 ───────────────────────────────────────────────────────────── */

export interface DiscoveredSkill {
  /** 相对上游根的技能目录。 */
  readonly dir: string;
  readonly files: readonly SkillFile[];
  /** 最近的插件根（有 `.codex-plugin/plugin.json` 或 `.claude-plugin/plugin.json`）。 */
  readonly pluginDir?: string | undefined;
}

const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv']);
const TEXT = /\.(?:md|markdown|txt|json|ya?ml|toml|py|js|mjs|cjs|ts|sh|ps1|bat|html|css|csv|xml|ini|cfg)$|(?:^|\/)(?:LICEN[CS]E|COPYING|NOTICE)(?:\.[a-z]+)?$/i;
const MAX_TEXT_BYTES = 512 * 1024;

export function discoverSkills(
  root: string,
  opts: { readonly include?: readonly string[] | undefined; readonly exclude?: readonly string[] | undefined } = {},
): readonly DiscoveredSkill[] {
  const out: DiscoveredSkill[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    if (names.includes('SKILL.md')) {
      const rel = toPosix(relative(root, dir));
      if (matches(rel, opts.include, true) && !matches(rel, opts.exclude, false)) {
        const pluginDir = findPluginRoot(root, dir);
        out.push({ dir: rel, files: readTree(dir), ...(pluginDir !== undefined ? { pluginDir } : {}) });
      }
      return; // 技能目录里不再找嵌套技能
    }
    for (const name of names) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      try {
        if (statSync(full).isDirectory()) walk(full);
      } catch {
        /* 断链之类 */
      }
    }
  };
  walk(resolve(root));
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

export function readTree(dir: string, depth = 6): readonly SkillFile[] {
  const out: SkillFile[] = [];
  const walk = (here: string, d: number) => {
    if (d < 0) return;
    for (const name of readdirSync(here)) {
      if (SKIP.has(name)) continue;
      const full = join(here, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, d - 1);
        continue;
      }
      const rel = toPosix(relative(dir, full));
      const text = TEXT.test(rel) && st.size <= MAX_TEXT_BYTES ? readFileSync(full, 'utf8') : undefined;
      out.push({ relativePath: rel, ...(text !== undefined ? { text } : {}) });
    }
  };
  walk(dir, depth);
  return out;
}

function findPluginRoot(root: string, from: string): string | undefined {
  let dir = from;
  const top = resolve(root);
  while (dir.startsWith(top)) {
    if (existsSync(join(dir, '.codex-plugin', 'plugin.json')) || existsSync(join(dir, '.claude-plugin', 'plugin.json'))) {
      return toPosix(relative(root, dir));
    }
    if (dir === top) break;
    dir = dirname(dir);
  }
  return undefined;
}

/** 只认 `*` 与 `**` 的极简 glob（清单里写的就这两种）。 */
export function matches(path: string, globs: readonly string[] | undefined, emptyMeans: boolean): boolean {
  if (globs === undefined || globs.length === 0) return emptyMeans;
  return globs.some((g) => globToRegExp(g).test(path) || globToRegExp(g).test(`${path}/`));
}

function globToRegExp(glob: string): RegExp {
  const re = glob
    .split('**')
    .map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${re}$`);
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}
