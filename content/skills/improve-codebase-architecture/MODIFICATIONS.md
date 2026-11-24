# 架构加深的来源与改动

- 取自 [https://github.com/mattpocock/skills](https://github.com/mattpocock/skills/tree/abeeaf95660ba9e8b7c753eb38f441ca707a8823/skills/engineering/improve-codebase-architecture) 的固定提交，保留原 `LICENSE`。
- 展示名称、简介和分类改为中文，写入 `interface.json`。默认不进入提示词目录。
- 去掉只在其他宿主生效的 frontmatter：disable-model-invocation。讨论步骤改为调用已收录的 grill-me，不再指向未收录的 grilling。
- 报告模板仍从 `cdn.tailwindcss.com` 和 `cdn.jsdelivr.net` 加载样式与图。这是用户打开本地报告时的页面资源，不是安装程序。。
- 不收录上游的 `agents/openai.yaml`。安装时由客户端按目录里的按需层标记写入启用策略。
