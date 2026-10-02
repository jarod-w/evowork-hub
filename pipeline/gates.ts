/**
 * G2 许可 · G3 安全 · G4 兼容（evowork 13 §7.1）。纯函数：输入是一个技能目录的文件与上下文，
 * 输出是每道闸的结论和最终去向。**每一个被拒或跳过的条目都写清是哪道闸、为什么**（CLAUDE.md §4）。
 */

export interface SkillFile {
  readonly relativePath: string;
  /** 文本文件的正文；二进制缺省。 */
  readonly text?: string | undefined;
}

export type LicenseClass = 'permissive' | 'none' | 'restricted';

export interface LicenseVerdict {
  /** SPDX 表达式；判不出来的是 `NOASSERTION`。 */
  readonly spdx: string;
  readonly class: LicenseClass;
  /** 从哪判出来的：技能目录的 LICENSE、frontmatter、插件清单、插件目录的 LICENSE、仓库根。 */
  readonly from: 'skill-license-file' | 'frontmatter' | 'plugin-manifest' | 'plugin-license-file' | 'repo-license-file' | 'none';
}

/** CLAUDE.md H10 的白名单。 */
export const PERMISSIVE = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'CC0-1.0', 'CC-BY-4.0']);

/** SPDX 表达式 → 类别。AND 要求每一项都宽松；OR 有一项宽松就行。认不出来的一律按限制。 */
export function classifySpdx(expr: string): LicenseClass {
  const e = expr.trim();
  if (e === '' || e === 'NOASSERTION') return 'none';
  const strip = (s: string) => s.replace(/[()]/g, '').trim();
  if (/\sOR\s/i.test(e)) {
    return e.split(/\sOR\s/i).some((p) => classifySpdx(strip(p)) === 'permissive') ? 'permissive' : 'restricted';
  }
  if (/\sAND\s/i.test(e)) {
    return e.split(/\sAND\s/i).every((p) => classifySpdx(strip(p)) === 'permissive') ? 'permissive' : 'restricted';
  }
  return PERMISSIVE.has(strip(e)) ? 'permissive' : 'restricted';
}

/** 从许可证正文认 SPDX。只认得出常见的几种；认不出来返回 undefined（不是「宽松」）。 */
export function detectLicenseText(text: string): string | undefined {
  const t = text.replace(/\s+/g, ' ');
  if (/Permission is hereby granted, free of charge/i.test(t)) return 'MIT';
  if (/Apache License/i.test(t) && /Version 2\.0/i.test(t)) return 'Apache-2.0';
  if (/Permission to use, copy, modify, and\/or distribute this software/i.test(t)) return 'ISC';
  if (/Redistribution and use in source and binary forms/i.test(t)) {
    return /Neither the name/i.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  }
  if (/CC0 1\.0 Universal/i.test(t)) return 'CC0-1.0';
  if (/Attribution 4\.0 International/i.test(t) && !/ShareAlike|NonCommercial|NoDerivatives/i.test(t)) return 'CC-BY-4.0';
  if (/GNU (?:AFFERO |LESSER )?GENERAL PUBLIC LICENSE/i.test(t)) return 'LicenseRef-copyleft';
  if (/all rights reserved|proprietary/i.test(t)) return 'LicenseRef-proprietary';
  return undefined;
}

const LICENSE_FILE = /^(?:LICEN[CS]E|COPYING)(?:\.(?:md|txt))?$/i;

export function findLicenseFile(files: readonly SkillFile[]): SkillFile | undefined {
  return files.find((f) => !f.relativePath.includes('/') && LICENSE_FILE.test(f.relativePath));
}

/**
 * G2：**逐个技能**判，不只看仓库级（13 §7.1）：同一个仓库里可以混着两种许可。
 * 由近到远：技能目录的 LICENSE → SKILL.md frontmatter 的 `license` → 插件清单 → 插件目录的 LICENSE → 仓库根。
 */
export function gateLicense(input: {
  readonly skillFiles: readonly SkillFile[];
  readonly frontmatterLicense?: string | undefined;
  readonly pluginManifestLicense?: string | undefined;
  readonly pluginLicenseText?: string | undefined;
  readonly repoLicenseText?: string | undefined;
}): LicenseVerdict {
  const skillLicense = findLicenseFile(input.skillFiles)?.text;
  const fromText = (text: string | undefined) => (text !== undefined ? detectLicenseText(text) : undefined);
  const candidates: [LicenseVerdict['from'], string | undefined][] = [
    ['skill-license-file', fromText(skillLicense) ?? (skillLicense !== undefined ? 'LicenseRef-unrecognized' : undefined)],
    ['frontmatter', input.frontmatterLicense],
    ['plugin-manifest', input.pluginManifestLicense],
    ['plugin-license-file', fromText(input.pluginLicenseText) ?? (input.pluginLicenseText !== undefined ? 'LicenseRef-unrecognized' : undefined)],
    ['repo-license-file', fromText(input.repoLicenseText) ?? (input.repoLicenseText !== undefined ? 'LicenseRef-unrecognized' : undefined)],
  ];
  for (const [from, spdx] of candidates) {
    if (spdx !== undefined && spdx.trim() !== '') {
      const normalized = spdx.trim();
      return { spdx: normalized, class: classifySpdx(normalized), from };
    }
  }
  return { spdx: 'NOASSERTION', class: 'none', from: 'none' };
}

/* ── G3 ─────────────────────────────────────────────────────────────────── */

export interface AuditLike {
  readonly level: 'p0' | 'p1' | 'p2';
  readonly findings: readonly { readonly code: string; readonly detail: string; readonly lure?: boolean | undefined }[];
}

export interface SecurityVerdict {
  readonly level: 'p0' | 'p1' | 'p2';
  readonly codes: readonly string[];
  /** 拒收原因（诱导安装、二进制）。有值 = 拒收。 */
  readonly reject?: string | undefined;
  /** P2 必须人工看（13 §7.1）。 */
  readonly manual: boolean;
}

/**
 * G3：审计规则来自 evowork（H4）。管道在它之上只做两件事：诱导安装 → 拒收；含二进制 → 拒收
 * （「含二进制文件的直接剔除」，13 §7.1）。P2 进人工。
 */
export function gateSecurity(audit: AuditLike): SecurityVerdict {
  const codes = [...new Set(audit.findings.map((f) => f.code))];
  const lure = audit.findings.find((f) => f.lure === true);
  const binary = audit.findings.find((f) => f.code === 'binary');
  const reject = lure !== undefined ? `诱导安装：${lure.detail}` : binary !== undefined ? `含二进制：${binary.detail}` : undefined;
  return {
    level: audit.level,
    codes,
    ...(reject !== undefined ? { reject } : {}),
    manual: reject === undefined && audit.level === 'p2',
  };
}

/* ── G4 ─────────────────────────────────────────────────────────────────── */

import { builtinModules } from 'node:module';

export interface CompatVerdict {
  /** 不满足就不收（计入统计，13 §7.3）。 */
  readonly blockers: readonly string[];
  /** 标出来给人看，不挡。 */
  readonly flags: readonly string[];
  /** 办公运行时满足不了的 Python 顶层模块。 */
  readonly missingPython: readonly string[];
  /** 引用了技能目录之外的插件代码（单独打包会断）。 */
  readonly outsideSkill: readonly string[];
  /** 需要运行时安装的 npm 包（包里没带 node_modules）。 */
  readonly missingNode: readonly string[];
  /** 文本里出现的域名（「要联网的必须声明域名」）。 */
  readonly hosts: readonly string[];
}

const HOST_MARKERS: readonly [RegExp, string][] = [
  [/\$\{?CLAUDE_PLUGIN_ROOT\}?/, '依赖特定宿主的变量 ${CLAUDE_PLUGIN_ROOT}'],
  [/^\s*allowed-tools\s*:/m, 'frontmatter 里有别家的 allowed-tools'],
  [/\b(?:use|using) the Bash tool\b/i, '写的是「用 Bash 工具」这类别家工具名'],
];

/** node 自带的模块（含 `node:test` 这种只能带前缀写的）。 */
const NODE_BUILTIN = new Set([...builtinModules, 'test', 'sqlite', 'sea']);

/**
 * 这些目录里的代码是**给模型读的材料**（示例、参考、模板），不是技能自己要跑的脚本 ——
 * 它们 import 什么，是用户项目的依赖，不该挡住技能本身（V2 实测：Shopify 的 TS 示例曾把 7 个技能全判成「缺 npm 包」）。
 */
const READING_DIRS = /(?:^|\/)(?:references?|examples?|templates?|assets|docs?|samples?)\//i;

export function gateCompat(input: {
  readonly files: readonly SkillFile[];
  readonly name: string;
  readonly description: string;
  /** stdlib + 办公运行时能 import 的顶层模块。 */
  readonly pythonModules: ReadonlySet<string>;
  /** 插件里、技能目录之外的顶层模块名（目录或 .py）。 */
  readonly pluginModules?: ReadonlySet<string> | undefined;
}): CompatVerdict {
  const blockers: string[] = [];
  const flags: string[] = [];
  // HF9（evowork F44）：name ≤ 64、description ≤ 1024
  if (input.name === '') blockers.push('SKILL.md 没有 name');
  if (input.name.length > 64) blockers.push(`name 超过 64 字符（${input.name.length}）`);
  if (input.description === '') blockers.push('SKILL.md 没有 description');
  if ([...input.description].length > 1024) blockers.push(`description 超过 1024 字符（${[...input.description].length}）`);

  const ownModules = new Set(
    input.files
      .filter((f) => f.relativePath.endsWith('.py'))
      .map((f) => f.relativePath.split('/').pop()!.replace(/\.py$/, '')),
  );
  const packageDirs = new Set(
    input.files.filter((f) => f.relativePath.endsWith('/__init__.py')).map((f) => f.relativePath.split('/').slice(-2)[0]!),
  );
  const missingPython = new Set<string>();
  const outsideSkill = new Set<string>();
  const missingNode = new Set<string>();
  const hosts = new Set<string>();
  const hasNodeModules = input.files.some((f) => f.relativePath.includes('node_modules/'));
  for (const f of input.files) {
    const text = f.text ?? '';
    for (const [re, label] of HOST_MARKERS) if (re.test(text) && !flags.includes(label)) flags.push(label);
    for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) hosts.add(m[1]!.toLowerCase());
    const runnable = !READING_DIRS.test(f.relativePath);
    if (runnable && f.relativePath.endsWith('.py')) {
      for (const m of text.matchAll(/^\s*(?:from\s+([A-Za-z_][\w]*)[\w.]*\s+import|import\s+([A-Za-z_][\w]*))/gm)) {
        const mod = (m[1] ?? m[2])!;
        if (input.pythonModules.has(mod) || ownModules.has(mod) || packageDirs.has(mod)) continue;
        if (input.pluginModules?.has(mod) === true) outsideSkill.add(mod);
        else missingPython.add(mod);
      }
    }
    if (runnable && /\.(?:mjs|cjs|js|ts)$/.test(f.relativePath) && !hasNodeModules) {
      for (const m of text.matchAll(/(?:require\(\s*|from\s+|import\s*\(\s*)['"]([^'"./~#][^'"]*)['"]/g)) {
        const spec = m[1]!.replace(/^node:/, '');
        const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
        if (!NODE_BUILTIN.has(spec) && !NODE_BUILTIN.has(pkg)) missingNode.add(pkg);
      }
    }
  }
  if (outsideSkill.size > 0) {
    blockers.push(`引用了技能目录之外的插件代码：${[...outsideSkill].sort().join('、')}（单独打包会断）`);
  }
  if (missingPython.size > 0) blockers.push(`办公运行时没有的 Python 模块：${[...missingPython].sort().join('、')}`);
  if (missingNode.size > 0) blockers.push(`要在运行时安装的 npm 包：${[...missingNode].sort().join('、')}`);
  return {
    blockers,
    flags,
    missingPython: [...missingPython].sort(),
    outsideSkill: [...outsideSkill].sort(),
    missingNode: [...missingNode].sort(),
    hosts: [...hosts].sort(),
  };
}

/* ── 去向 ───────────────────────────────────────────────────────────────── */

export type Verdict = 'accept' | 'index-only' | 'manual' | 'reject';

export interface SkillDecision {
  readonly verdict: Verdict;
  /** 拒收时：哪道闸。 */
  readonly gate?: 'G2' | 'G3' | 'G4' | undefined;
  readonly reasons: readonly string[];
}

/**
 * 去向：G2 限制 → 拒；G3 诱导 / 二进制 → 拒；G4 有阻断 → 拒；G3 P2 → 人工；
 * 没写许可 → 只做索引（HUB-Q5a=A）；其余 → 收。
 */
export function decide(license: LicenseVerdict, security: SecurityVerdict, compat: CompatVerdict): SkillDecision {
  if (license.class === 'restricted') {
    return { verdict: 'reject', gate: 'G2', reasons: [`许可不在白名单：${license.spdx}（来自 ${license.from}）`] };
  }
  if (security.reject !== undefined) return { verdict: 'reject', gate: 'G3', reasons: [security.reject] };
  if (compat.blockers.length > 0) return { verdict: 'reject', gate: 'G4', reasons: [...compat.blockers] };
  if (security.manual) return { verdict: 'manual', reasons: [`P2：${security.codes.join('、')}`] };
  if (license.class === 'none') return { verdict: 'index-only', reasons: ['没写许可：只做索引、不托管不改写（HUB-Q5a=A）'] };
  return { verdict: 'accept', reasons: [] };
}
