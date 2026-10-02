/**
 * 管道入口：G1 采集 → G2 许可 → G3 安全 → G4 兼容 → 报告（evowork 13 §7.1）。
 *
 * ```bash
 * pnpm pipeline --source <id>                      # 按 sources.yaml 签出钉死的提交再跑
 * pnpm pipeline --from <目录> --as <名字>           # 对一份已有的签出跑（V2：本机 curated 快照）
 * pnpm pipeline --source <id> --ci                 # CI：evowork 签出必须与 evowork.lock 一致
 * ```
 *
 * 报告写到 `dist/report/<名字>.{json,md}`（**不进仓库**）。G5 试跑、G6 改写、G7 签名发布不在这里。
 * 报告里只有路径、许可、结论这些元数据，**不复制上游正文**（没写许可的内容不许出现在本仓库里，H1）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { checkout, discoverSkills, readSources, readTree, type DiscoveredSkill } from './collect.ts';
import { checkPin, HUB_ROOT, loadCatalog } from './evowork.ts';
import {
  decide,
  gateCompat,
  gateLicense,
  gateSecurity,
  type CompatVerdict,
  type LicenseVerdict,
  type SecurityVerdict,
  type SkillDecision,
} from './gates.ts';

export interface SkillReport {
  readonly dir: string;
  readonly plugin?: string | undefined;
  readonly name: string;
  readonly license: LicenseVerdict;
  readonly security: SecurityVerdict;
  readonly compat: CompatVerdict;
  readonly decision: SkillDecision;
}

export interface RunReport {
  readonly source: string;
  readonly upstreamCommit?: string | undefined;
  readonly evowork: string;
  readonly rulesVersion: string;
  readonly pythonModules: string;
  readonly skills: readonly SkillReport[];
  readonly connectors: { readonly remote: number; readonly stdio: number; readonly apps: number };
}

/** stdlib + 办公运行时能 import 的顶层模块。找不到办公运行时就如实标出来（统计会偏严）。 */
export function pythonModules(): { readonly modules: ReadonlySet<string>; readonly from: string } {
  const candidates = [
    process.env.EVOWORK_OFFICE_PYTHON,
    join(homedir(), '.evowork', 'runtime', 'office', 'bin', 'python3'),
    join(homedir(), '.evowork', 'runtime', 'office', 'bin', 'python'),
  ].filter((p): p is string => p !== undefined && existsSync(p));
  const script =
    'import sys,pkgutil;print("\\n".join(sorted(set(list(sys.stdlib_module_names)+[m.name for m in pkgutil.iter_modules()]))))';
  for (const py of candidates) {
    try {
      const out = execFileSync(py, ['-c', script], { encoding: 'utf8' });
      return { modules: new Set(out.split('\n').filter(Boolean)), from: `办公运行时（${py}）` };
    } catch {
      /* 下一个 */
    }
  }
  const out = execFileSync('python3', ['-c', 'import sys;print("\\n".join(sorted(sys.stdlib_module_names)))'], {
    encoding: 'utf8',
  });
  return {
    modules: new Set(out.split('\n').filter(Boolean)),
    from: '⚠ 只有 python 标准库（本机没有办公运行时，所有用到第三方包的技能都会被判成依赖满足不了）',
  };
}

export async function analyze(input: {
  readonly name: string;
  readonly root: string;
  readonly skills: readonly DiscoveredSkill[];
  readonly upstreamCommit?: string | undefined;
  readonly evowork: string;
}): Promise<RunReport> {
  const catalog = await loadCatalog();
  const py = pythonModules();
  const repoLicense = readFirst(input.root, ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']);
  const skills: SkillReport[] = [];
  for (const skill of input.skills) {
    const skillMd = skill.files.find((f) => f.relativePath === 'SKILL.md')?.text ?? '';
    const fm = catalog.parseFrontmatter(skillMd);
    const frontmatterLicense = /^---\r?\n[\s\S]*?^license:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(skillMd)?.[1];
    let manifestLicense: string | undefined;
    let pluginLicense: string | undefined;
    if (skill.pluginDir !== undefined) {
      const manifest =
        readJson(join(input.root, skill.pluginDir, '.codex-plugin', 'plugin.json')) ??
        readJson(join(input.root, skill.pluginDir, '.claude-plugin', 'plugin.json'));
      manifestLicense = typeof manifest?.license === 'string' ? manifest.license : undefined;
      pluginLicense = readFirst(join(input.root, skill.pluginDir), ['LICENSE', 'LICENSE.md', 'LICENSE.txt']);
    }
    const license = gateLicense({
      skillFiles: skill.files,
      frontmatterLicense,
      pluginManifestLicense: manifestLicense,
      pluginLicenseText: pluginLicense,
      repoLicenseText: repoLicense,
    });
    const security = gateSecurity(catalog.auditSkillFiles(skill.files));
    const compat = gateCompat({
      files: skill.files,
      name: fm.name,
      description: fm.description,
      pythonModules: py.modules,
      ...(skill.pluginDir !== undefined
        ? { pluginModules: pluginModuleNames(join(input.root, skill.pluginDir), skill.dir.slice(skill.pluginDir.length + 1)) }
        : {}),
    });
    skills.push({
      dir: skill.dir,
      ...(skill.pluginDir !== undefined ? { plugin: skill.pluginDir } : {}),
      name: fm.name,
      license,
      security,
      compat,
      decision: decide(license, security, compat),
    });
  }
  return {
    source: input.name,
    ...(input.upstreamCommit !== undefined ? { upstreamCommit: input.upstreamCommit } : {}),
    evowork: input.evowork,
    rulesVersion: catalog.AUDIT_RULES_VERSION,
    pythonModules: py.from,
    skills,
    connectors: countConnectors(input.root),
  };
}

/** 厂商 MCP 与 ChatGPT Apps 只计数：连接器条目是 H5 的事；Apps 任何形式都不收（H9）。 */
function countConnectors(root: string): RunReport['connectors'] {
  let remote = 0;
  let stdio = 0;
  let apps = 0;
  for (const file of readTree(root, 4)) {
    if (file.relativePath.endsWith('.app.json')) apps += 1;
    if (!file.relativePath.endsWith('.mcp.json') || file.text === undefined) continue;
    try {
      const raw = JSON.parse(file.text) as { mcpServers?: Record<string, { command?: string; url?: string }> };
      for (const server of Object.values(raw.mcpServers ?? raw)) {
        if (typeof server !== 'object' || server === null) continue;
        if (typeof server.command === 'string') stdio += 1;
        else if (typeof server.url === 'string') remote += 1;
      }
    } catch {
      /* 读不懂的不算 */
    }
  }
  return { remote, stdio, apps };
}

export function renderMarkdown(report: RunReport): string {
  const by = (v: string) => report.skills.filter((s) => s.decision.verdict === v);
  const rejected = by('reject');
  const byGate = (g: string) => rejected.filter((s) => s.decision.gate === g).length;
  const licenseClasses = (c: string) => report.skills.filter((s) => s.license.class === c).length;
  const missing = new Map<string, number>();
  for (const s of report.skills) for (const m of s.compat.missingPython) missing.set(m, (missing.get(m) ?? 0) + 1);
  const topMissing = [...missing].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const codes = new Map<string, number>();
  for (const s of report.skills) for (const c of s.security.codes) codes.set(c, (codes.get(c) ?? 0) + 1);
  const L: string[] = [];
  L.push(`# 管道报告：${report.source}`);
  L.push('');
  L.push(`- 上游提交：${report.upstreamCommit ?? '（未知）'}`);
  L.push(`- evowork：${report.evowork} · 审计规则 ${report.rulesVersion}`);
  L.push(`- Python 模块口径：${report.pythonModules}`);
  L.push('');
  L.push('## 结论');
  L.push('');
  L.push('| 去向 | 数量 |');
  L.push('| --- | --- |');
  L.push(`| 收（宽松许可，过了 G2–G4） | ${by('accept').length} |`);
  L.push(`| 只做索引（没写许可，HUB-Q5a=A） | ${by('index-only').length} |`);
  L.push(`| 人工看（G3 判 P2） | ${by('manual').length} |`);
  L.push(`| 拒（G2 许可 / G3 安全 / G4 兼容） | ${rejected.length}（${byGate('G2')} / ${byGate('G3')} / ${byGate('G4')}） |`);
  L.push(`| **合计** | **${report.skills.length}** |`);
  L.push('');
  L.push(`许可（逐个技能判）：宽松 ${licenseClasses('permissive')} · 没写 ${licenseClasses('none')} · 限制 ${licenseClasses('restricted')}。`);
  L.push(`连接器（只计数，H5 再收）：远程 MCP ${report.connectors.remote} · stdio ${report.connectors.stdio} · ChatGPT Apps ${report.connectors.apps}（不收）。`);
  L.push('');
  L.push('## G3 命中的规则（按技能数）');
  L.push('');
  for (const [code, n] of [...codes].sort((a, b) => b[1] - a[1])) L.push(`- \`${code}\`：${n}`);
  L.push('');
  L.push('## G4：办公运行时多一个包能多收多少（13 §7.3）');
  L.push('');
  L.push('| 缺的模块 | 卡住的技能数 |');
  L.push('| --- | --- |');
  for (const [mod, n] of topMissing) L.push(`| \`${mod}\` | ${n} |`);
  L.push('');
  L.push('## 被拒与要人工看的（逐条）');
  L.push('');
  for (const s of report.skills.filter((x) => x.decision.verdict === 'reject' || x.decision.verdict === 'manual')) {
    L.push(`- \`${s.dir}\` — ${s.decision.verdict === 'manual' ? '人工' : s.decision.gate}：${s.decision.reasons.join('；')}`);
  }
  L.push('');
  return `${L.join('\n')}\n`;
}

/** 插件里、技能目录之外能被 import 的顶层名字（目录名与 .py 文件名）。 */
function pluginModuleNames(pluginRoot: string, skillRel: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const f of readTree(pluginRoot, 4)) {
    if (f.relativePath === skillRel || f.relativePath.startsWith(`${skillRel}/`)) continue;
    for (const seg of f.relativePath.split('/')) {
      const name = seg.replace(/\.py$/, '');
      if (/^[A-Za-z_]\w*$/.test(name)) names.add(name);
    }
  }
  return names;
}

function readFirst(dir: string, names: readonly string[]): string | undefined {
  for (const n of names) {
    const p = join(dir, n);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return undefined;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const arg = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const ci = argv.includes('--ci');
  const pin = checkPin(ci);
  process.stdout.write(`${pin.message}\n`);

  let name: string;
  let root: string;
  let upstreamCommit: string | undefined;
  let include: readonly string[] | undefined;
  let exclude: readonly string[] | undefined;
  const sourceId = arg('--source');
  if (sourceId !== undefined) {
    const source = readSources().find((s) => s.id === sourceId);
    if (source === undefined) throw new Error(`sources.yaml 里没有 ${sourceId}`);
    process.stdout.write(`G1 采集 ${source.repo} @ ${source.commit.slice(0, 10)}\n`);
    root = checkout(source);
    name = source.id;
    upstreamCommit = source.commit;
    include = source.include;
    exclude = source.exclude;
  } else {
    const from = arg('--from');
    if (from === undefined) throw new Error('用法：--source <id> 或 --from <目录> --as <名字>');
    if (ci) throw new Error('CI 里只能跑 sources.yaml 登记过的上游（--source）');
    root = from;
    name = arg('--as') ?? 'local';
    try {
      upstreamCommit = execFileSync('git', ['-C', from, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
      upstreamCommit = undefined;
    }
  }
  const skills = discoverSkills(root, { include, exclude });
  process.stdout.write(`发现 ${skills.length} 个技能，跑 G2–G4…\n`);
  const report = await analyze({ name, root, skills, upstreamCommit, evowork: pin.message });
  const outDir = join(HUB_ROOT, 'dist', 'report');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
  const md = renderMarkdown(report);
  writeFileSync(join(outDir, `${name}.md`), md);
  process.stdout.write(md.split('## G3')[0] ?? md);
  process.stdout.write(`报告：dist/report/${name}.{json,md}\n`);
}

if (process.argv[1]?.endsWith('run.ts')) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
