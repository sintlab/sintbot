---
name: 档案索引
description: 策展目录那种密排列表——纯白纸、纯黑衬线、未经修饰的超链接蓝,容器是表格行不是卡片
name_en: "Archive Index"
description_en: "The dense list of a curated catalogue: plain white paper, black serif text and untouched hyperlink blue. Containers are table rows, not cards."
suits: "内容阅读"
colors:
  bg: "#FFFFFF"
  ink: "#000000"
  accent: "#0000FE"
  mark: "#FF4F23"
  muted: "#7D7D7D"
  line: "#000000"
  rule: "#E8E8E8"
fonts:
  latin: "'EB Garamond'"
  cjk: sans
typography:
  headline:
    cjk: serif
    fontSize: "44px"
    fontWeight: 400
    lineHeight: 1.15
  body:
    generic: "serif"
    fontSize: "19px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.005em"
    measure: "68ch"
  label:
    generic: "serif"
    fontSize: "14px"
    fontWeight: 400
    fontStyle: italic
    letterSpacing: "0.02em"
border:
  width: "1px"
  style: solid
  emphasis: "1px"
rounded:
  none: 0px
spacing:
  unit: "8px"
  maxWidth: "960px"
elevation:
  mode: flat
  levels: "1"
imagery:
  ratio: "4:3"
  treatment: grayscale
  crop: hard
icon:
  style: line
  strokeWidth: "1px"
  linecap: butt
  corner: sharp
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.bg}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    height: "36px"
    padding: "16px"
  card:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "0px"
  input-field:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    height: "34px"
    padding: "8px"
  tag:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.mark}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    height: "22px"
    padding: "4px"
---

## Overview

参照物(均实测过 CSS):DEPO LUXE `depoluxe.xyz`(EB Garamond 含 italic 通道,`#000` / `#FFF` / `#0000FE` / `#FF4F23`)、Are.na `are.na`、It's Nice That `itsnicethat.com`。
它模仿的是**纸与早期网页**:纯白、纯黑、未经修饰的超链接蓝,信息以编号列表与表格铺开。主体是**列表、表格、编号、脚注**,大图几乎不用;气质是策展与文献,不是生活方式。

**与「杂志编辑」的分界**:杂志编辑是图文叙事(暖纸、砖红、大图开场、不对称留白);这一套几乎不用大图,靠密排条目取胜。
**与「瑞士网格」的分界**:衬线不是无衬线、纯白不是暖白、有链接色、密度更高,而且**允许斜体**(瑞士明令禁斜体,这里斜体是元信息的专用体)。

## Colors

- **bg (#FFFFFF)**:**必须纯白**。暖白纸感是杂志的做法,这里要的是纸与屏幕的直白。
- **ink (#000000)**:**纯黑,不是 `#111`**(21:1)。这一点点极端就是它的态度。
- **accent (#0000FE)**:未经修饰的超链接蓝(白底 8.64:1)。**加下划线,不改颜色**。
- **mark (#FF4F23)**:标记橙,给两位数编号、当期标记、少量强调词。⚠ 白底只有 3.28:1 ⇒ **只够大字(≥24px)**,绝不做正文、小字或链接。
- **muted (#7D7D7D)**:辅助灰 4.12:1,**不达正文 4.5**。只给页脚、版权这类不承载信息的行;要读的元信息用 ink,或把灰压到 `#6B6B6B`(5.33:1)。别把 4.12 当过关。
- **line (#000000)**:表格线、分区线 —— 与 ink 同色,这个风格里线和字本来就是一回事。
- **rule (#E8E8E8)**:仅用于超长列表内部的次级分隔,一屏出现不超过一次。

## Typography

- **拉丁三档全是 EB Garamond**,不掺无衬线 —— 单一字族是这个风格的纪律。
- **中文只有大标题用宋体**(思源宋体优先),正文与标签用黑体。⚠ 这不是妥协:宋体横细竖粗,
  19px 以下在屏幕上横画会发虚断裂;44px 的标题才有足够像素撑住它的骨架与衬线。拿不到思源宋
  的机器直接退黑体,**不退中易宋体**。
- 标题 44px **字重 400,不加粗** —— 大字号本身就是层级,加粗会把文献感做成海报感。
- 正文 19px、行高 1.5、字距 `0.005em`(衬线小字在屏幕上需要这点松),**行长 68ch,65-75 是命门**:短了变碎片,长了读不动。
- 元信息用 **italic 小字**(14px),不用全大写也不用等宽 —— 斜体是这套里唯一的第二声部。中文无真斜体,改用小一号 + 收敛的灰,**不做伪斜**。

## Layout

- 主体是**条目列表**:每行 = 编号 + 标题 + 元信息,行高压到 1.35,密;表格撑满栏宽,列之间不留框线,只有横向 1px 黑线分行。
- 内容最大宽 960px;索引栏与正文栏可以并置(索引窄、正文宽),但**不做卡片网格**。页边距 32px,页脚一条 1px 黑线 + 斜体小字收尾。

## Elevation & Depth

完全没有层(`flat`)。层级只有三个来源,记作**线、字号、编号**:

1. **1px 纯黑线**:分区、分行、页眉页脚。一条线解决一次分区,不用底色也不用留白块 —— 结构的九成在这里。
2. **字号与斜体**:标题 44 / 正文 19 / 元信息 14 斜体,三档到底,不设第四档。
3. **编号**:两位数编号(01/02/03)本身就是纵深 —— 它把平铺的列表变成有序档案。

Don't:投影、圆角、hover 放大、卡片浮起。任何「抬起来」的暗示都与纸的物理性质冲突;要强调某一行就加一条线或把编号换成 mark 色,别让它浮起来。

## Shapes

- **圆角恒 0**,包括图片、按钮、输入框、头像;图片硬裁 4:3、灰阶、贴齐栏宽,不加边框不加圆角。
- 线条 1px 纯黑、平头、**绝不交叉重叠** —— 表格只有横线,竖线能不用就不用;真要用,横竖端点必须精确相接,不出头不缺口。
- 图标 1px 细线、方头、直角,尺寸与正文 x 高对齐;箭头用 `→` 字符而不是图形。

## Components

- **主按钮**:纯黑实心 + 白字 + 直角,整站最多出现在一处(订阅/提交)。
- **次按钮**:白底 + 1px 黑边 + 黑字;hover **只加下划线**,不换底色。
- **卡片**:内边距 0、无底色、无边框 —— **这个风格的容器是表格行,不是卡片**。一组条目 = 若干行 + 行间 1px 黑线,如此而已。
- **输入框**:底部 1px 黑单边线(不是四边框),背景透明,聚焦时线加粗到 2px。
- **标签**:mark 色斜体小字,直接坐在白底上,不加边框不加底色。

## Do's and Don'ts

- Do:每个条目带两位数编号(01/02/03)用 `mark` 色,字号够大才用得起这个色。
- Do:元信息(日期、类别、作者、来源)一律斜体小字,紧跟标题同行或下一行。
- Do:表格线永远 1px 纯黑且不交叉重叠;留出真正的页边距与页脚 —— 它是一份文档,不是一屏内容。
- Don't:**卡片化**。把条目装进带边框圆角的卡片里,这个风格就没了。
- Don't:改链接颜色去「配色」。`#0000FE` 加下划线就是它的性格,**「不设计」本身是一次设计判断**。
- Don't:投影、圆角、hover 放大、渐变;标题加粗;用全大写做元信息;大图开场与满幅英雄区(那是杂志编辑那一套)。

## Composition

- 首屏 = 一行标题 + 一条黑线 + 直接开始的编号列表,**不做封面**;图片穿插在列表中间,单张、灰阶、不超过栏宽的 2/3,图注用斜体小字紧贴下方。
- 一页只有一条视觉主轴:自上而下的编号序列,横向不做并列卡片。脚注与来源用更小的斜体排在末尾,与正文之间隔一条 1px 黑线。

## Image Prompt Templates

- base: "archival index page layout, pure white background, pure black EB Garamond serif typography, numbered list entries with two-digit numerals in orange (#FF4F23), unstyled underlined hyperlink blue (#0000FE), italic serif metadata in small size, 1px solid black hairline rules separating rows, dense table-like listing, one small grayscale 4:3 photograph, no cards, no shadows, no rounded corners, flat printed-document feel"
- negative: "card grid, drop shadow, rounded corners, sans-serif typography, warm paper tone, hero image, gradient, colorful buttons, bold headline, emoji"
- 注:画面里必须出现**编号列表或表格**(那是它的主体),而不是段落配图;中文版面补 "clean CJK serif typography (Noto Serif SC), regular weight"。
