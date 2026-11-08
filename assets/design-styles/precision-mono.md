---
name: 精密仪表
description: 开发者工具那种密而准的界面——发丝线分区、等宽数字对齐、4px 小圆角,没有一处多余装饰
name_en: "Precision Mono"
description_en: "The dense, exact interface of developer tools: hairline dividers, aligned monospaced numbers and 4px corners, with not one ornament to spare."
suits: "工具产品"
colors:
  bg: "#FAFAFA"
  surface: "#FFFFFF"
  ink: "#0A0A0A"
  muted: "#737373"
  line: "#E6E6E6"
  accent: "#2B5AE1"
fonts:
  latin: "'Geist', 'Schibsted Grotesk'"
  cjk: sans
typography:
  headline:
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  body:
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
    measure: "76ch"
  data:
    latin: "'Geist Mono', 'Martian Mono'"
    generic: "ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 500
    letterSpacing: "0.06em"
border:
  width: "1px"
  style: solid
  emphasis: "1px"
rounded:
  sm: 4px
  md: 6px
spacing:
  unit: "4px"
  maxWidth: "1200px"
elevation:
  mode: flat
  levels: "1"
status:
  success: "#0B7A46"
imagery:
  ratio: "16:9"
  treatment: none
  crop: hard
icon:
  style: line
  strokeWidth: "1.5px"
  linecap: butt
  corner: sharp
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    height: "32px"
    padding: "12px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "16px"
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    height: "32px"
    padding: "8px"
  tag:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.muted}"
    typography: "{typography.data}"
    rounded: "{rounded.sm}"
    height: "20px"
    padding: "6px"
---

## Overview

参照物(均实测过 CSS):Linear `linear.app`、Vercel `vercel.com`(Geist Sans + Geist Mono,`#FAFAFA` / `#EAEAEA` / `#0070F3`)、2xA Studio `2xa.studio`、Resend `resend.com`。
气质是**仪表**:每个数对得齐,每条线只有 1px,信息密而不乱。它不追求好看,追求「一眼看清十二个数」——装饰预算全花在对齐和字距上。

**与「瑞士网格」的分界**:瑞士是**招贴逻辑**(Helvetica、唯一的红、圆角 0、留白 40%、根本没有组件);这一套是**屏幕产品逻辑**(等宽是主音而非数据配角、发丝线到处都是、4px 圆角、表格密排、tabular 数字、状态点)。瑞士留白,它留密度。

## Colors

- **bg (#FAFAFA) / surface (#FFFFFF)**:近白与纯白两级,卡片浮起靠这一档差 + 一条 1px 线,不靠投影。
- **ink (#0A0A0A)**:文字与主按钮底(bg 上 19.0:1),这套里唯一的重色。
- **muted (#737373)**:标签、单位、次级信息(bg 上 4.54:1,刚过线)。⚠ 别再往浅调,4.5 是底不是目标。
- **line (#E6E6E6)**:发丝线 —— 这个风格的骨架。**分区一律用它,不用底色块**。
- **accent (#2B5AE1)**:蓝,给链接、激活态、聚焦环、图表主线(白底 5.75:1,可作文字)。⚠ **不做按钮填充面**。
- **success (#0B7A46,在顶层 `status:` 段)**:同一支绿(色相 151°)取到可读深度(bg 上 5.2:1),状态词与 6px 圆点都用它。⚠ **不做底色块** —— 这套的分区只有 1px 线;且圆点旁永远配一个状态词,颜色不单独承担语义。

## Typography

- 界面文字 Geist / Schibsted Grotesk + 系统黑体(苹方 / 微软雅黑,思源黑体兜底);**所有数值一律等宽**(Geist Mono)且必须 `font-variant-numeric: tabular-nums` —— 数字会跳,定宽数位是专业感的一半。
- 标题 24 / 正文 14,反差只有 1.7 倍。**密度就是这个风格的性格**,别把标题拉大。
- 等宽小字 `0.06em`、字重 500,用于 ID、时间戳、版本号、指标值;字重全站封顶 600。中文没有真正的等宽族,夹在数据里的汉字兜到系统黑体(与界面文字同一套)。

## Layout

- **spacing 单位 4px**,阶梯 4/8/12/16/24 —— 间距值只能从这五个里选;表格行高 32-36px,单元格内边距 8/12,列宽按内容定,**数值列一律右对齐**。
- 分区靠 1px `line` 横贯到底(整条不留边距),不靠留白也不靠色块;内容最大宽 1200px,正文行长 76ch(字号小,容得下长行)。

## Elevation & Depth

默认**没有层**(`flat`)。纵深靠三样替代手段,按优先级用:

1. **1px 描边**:卡片、输入框、表格容器一律 `1px solid #E6E6E6`。第一手段,占九成。
2. **明度分级**:页面 `#FAFAFA`、卡片 `#FFFFFF`。只有这两级,不设第三级。
3. **浮层例外**:只有真正脱离文档流的东西(下拉菜单、命令面板、toast)允许 `0 1px 2px rgba(0,0,0,.04), 0 8px 16px rgba(0,0,0,.06)` —— 两段式、极淡、无扩散。

Don't:给卡片加阴影。柔和大阴影卡片是 AI 模板的第一特征,一出现整套掉价;卡片的边界永远是那条 1px 线。

## Shapes

- **圆角上限 8px**,实际只用两档:控件 4px、卡片 6px。超过 8 就变成通用 SaaS 模板;圆角**全站统一**,同类元素不许一处 4 一处 6,写成变量别手写。
- 线条 1px、平头、直角相交;虚线只表示「待定/占位」这一种语义。
- 图标 1.5px 细线、方头、直角,16px 网格上绘制,与文字基线对齐。状态点 6px 正圆,是这套里唯一的圆形。

## Components

- **主按钮**:`ink` 实心 + 白字 + 4px 圆角 + 32px 高,一屏一个。
- **次按钮**:白底 + 1px `line` 边 + ink 字;hover 边框换 `#0A0A0A`,**不换底色**。
- **卡片**:白底 + 1px 边 + 6px 圆角 + 16px 内边距,**无阴影**。
- **输入框**:与次按钮同规格;聚焦态 = 边框换 accent + 3px 外圈 `rgba(43,90,225,.14)`。
- **标签**:bg 底 + 等宽小字 + 20px 高,密集成排,不用彩色底。

## Do's and Don'ts

- Do:数字全部 `tabular-nums`,**同一列必须对齐** —— 对不齐的数字表等于没做;每个数值带单位与时间口径,没有量纲的数字在这个风格里是缺陷。
- Do:分区只用 1px `#E6E6E6`,不用底色块;圆角全站统一 4px(卡片 6px)。
- Don't:柔和大阴影卡片(**AI 模板的第一特征**)。
- Don't:把蓝色做成填充按钮的主色面积 —— 按钮用 `#0A0A0A` 实心,蓝留给链接、聚焦环与激活态。
- Don't:圆角 > 8px、胶囊按钮、渐变、玻璃、emoji 图标。
- Don't:用 `success` 色做背景块 —— 分区只有 1px 线,不用色块(见 Colors)。

## Composition

- 仪表盘:顶部一行关键指标(等宽大数 + 小标签),下面是表格或图表,左侧窄导航。
- 一屏可以放很多东西,但**层级只有两级**(区块标题 + 内容),不做三级嵌套卡片。
- 图表线 1.5px,网格线用 `line` 色且明显浅于数据线;图片硬裁 16:9,不加圆角不加边。数据要造真:量级合理、有单位、有时间戳。

## Image Prompt Templates

- base: "precise developer-tool interface, near-white background (#FAFAFA), white cards separated by 1px hairline borders (#E6E6E6), no shadows, small 4px corner radius, dense data table with tabular monospaced numerals, black solid primary button (#0A0A0A), blue only for links and focus states (#2B5AE1), tiny monospace labels, thin 1.5px line icons, high information density, flat and exact"
- negative: "soft drop shadow cards, large rounded corners, pastel gradient, glassmorphism, blue filled hero buttons, decorative illustration, emoji icons, oversized whitespace"
- 注:画面里要出现**真实的表格与数值**(带单位、带时间戳),这个风格的可信度全在数据像不像真的;中文界面补 "clean CJK sans-serif UI typography, 14px body"。
