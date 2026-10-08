# EvoWork 适配记录

上游：acnlie/open-kimi-ppt-skill @ c32890fe0985bdf668f2722fed30f1010bdf24c9（1.2.0，MIT）。原 LICENSE 保留。

- 中文发现说明和元数据；技能目录动态定位，不依赖共享安装路径。
- 随包提供 PyYAML 6.0.2（MIT，纯 Python）与 websocket-client 1.7.0（Apache-2.0，纯 Python），各包保留 LICENSE、UPSTREAM。去掉后者可选 wsaccel 加速及 SOCKS 依赖，使用原纯 Python 回退；仅连接本机 CDP。
- 移除运行时 pip/npm 安装、Node.js 和 agent-browser 依赖；固定的图片校验流程直接连接独立 Chrome/Chromium/Edge 会话。浏览器连接器当前不支持跨站 iframe，因此不复用其通用动作接口，也不改变其安全策略。
- 图片拼接使用现有办公组件中的 Pillow；缺少时给出安装/修复组件提示，不修改系统环境。
- 图片校验浏览器只允许本地导出服务及 Kimi 编辑器静态 GET 资源，具体 URL 固定在 scripts/editor-resources.json；使用固定请求头，拒绝 Cookie、自定义数据头、外部写请求、WebSocket 和任意网络图片地址；临时配置和下载隔离，不使用客户登录态。
- 保留上游 PPTD 参考、项目读取、PPTX 转场与结构校验；不包含上游网页编辑器和演示图片。
- 2026-10-08 真实验证发现当前 Kimi PPTX 接口包含上传/服务端转换路径，故禁用浏览器 PPTX 导出，新增基于 python-pptx 的本地转换器。支持范围见 reference/evowork-local-export.md；字体不嵌入，部分高级元素不支持且明确报错。
- PPTX 转换离线可用；图片校验仍依赖公开网页，协议或资源更新可能失效。PPTD 图片不等同于最终 PPTX 的截图。

## 待发布版本 1.2.0-evowork.2

在 interface.json 声明 runtimeDependencies 为 office，供支持此契约的客户端在安装确认后准备共享办公组件。最低应用版本暂定 0.0.6，发布前须核对实际发货版本；此源码更新尚未发布，线上仍为 1.2.0-evowork.1。
