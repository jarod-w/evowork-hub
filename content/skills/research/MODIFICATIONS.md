# 调研提纲的来源与改动

- 取自 [https://github.com/Weizhena/Deep-Research-skills](https://github.com/Weizhena/Deep-Research-skills/tree/6ce38f60e3f8b22502c29873f96503a4e0c5addb/skills/research-zh/research) 的固定提交，保留原 `LICENSE`。只收录 `SKILL.md`。
- 展示名称、简介和分类改为中文，写入 `interface.json`。默认不进入提示词目录。
- 去掉只在其他宿主生效的 frontmatter：user-invocable、allowed-tools。
- 询问用户改为在对话里确认。不能检索网页时向用户要来源，不编造网址。
- 后续命令改成使用已收录的 `research-report`。未收录补充条目、补充字段和深度调研技能。
- `validate_json.py` 依赖 PyYAML，办公运行时没有这个模块，提纲步骤也不调用它，所以没有收录。
- 不收录上游的 `agents/openai.yaml`。安装时由客户端按目录里的按需层标记写入启用策略。
