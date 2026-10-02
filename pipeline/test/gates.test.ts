import { describe, expect, it } from 'vitest';

import { classifySpdx, decide, detectLicenseText, gateCompat, gateLicense, gateSecurity } from '../gates.ts';

const MIT = 'Permission is hereby granted, free of charge, to any person obtaining a copy';
const PY = new Set(['os', 'sys', 'json', 'docx', 'openpyxl']);

describe('G2 许可：逐个技能判（CLAUDE.md H10）', () => {
  it('SPDX 表达式：AND 每项都宽松、OR 有一项宽松；认不出来的按限制', () => {
    expect(classifySpdx('MIT')).toBe('permissive');
    expect(classifySpdx('Apache-2.0 AND CC-BY-4.0')).toBe('permissive');
    expect(classifySpdx('MIT AND GPL-3.0-only')).toBe('restricted');
    expect(classifySpdx('(MPL-2.0 OR Apache-2.0)')).toBe('permissive');
    expect(classifySpdx('Proprietary')).toBe('restricted');
    expect(classifySpdx('LicenseRef-Figma-Developer-Terms')).toBe('restricted');
    expect(classifySpdx('NOASSERTION')).toBe('none');
  });

  it('同一个仓库里混着两种许可：技能自己的 LICENSE 优先于仓库根', () => {
    const verdict = gateLicense({
      skillFiles: [{ relativePath: 'LICENSE.txt', text: '© Acme. All rights reserved. Proprietary.' }],
      repoLicenseText: `MIT License\n${MIT}`,
    });
    expect(verdict).toMatchObject({ class: 'restricted', from: 'skill-license-file' });
  });

  it('哪儿都没写 → NOASSERTION（只做索引，不是「宽松」）', () => {
    expect(gateLicense({ skillFiles: [] })).toEqual({ spdx: 'NOASSERTION', class: 'none', from: 'none' });
  });

  it('写了 LICENSE 但认不出是什么 → 按限制，不放行', () => {
    expect(gateLicense({ skillFiles: [{ relativePath: 'LICENSE', text: 'Do what you want, maybe.' }] }).class).toBe(
      'restricted',
    );
  });

  it('常见许可证正文认得出来', () => {
    expect(detectLicenseText(`MIT License\n${MIT}`)).toBe('MIT');
    expect(detectLicenseText('Apache License\nVersion 2.0, January 2004')).toBe('Apache-2.0');
    expect(detectLicenseText('GNU GENERAL PUBLIC LICENSE Version 3')).toBe('LicenseRef-copyleft');
  });
});

describe('G3 安全', () => {
  it('诱导安装、二进制 → 拒；P2 → 人工；其余放行', () => {
    expect(gateSecurity({ level: 'p2', findings: [{ code: 'pipe-to-shell', detail: 'x', lure: true }] }).reject).toMatch(
      /诱导安装/,
    );
    expect(gateSecurity({ level: 'p2', findings: [{ code: 'binary', detail: 'a.exe' }] }).reject).toMatch(/二进制/);
    expect(gateSecurity({ level: 'p2', findings: [{ code: 'hooks', detail: 'x' }] })).toMatchObject({ manual: true });
    expect(gateSecurity({ level: 'p1', findings: [{ code: 'commands', detail: 'x' }] })).toMatchObject({ manual: false });
  });
});

describe('G4 兼容', () => {
  const run = (files: { relativePath: string; text?: string }[], extra: Partial<Parameters<typeof gateCompat>[0]> = {}) =>
    gateCompat({ files, name: 'x', description: 'd', pythonModules: PY, ...extra });

  it('HF9：name ≤ 64、description ≤ 1024', () => {
    expect(run([], { name: 'a'.repeat(65) }).blockers.join()).toMatch(/64/);
    expect(run([], { description: '字'.repeat(1025) }).blockers.join()).toMatch(/1024/);
  });

  it('运行时满足不了的 import → 阻断，并记下缺哪个（13 §7.3 的统计口径）', () => {
    const v = run([{ relativePath: 'scripts/run.py', text: 'import requests\nfrom docx import Document\nimport os' }]);
    expect(v.missingPython).toEqual(['requests']);
    expect(v.blockers.length).toBe(1);
  });

  it('references / examples 里的代码是给模型读的，不算依赖', () => {
    const v = run([
      { relativePath: 'references/sample.py', text: 'import requests' },
      { relativePath: 'examples/app.ts', text: "import { x } from '@shopify/ui-extensions'" },
    ]);
    expect(v.blockers).toEqual([]);
  });

  it('node 自带模块（含 node:test、module）不是要装的 npm 包；路径别名 ~ 也不是', () => {
    const v = run([
      {
        relativePath: 'scripts/check.mjs',
        text: "import test from 'node:test'\nimport { createRequire } from 'module'\nimport x from '~/lib'\nimport y from 'zod'",
      },
    ]);
    expect(v.missingNode).toEqual(['zod']);
  });

  it('引用技能目录之外的插件代码 → 单独打包会断，说清楚是这个原因', () => {
    const v = run([{ relativePath: 'scripts/run.py', text: 'from shared.artifacts import x' }], {
      pluginModules: new Set(['shared']),
    });
    expect(v.outsideSkill).toEqual(['shared']);
    expect(v.blockers.join()).toMatch(/技能目录之外/);
  });

  it('技能自带的模块不算缺', () => {
    expect(run([{ relativePath: 'scripts/a.py', text: 'import helper' }, { relativePath: 'scripts/helper.py', text: '' }]).blockers).toEqual([]);
  });
});

describe('去向', () => {
  const ok = { level: 'p0' as const, codes: [], manual: false };
  const compat = { blockers: [], flags: [], missingPython: [], outsideSkill: [], missingNode: [], hosts: [] };
  it('许可先判：限制许可哪怕别的都过也拒', () => {
    expect(decide({ spdx: 'Proprietary', class: 'restricted', from: 'plugin-manifest' }, ok, compat)).toMatchObject({
      verdict: 'reject',
      gate: 'G2',
    });
  });
  it('没写许可且其余都过 → 只做索引（HUB-Q5a=A）', () => {
    expect(decide({ spdx: 'NOASSERTION', class: 'none', from: 'none' }, ok, compat).verdict).toBe('index-only');
  });
});
