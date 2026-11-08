---
name: 科技深色
description: 克制的深色科技界面——石墨蓝底、高可读文字、一点数据青,像专业监控台而非霓虹夜店
name_en: "Tech Dark"
description_en: "A restrained dark technical interface: graphite-blue ground, highly legible text and a hint of data cyan. A professional monitoring console, not a neon nightclub."
suits: "工具产品"
colors:
  bg: "#0B0E14"
  surface: "#151A23"
  primary: "#E6EAF2"
  secondary: "#8A93A6"
  accent: "#2DD4BF"
  line: "#232B38"
fonts:
  latin: "'IBM Plex Sans'"
  cjk: sans
typography:
  headline:
    fontSize: "24px"
    fontWeight: 600
  body:
    fontSize: "14px"
    lineHeight: 1.7
    measure: "72ch"
    fontWeight: 400
  data:
    latin: "'IBM Plex Mono', 'JetBrains Mono'"
    fontWeight: 500
border:
  width: "1px"
  style: solid
  emphasis: "1px"
rounded:
  sm: 6px
  md: 10px
spacing:
  unit: 8px
status:
  warning: "#F2B26B"
imagery:
  ratio: "16:9"
  treatment: none
  crop: rounded
icon:
  style: line
  strokeWidth: "1.5px"
  linecap: butt
  corner: sharp
components:
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "16px"
  button-primary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    height: "32px"
    padding: "12px"
  button-primary-hover:
    backgroundColor: "{colors.line}"
  button-secondary:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.secondary}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    height: "32px"
    padding: "12px"
  input-field:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.primary}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    height: "32px"
    padding: "10px"
  tag:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.accent}"
    typography: "{typography.data}"
    rounded: "{rounded.sm}"
    height: "20px"
    padding: "8px"
  metric-value:
    textColor: "{colors.accent}"
    typography: "{typography.data}"
---

## Overview

参照物:专业交易终端、航天任务控制室的屏幕、开发者工具的深色主题。
深色不是为了酷,是为了让数据发光。底色是带一点蓝的石墨,不是纯黑;
强调色是冷静的数据青,只给「活的数据」用。整体气质:值夜班的工程师信得过的界面。

## Colors

- **bg (#0B0E14) / surface (#151A23)**:两级深底,卡片浮起靠这一档明度差,不靠投影。
- **primary (#E6EAF2)**:正文亮灰白。别用纯白 #FFF,刺眼。
- **secondary (#8A93A6)**:标签、说明文字。
- **accent (#2DD4BF)**:数据青。只用于数值、活动状态、图表主线——按钮和标题不抢它。
- **warning (#F2B26B,在顶层 `status:` 段)**:告警琥珀,与青色天然区分(bg 上 10.5:1)。错误可再深一档到红,但一张图里红是稀客。
- **line (#232B38)**:分隔线与描边。深色界面的秩序靠线,不靠色块。

## Typography

- 界面文字 IBM Plex Sans + 系统黑体(苹方 / 微软雅黑,思源黑体兜底);**所有数值一律等宽字体**(IBM Plex Mono / JetBrains Mono)——数字会对齐、会跳动,等宽是专业感的一半;中文没有等宽族,夹在数值里的汉字兜到系统黑体。
- 字重克制:600 封顶,不用 800/900 的重磅字。

## Layout

- 信息密度可以高,但要分区清晰:卡片之间留 16px 以上,卡片内边距统一。
- 图表线条细(1.5-2px),数据点小;网格线用 line 色且比数据线浅得多。

## Elevation & Depth

层级靠**明度台阶**,不靠投影——深色底上的投影根本看不见,只会把界面弄脏。

1. **Level 0** = bg `#0B0E14`,页面底。
2. **Level 1**(卡片/面板)= surface `#151A23`。**这一档明度差就是全部的「浮起」**,不叠任何阴影。
3. **Level 2**(弹层/下拉/浮层)= 仍是 surface + **1px line `#232B38` 描边**。靠描边而不是再提亮
   一档,是为了不引入第三种底色。
4. **hover** = 在当前层上再提亮约 6% 明度(surface `#151A23` → `#232B38`,与 line 同值),
   **不是**加投影、不是加边框。
5. ⚠ 不要用「在 surface 上叠一层品牌色 tint」的老做法:Material 3 已弃用 `surfaceTint`
   (规范逐字:"Surface tint color is deprecated. Use elevation level tokens (0–5) instead."),
   正统做法就是像这里一样,用两个**独立的 surface 色角色**。

Don't:霓虹外发光(glow)当浮起;≥3 层底色堆叠(第三层深色一定分不出来)。

## Shapes

形状语言 = 精密仪器的面板:直边、小圆角、细线。

- **圆角两档分工**:`sm 6px` 给按钮/输入框/标签,`md 10px` 给卡片/面板/弹层。**同屏不出现第三种**。
- **同心嵌套**:外圆角 − 内边距 = 内圆角(M3 叫 optical roundness,Apple HIG 叫 concentricity,
  两家独立收敛到同一条)。10px 圆角的卡片里放按钮,内边距 4px 时按钮才配 6px;
  内边距开到 16px 时,内层元素**不要再画圆角容器**,直接裸放内容。
- **转角族用 `rounded` 不用 `cut`**(M3 逐字:"The shape style family can be customized from
  rounded to cut. This makes the corner a straight line instead of curved.")——切角是赛博朋克
  语汇,与这里的克制不合。
- **紧邻成组**的元素(分段控件、工具条按钮)用**非对称转角**:整组外侧两端 6px、内侧相接处 0,
  让一排按钮读作一件东西而不是四个。
- **线条**:1px line 色实线、端点 butt 用于分隔;图表数据线 1.5-2px、端点 round;
  虚线只表达一种语义——「预测值/未确认数据」,别当装饰用。
- **图标**:细线几何图标,1.5px 描边、端点 butt、转角直角,24px 网格。比 1px 分隔线粗半档
  是为了在深底上立得住——深色底会把过细的亮线吃掉;再粗就成了仪表盘之外的另一种音量。
  **不用实心图标**(实心块是 surface 的活儿,不是图标的)。

## Components

- **卡片/面板**:surface 底 + 10px 圆角 + 16px 内边距,卡片之间 16px。
  **卡片里不再套卡片**(第二层 surface 在深色下分不出来)。
- **按钮**:32px 高、6px 圆角、surface 底 + primary 字,hover 提亮到 `#232B38`。
  **主按钮不用 accent**——青色是数据的,不是操作的。
- **输入框**:32px 高、bg 底(比卡片更暗 = 「凹进去」)+ 1px line 描边;聚焦时描边换 accent,
  不加外发光。
- **标签/状态点**:20px 高,surface 底 + accent 字,文字走 `typography.data` 等宽。
- **数值**:一律等宽字体;**活跃/实时**的数值上 accent,静态历史值用 primary——
  一屏里带 accent 的数字超过三个,accent 就失效了。
- 控件高度取 4px 的整数倍(20 / 32 / 40),密度可以高,但必须齐。

## Do's and Don'ts

- Don't:紫蓝渐变(#6366F1 一族)、任何大面积渐变背景——这是深色科技风最泛滥的套路。
- Don't:霓虹发光(glow/bloom)效果、赛博朋克粉紫配色。
- Don't:emoji 当图标;图标用细线几何图标。
- Don't:纯黑底 #000。
- Do:数据造真:量级合理、有单位、有时间戳;假数据一眼假。
- Do:让 accent 保持稀缺——满屏青色等于没有青色。

## Composition

- 仪表盘类:最重要的一个数字最大,放左上;趋势图占宽不占高。
- 概念图/架构图:深底上用 surface 色块做节点、line 色连线、accent 只标关键路径。

## Image Prompt Templates

- base: "professional dark-mode dashboard interface, graphite blue-black background (#0B0E14), elevated panels (#151A23), light gray text, teal accent (#2DD4BF) for live data only, monospaced numerals, thin geometric line icons, subtle 1px borders, realistic plausible metrics with units, calm and precise, no neon glow"
- negative: "purple-blue gradient, neon glow, cyberpunk, emoji icons, pure black background, glossy 3D, lens flare"
- 注:图表数据要像真实业务(合理量级 + 单位),这条写进每次的画面描述里。
