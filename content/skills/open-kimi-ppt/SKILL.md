---
name: open-kimi-ppt
description: 创建、编辑和复刻演示文稿，交付可编辑的 PPTD 项目和 PPTX 文件。适用于需要自由排版、参考模板或主题设计的幻灯片任务。
---

# Definition
open-kimi-ppt 使用 PPTD 中间格式创建和编辑演示文稿。本包通过 EvoWork 办公组件在本机生成可编辑 PPTX；图片校验可选地使用在线编辑器的本机渲染。

**先读 `reference/evowork-local-export.md`，只生成其中支持的元素。该页定义本适配包的真实导出范围，优先于上游参考中的高级能力。**

**The default output is not PPTD-only.** Unless the user explicitly opts out, always produce both:

1. the complete editable PPTD project directory (`.pptd` + `pages/` + `media/` and other referenced dependencies);
2. the matching locally generated `.pptx`, with fade slide transitions applied by default. Fonts are referenced from the receiving system and are not embedded.

Existing PPTX files may also be converted into PPTD for editing, after which both outputs are delivered again.

## The pptd format
The .pptd format is a simplified abstraction layer over OOXML that follows basic YAML syntax. This abstraction preserves the core content of OOXML (theme, page layout, element positions and definitions, etc.) while removing complex nesting logic such as Masters; every page is self-contained — what you see is what you get. Read reference/pptd.md for the complete definition of this DSL.

## PPT production workflow

### step0. 本机环境检查
先定位本技能目录（即当前 SKILL.md 所在目录），以下 `<技能目录>` 都指这个绝对路径，不要假定安装在共享目录。
先定位 EvoWork 管理的办公 Python（优先 `EVOWORK_OFFICE_PYTHON`，否则检查 `~/.evowork/runtime/office/bin/python3`、`bin/python`、`python.exe`、`Scripts/python.exe`）；以下 `<办公Python>` 代表选中的绝对解释器路径。不要求客户另装系统 Python。若均不存在，请客户在 EvoWork 设置中安装办公组件。
运行 `"<办公Python>" "<技能目录>/scripts/runtime.py"` 检查浏览器和办公组件。
- Python 依赖 PyYAML、websocket-client 已随插件打包；不需要 Node.js、npm 或命令行浏览器工具。
- 图片校验使用 EvoWork 的办公组件，脚本会自动选择其 Python。缺少时请用户在 EvoWork 设置中安装或修复办公组件，不要自行安装包。
- 本地 PPTX 导出不需要浏览器。图片校验缺少 Chrome、Chromium 或 Edge 时明确提示安装；客户要求离线时继续本地导出，并说明跳过了图片校验。不要改用用户的浏览器登录会话。
- PPTX 转换不联网。只有图片校验需要加载 `www.kimi.com`、`statics.moonshot.cn`、`statics.kimi.ai` 的编辑器静态资源；先向用户说明这个要求。专用会话禁止上传、遥测和任意资源地址。
- 媒体请先下载到项目 `media/`，再使用相对路径；导出器只加载编辑器静态资源，不访问任意远程图片或字体地址。
- 这是非官方兼容实现，在线编辑器更新可能造成图片校验失败。遇到不支持的 PPTD 特性或校验错误如实报告并保留完整项目，不临时安装软件或换通道绕过失败。

### step1. Read the context thoroughly
Read **all files uploaded by the user**, the provided URLs, and the pptd format guide `reference/pptd.md` to fully understand the user's requirements.

### step2. Understand the user's requirements
Understand the user's requirements based on the context:
1. First determine the purpose of the request
  - Create a PPT: create a new presentation (from scratch, or from an existing pptx template)
  - Edit a PPT: edit the user's uploaded PPT (local modifications, single-page beautification, etc.)
  - Replicate a PPT: replicate a presentation from a non-pptx format (images, PDF, etc.) into pptd format

2. Then determine the design direction
  - Self-directed design: no preference, or only simple style constraints given; you need to fill in or create the design
  - Design system: a preset design system from the skill (`reference/design_system/`) is specified, or the user provides a complete and detailed design scheme covering all color, font, layout, and component specifications
  - Use a template: a template is provided and must be used
  - Style transfer: a style reference source is provided (images, web pages, etc.)

3. Then determine the input type
  - Topic only: only a PPT topic direction or content requirements for the presentation are given, with no concrete content
  - Full document: the user provides a complete document (paper, research report, press release, etc.)
  - Outline: the user provides a page-by-page outline, speech script, or similar content
  * When the "user input type" is [Full document] or [Outline] and it is not specified whether expansion is allowed: since a page-by-page outline, speech script, or user document can hardly support the full content of a presentation, prefer using search to expand with more relevant material, cases, etc., unless the user explicitly says not to expand

4. Finally determine the exact page count
  - If the user requests a specific page count, the user's requirement takes priority
  - Page-by-page outline/script provided: match the number of pages in the outline/script
  - When a complete and relatively structured document is provided: ask the user how much document content one page should cover, and give an estimated total page count; when only a topic is provided: suggest a recommended page count and confirm with the user

#### Clarification and follow-up questions
When any of the following situations arise, resolve them by asking the user (use the agent's ask/clarification tool when available)
1. Requirements are ambiguous
- The user's intent is unclear or hard to understand
- The files/URLs provided by the user are inaccessible
2. Conflicting intents
- The user's intents contradict each other. For example:
  * A design system is selected while also requesting a style that is completely inconsistent with that design system (e.g., using a McKinsey style while requiring large areas of whitespace on pages) / using a template / referencing an image style
  * Requesting both "make 10 pages" and "deliver 30+ pages of output"
3. Unable to determine the user's requirements on your own
- When the purpose, design direction, input type, page count, etc. are hard to determine by yourself

### step3. Generate the presentation based on the user's requirements

Before generating, first read `reference/pptd.md` to understand the pptd format definition and constraints.

#### Replicating a PPT
- Analyze the images to estimate element positions, fonts and sizes, etc., and **replicate 1:1 as closely as possible**.
- For parts that are difficult to make out, use methods such as grid lines and close-up views to improve understanding.
- Replicate simple content in the image with elements; icons may be approximated with icons provided by Font Awesome. For content that cannot be approximated with icons or shapes, such as photos and avatars, use tools such as bash or python to crop and split the original image, then add the resulting image elements to the presentation

#### Editing a PPT
- Convert the user's uploaded pptx file to .pptd format
- Review the converted pages (structure and key visual details). Read a few key pages individually afterwards.
- Locate the pages to edit, and be careful not to affect parts outside the intended scope.
> Conversion from pptx to pptd is not perfectly lossless. If the user later reports format errors, garbled content, etc., compare against the original pptx and repair the pptd with reference to the comparison

#### Generating a PPT
When generating a PPT, adopt different production approaches for different user [design directions]
##### Self-directed design
1. Read the design guide `reference/slides_categories.md`, and read the scenario document corresponding to the user's query
2. Produce the presentation based on the above

#### Generating content in other formats
- When the user explicitly asks for an infographic, poster, or a highly visual single-page design, read `reference/general-poster.md` and implement it as a single-page or few-page editable PPTD; when the user only asks for an image, still build it with PPTD first, then output the image via screenshot or rendering. Do not load this reference file for ordinary PPT requests.

##### Design system
1. Read the general constraints section of the `reference/slides_categories.md` guide, and read the scenario document corresponding to the user's query as the design foundation
2. Read the specified design system as the presentation style: either the user-provided design scheme, or the matching preset under `reference/design_system/` (search by name / path the user specified; prefer the folder's `design.md` when present). It is strictly forbidden to reference or mix in other design styles
3. Produce the presentation with reference to the above
4. Do not auto-pick a preset during self-directed design; only use `reference/design_system/` when a preset is explicitly specified

##### Using a template
1. Convert the user's uploaded pptx file into pptd form
2. Review the converted pages to understand the template's visual style (color scheme, font style, element characteristics, layout characteristics, content density, etc.)
3. Identify page types; focus on reading special pages such as the cover, summary pages, and section dividers (single-page screenshots, .page files), extracting their page layouts, content structures, reusable components (icons, shapes, smartart, reusable body layout schemes, etc.), and element styles (e.g., whitespace/line/card separators, square/rounded corners, etc.)
4. Produce the presentation using the template

##### Style transfer
1. Analyze the reference file's visual style (color scheme, font style, element characteristics, layout characteristics, content density, etc.), page layouts, content structures, reusable components (icons, shapes, smartart, reusable body layout schemes, etc.), and element styles (e.g., whitespace/line/card separators, square/rounded corners, etc.).
- If the user provides a style reference URL, do not only read the text content; refer to and learn from the page's visual effect more to help understand the style
2. Produce the presentation using the reference file's style characteristics. You are encouraged to reuse illustrations, fonts, font-size hierarchies, elements, etc. from the original pdf/url

##### Images and Visual Materials
1. Images are an effective way to enrich a presentation's visual impact. Appropriate images should be used not only on covers and section dividers, but also on body pages to enrich the page, aid understanding, or support decision-making
2. Images are used to show concrete subjects, explain content, provide evidence, or establish a scene. Logos, icons, decorative textures, and very small thumbnails do not count as substantive imagery.
3. When a page involves products, people, places, buildings, events, cases, interfaces, experimental subjects, or spatial environments, prioritize corresponding real images or screenshots. If real images and screenshots cannot be obtained, generated images may be used instead.
4. Image priority: images provided by the user; images from official websites, official reports, and credible sources; searched images that are directly relevant to the content; images generated for conceptual expression or atmosphere.
5. After deciding which images are needed, complete image search, generation, and downloading in a batch before designing pages around their proportions. Save images in the `media` directory, keep them clear, and never stretch or distort them.
6. Analytical, technical, and academic PPTs should use corresponding evidence images when products, experiments, interfaces, cases, or on-site materials are available. Do not reduce every page to text, color blocks, and shapes.
7. Do not add irrelevant images merely to meet a quantity target. Every image must be directly relevant to the page's conclusion or communication goal.

##### Content Guidelines
1. Language style: unless the user explicitly requests otherwise, strictly avoid overly abstract expressions and uncommon metaphors
- Do not overuse metaphors, slogans, or abstract jargon such as distribution, an N-step argument, everything at a glance, a closed loop, hands-on practice, verification, deconstruction, second-class citizens, poison pills, or wall clocks
- Do not use common AI phrasing such as “not X, but Y,” “X is Y,” “why / based on what / how,” “key takeaway,” or “N battlefronts / paths”
- Do not use overly colloquial expressions such as “where should the ammunition go,” “the Nth thing,” “can't pick the right one,” or “cannot be used as X”

### step4. PPT validation
1. Validate the generated pptd against the format definition in `reference/pptd.md` (required fields, types, bounds, theme tokens, resource paths, etc.) and repair issues over multiple rounds
2. Visual review with exported page images — use when the model supports image input and the customer permits online editor resources. For offline tasks, perform structural QA and explicitly state that visual QA was skipped:
   - Run `scripts/export_images.py`. It loads the deck into Kimi's public editor, chooses 导出 → 图片, downloads the images ZIP, unzips it, and stitches all pages into one overview image:

     ```bash
     "<办公Python>" "<技能目录>/scripts/export_images.py" \
       /abs/path/project/deck.pptd \
       --output /abs/path/project/.qa-images
     ```

     The script prints a JSON summary mapping each stitched label (`P1`…`Pn`, 1-based page order) to its `.page` file.
   - Read the stitched overview image (`.qa-images/overview.jpg`) and check every page against this list:
     1. 图片是否清晰、不变形（无拉伸、压缩、模糊）
     2. 文字是否压在关键画面（人脸、产品主体、Logo 等）上
     3. 元素坐标是否超出页面边界
     4. 边界与配色对比是否足够（文字与背景、相邻色块之间）
     5. 排版是否统一（对齐、间距、字号层级、页边距）
     6. 文字是否可能溢出文本框（文本过长、行距过密、字号过大）
     7. 内容是否被上层元素遮挡
   - For any suspicious page, read its full-resolution image (`.qa-images/pages/<n>.jpeg`) to confirm the problem before editing.
   - Fix issues in the corresponding `.page` file, then re-run `scripts/export_images.py --force` and review the new overview; repeat until every page passes.
   - Do not export the PPTX until the visual review passes. `.qa-images/` is an intermediate QA artifact and may be deleted after delivery.
3. When the model cannot read images, fall back to a structural review of the generated pages (bounds, overflow-prone long text, contrast, hierarchy, layout density) over multiple rounds, and state that image-based visual QA was skipped.

### step5. PPT output and delivery
1. Always produce a self-contained project directory. Keep the `.pptd` manifest and every referenced dependency together; never deliver a standalone manifest without its referenced files. Use this layout unless an existing project already has a valid equivalent structure:

   ```text
   deck/
     deck.pptd
     pages/
       *.page
     media/
       *                # when the deck has local media
     deck.pptx          # generated by default
   ```

2. Generate the `.pptx` by default after PPTD validation, even when the user only asks to create or edit a presentation. Skip PPTX export only when the user explicitly requests PPTD-only output or the environment cannot run the exporter; in the latter case, report the exact blocker and still deliver the complete PPTD project.
3. Deliver with normal clickable local links using absolute paths. In the final response, link all of the following:
   - the project directory;
   - the `.pptd` manifest;
   - the `pages/` directory and `media/` directory when present;
   - the generated `.pptx` file.
4. PPTX conversion: use `scripts/export_pptx.py`. It uses the managed office runtime to generate native editable PowerPoint elements locally, without loading Kimi or uploading the document, then validates the ZIP/slide structure. The online image QA result represents PPTD, not a screenshot of the final PPTX; state this limit when pixel fidelity matters.
5. Default PPTX options:
   - page transition: `fade` (淡入淡出), written to every slide after local conversion;
   - font embedding: not supported by the local writer; use system fonts and disclose this limitation;
   - slide transitions may be explicitly disabled with `--transition none`. `--no-embed-fonts` acknowledges the local writer’s font behavior.
6. Export command:

   ```bash
   "<办公Python>" "<技能目录>/scripts/export_pptx.py" \
     /abs/path/project/deck.pptd \
     --output /abs/path/project/deck.pptx
   ```

   A project directory may be passed instead of the manifest only when it contains exactly one `.pptd` file.
   Existing output files are not overwritten unless `--force` is passed.
7. 图片校验使用独立临时浏览器配置和本次专用下载目录，结束后关闭会话，不读取客户浏览器登录态或下载目录。默认不覆盖已有产物；只有用户已授权替换时才传 `--force`。
8. 交付时说明 PPTX 导出和图片校验是否实际完成。可继续修改 PPTD 和页面文件后重新执行脚本。本适配包不提供上游的交互网页编辑器，不提示客户运行包管理器命令。
