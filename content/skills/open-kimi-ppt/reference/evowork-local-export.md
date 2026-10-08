# EvoWork 本地导出范围

创建或修改 PPTD 前先读这一页。本包使用本地办公组件转换 PPTX，不调用上游当前网页的文稿上传/服务端转换接口。

## 已支持

- PPTD v2、逐页布局、元素顺序、旋转、翻转、主题颜色和文本样式。
- 文本框和常用 HTML 富文本：p/div/span、strong/b、em/i、u、s/strike、sup/sub、br、ul/ol/li、a；字号、字体、粗斜体、颜色、对齐、行距、字距、上边距。列表当前统一显示圆点，不保留自动编号。
- 预设形状（如 rect、roundRect、ellipse、triangle、diamond、chevron、rightArrow、star5），实色和线性渐变填充、实线/虚线/点线边框。
- 项目内的 PNG/JPEG/GIF 等本地位图，cover/contain/fill、比例裁剪和透明度；图片背景。
- 两点直线及首尾箭头；复杂曲线请先改成直线或本地图片。
- 原生可编辑表格、行列尺寸、单元格合并、主题样式、单元格填充和边框。
- 简单同类分类图：bar（竖向分组柱）、line、area、pie、radar；原生可编辑数据。使用 data.cols/rows、encode.x/y（pie 用 category/value，radar 用 category/y）、name、title、legend。图表的高级坐标轴、堆叠、水平柱、混合系列和数据标签配置不在本地支持范围，生成时不要写入。
- 默认写入淡入淡出翻页切换；可用 `--transition none` 关闭。

## 生成约束与失败处理

- 不使用 custom SVG path、Font Awesome icon 元素、阴影、页内动画、文本渐变或远程 customFonts。需要复杂视觉时先生成/下载为本地 PNG，再用 image 元素。PPTD 文本、标准形状、表格、图表保持可编辑，图片部分作为图片编辑。
- 不把整页截图当作可编辑 PPTX 交付；不支持的元素要明确告诉用户，保留完整项目，按用户需求选择改写成支持的元素或保留 PPTD。
- 所有图片先存入项目 media/，不在转换时联网下载。参考文件中的 `$theme` 需要在主题中定义。
- 字体使用接收方已安装的系统字体。本地转换器不嵌入字体，`--embed-fonts` 仅保留为兼容参数并输出明确提示。不能承诺换机器后文字排版完全一致。
- 原生图表使用办公软件的默认样式，不能承诺逐像素复刻在线编辑器；表格和富文本也应在交付软件里复核。
- 图片校验固定本轮验证过的静态资源 URL 与 MiSans 字体，发送固定请求头，不附带客户 Cookie 或自定义数据头。上游资源变更或其他在线字体可能导致校验失败，不自动扩大白名单。
- 图片校验脚本渲染的是 PPTD，仍需本机 Chrome/Chromium/Edge 和在线编辑器静态资源（www.kimi.com、statics.moonshot.cn、statics.kimi.ai），不是对最终 PPTX 的截图验证。若客户要求完全离线，跳过这一步并明确说明仅完成结构校验，不声称完成视觉校验。
- 缺少办公组件：让客户在 EvoWork 设置中安装或修复；缺少浏览器：提示安装 Chrome、Chromium 或 Edge。不要自行运行包管理器安装依赖。

## 命令

`<技能目录>` 是当前 SKILL.md 所在的绝对目录；`<办公Python>` 是 SKILL.md 环境检查选中的管理解释器。不依赖客户安装系统 Python。

```bash
"<办公Python>" "<技能目录>/scripts/runtime.py"
"<办公Python>" "<技能目录>/scripts/export_images.py" /abs/project/deck.pptd --output /abs/project/.qa-images
"<办公Python>" "<技能目录>/scripts/export_pptx.py" /abs/project/deck.pptd --output /abs/project/deck.pptx
```

导出结果包含 engine、networkUsed、fontEmbeddingSupported，便于核验处理方式。已有输出默认拒绝覆盖；客户已明确授权替换时才能使用 `--force`。
