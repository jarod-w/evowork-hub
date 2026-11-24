# 文献引用的来源与改动

- 取自 [https://github.com/YouStudyeveryday/academic-citation-manager](https://github.com/YouStudyeveryday/academic-citation-manager/tree/372286ce1acae58bc0c6cd4270282ff07ef95ea7) 的固定提交。仓库根 `LICENSE` 是 Apache-2.0，上游没有 NOTICE。`SKILL.md` frontmatter 写了 MIT，与许可证正文不一致，托管版本以 `LICENSE` 为准，并去掉了这条 frontmatter。
- 展示名称、简介和分类改为中文，写入 `interface.json`。默认不进入提示词目录。
- 去掉只在其他宿主生效的 frontmatter：homepage、user-invocable、version、tags、author、license。
- `academic_citation_skill.py` 的 HTTP 从第三方库改为 Python 标准库 `urllib`。办公运行时没有那个库，不在安装时拉包。请求地址仍是 `api.crossref.org` 和 `openlibrary.org`。
- 同一文件里三处作者名单的 f-string 写了非法转义，原文件无法被 Python 解析。改成普通引号后才能运行。
- 保存文献时补上空的 `id`，再写成可序列化的字典。原来会在 `Reference` 构造时缺 `id`，数据库也写不进去。
- 按标题搜索时，接口返回的是单条文献而不是带 `message` 的整包。解析前补上这一层，否则标题是空的。查询字段 `doi` 改为 `DOI`，否则接口返回 400。
- 不收录 `README.md`、`COMPLETION_SUMMARY.md`、`PROJECT_COMPLETION_SUMMARY.md`。这三份文件要求安装第三方包，不是技能运行所需。
- 不收录上游的 `agents/openai.yaml`。安装时由客户端按目录里的按需层标记写入启用策略。
