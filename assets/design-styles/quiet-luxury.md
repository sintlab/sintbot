---
name: 静奢
description: 巨大的衬线标题、微型全大写标签、一屏只说一件事——不装饰不发光,贵在敢空
name_en: "Quiet Luxury"
description_en: "Huge serif headlines, tiny all-caps labels and one idea per screen. No ornament and no glow: the luxury is in daring to leave space empty."
suits: "品牌门面"
colors:
  bg: "#FFF8EF"
  ink: "#0E0E0E"
  accent: "#003933"
  blush: "#EDCCBE"
  muted: "#8E8A82"
  line: "#E3DCD1"
  gold: "#E2C373"
fonts:
  latin: "'Söhne', 'Neue Haas Grotesk', 'Host Grotesk'"
  cjk: sans
typography:
  headline:
    latin: "'Noe Display', 'Bodoni Moda'"
    cjk: serif
    fontSize: "72px"
    fontWeight: 400
    lineHeight: 1.02
    letterSpacing: "-0.01em"
  body:
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.65
    measure: "52ch"
  label:
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: "0.16em"
border:
  width: "0px"
  style: solid
  emphasis: "0px"
rounded:
  none: 0px
spacing:
  unit: "16px"
  gutter: "32px"
  margin: "64px"
  maxWidth: "1280px"
elevation:
  mode: flat
  levels: "0"
imagery:
  ratio: "3:4"
  treatment: none
  crop: full-bleed
icon:
  style: line
  strokeWidth: "1px"
  linecap: butt
  corner: sharp
components:
  link-cta:
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0px"
  link-cta-hover:
    textColor: "{colors.accent}"
  card:
    backgroundColor: "{colors.blush}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "64px"
  input-field:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    height: "48px"
  tag:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
---

## Overview

参照物:House of Honey(houseofhoney.com,Noe Text + Neue Haas Grotesk)、Aimé Leon Dore(aimeleondore.com,Söhne + Financier Display + DIN)、Brunello Cucinelli、Cecilie Bahnsen。
这是**品牌门面**的风格:一屏只有一张大图、一个五个字的标题、一行微型全大写标签,几乎没有段落。
气质是「不解释」——不说服、不列卖点、不放按钮;贵不来自装饰,来自敢把六成版面留空。

**与「杂志编辑」的分界**(两者最容易混):编辑风是**内容叙事**,牛皮纸底、砖红点缀、衬线排正文、长文分栏、图注与页码一应俱全,读者是来读的;静奢是**品牌门面**,衬线只出现在巨标题上、正文全部无衬线且极短、没有分栏也没有图注体系,观众是来看的。
**判据一句话:这一屏有没有段落?有 ⇒ 用编辑风。**

## Colors

- **bg (#FFF8EF)**:奶白偏暖。暖来自扣掉的那点蓝,不是加黄——一偏黄就成了米色便签纸。
- **ink (#0E0E0E)**:近黑,与 bg 18.3:1。**所有文字都用它**,没有第二种文字色。
- **accent (#003933)**:深墨绿,**极小面积**——一条 1px 线、一个词、CTA 的 hover 色。与 bg 12.2:1 承载文字安全,但一屏最多 1-2 处。
- **blush (#EDCCBE)**:胭脂。用法与 accent 相反,**它是拿来铺大面积的**:整块 section 底、整张图的衬底;ink 压上去 12.8:1 可读。
- **muted (#8E8A82)**:暖灰,与 bg 只有 3.3:1,**够不上正文**——只给图注、年份、地点这类「看不清也不影响」的信息。11px 标签一律用 ink。
- **line (#E3DCD1)**:1px 发丝线。存在感应接近于零,一屏里数得出几条线就已经多了。
- **gold (#E2C373)**:与 bg 只有 1.6:1,**永远不能当文字色**;只做细节(一个 4px 的点、图片一角的压线),整站不用也完全成立。

## Typography

- **标题**:高对比现代衬线(Noe Display / Bodoni Moda,中文走系统宋体、思源宋体兜底),字重恒 400,字距 -0.01em。72px 起步,**敢上 120px**——音量全在字号,不在字重。
- **正文**:无衬线(Söhne / Neue Haas Grotesk / Host Grotesk),16px 400。**正文永远不用衬线**,这是与编辑风分家的那一刀。
- **label**:同正文字族、500、11px、字距 0.16em、全大写——**这是这个风格的签名**。分类、季度、产地、材质全走这一档;中文没有大写,用 0.1em 以上字距代偿。
- 一屏只允许一种衬线。两种衬线并置(哪怕一个做标题一个做引言)立刻变成排版练习。
- 标题与正文 4.5 倍反差(72/16),中间**不存在任何字号**。

## Layout

- **spacing.unit 16px**,阶梯 16 / 32 / 64 / 128——留白要夸张到「像是没排完」。
- 左右外边距 ≥ 版心的 8%;竖构图图片两侧的白比图本身更需要保护。
- 一屏 = 一个标题 + 一个 label + 一张大图,三件套结束。第四个元素想出现时,先删掉一个。
- 允许不对称(图偏右、字压左下),但**绝不居中堆成轴对称**。

## Elevation & Depth

`elevation.mode: flat`——**任何阴影都会立刻掉价**,包括 1px 的、包括 2% 透明度的。这个风格里没有「浮起来的卡片」这个概念,层次只靠三件事:

1. **图片出血**:图压满一整块,它与 bg 的边界就是最强的一道层次。
2. **blush 色块**:整段换 blush 底,与 bg 的明度差(0.95 : 0.65)自己就分了层。
3. **留白量差**:密处紧到 16px、松处空到 128px,疏密比就是视觉层级。

Don't:阴影、毛玻璃、半透明遮罩、hover 位移、任何「浮起 / 按下」的暗示。

## Shapes

- **圆角恒 0**。唯一例外是图片可以到 2px(印刷裁切的手感),再多就软了。
- **边框恒 0px**。这个风格里没有描边卡片——要分区就换底色,不要画框。
- **线**:1px、line 色、平头端点、只走水平垂直;不用虚线、不用斜线。
- **图标**:1px 线性、平头、直角转角、无填充;高度与 label 齐,**永远不放进圆形底里**。

## Components

- **CTA 不是按钮**:它是一行 label 规格的小字加 1px 下划线(`link-cta`)。hover 时字色换 accent、下划线跟着换,**位置不动**。整站没有实心按钮这种东西。
- **卡片**:blush 实底 + 64px 内边距 + 直角,无边框无阴影;卡片里不再套卡片。
- **输入框**:只有底部一条 1px line,没有四边框、底色、圆角;聚焦时那条线换 ink。
- **标签**:纯文字,无底色无边框——「标签」在这里是排版位置,不是一个色块。

## Do's and Don'ts

- Do:一屏只允许一个标题 + 一个 label + 一张大图。
- Do:墨绿一屏只出现 1-2 处,金色出现 0-1 处。
- Do:图片用 3:4 或 4:5 竖构图,左右留白 ≥8%。
- Do:文案短到极限——五个字的标题比十五个字的贵。
- Don't:**按钮化**(实心块、胶囊、大写粗字加箭头);CTA 就是一行带下划线的小字。
- Don't:圆角、阴影、hover 位移、渐变、任何发光。
- Don't:同一屏用两种衬线;正文用衬线。
- Don't:拿 gold 或 blush 当文字色(1.6:1,见 Colors)。
- Don't:堆 logo 墙、卖点图标、客户评价——那是转化页的语言,不是门面。

## Composition

- 竖幅优先:一张 3:4 的图占六成版面,标题压在图**外**的空白里,label 贴在标题上方 32px。
- 文字与图**不重叠**(这是与巴黎高定的分界):这里的高级来自两者互不打扰。
- 页脚只有一行 label:年份、城市、一个词。

## Image Prompt Templates

- base: "quiet luxury brand imagery, warm off-white background (#FFF8EF), soft natural daylight from one side, minimal composition with vast negative space, single subject, matte textures — raw linen, unglazed ceramic, brushed brass, muted blush drape (#EDCCBE), 3:4 vertical crop, editorial still life, restrained and expensive"
- negative: "glossy reflection, gold gradient, sparkle, bokeh, busy background, multiple products, drop shadow, rounded corners, saturated colors, stock photo styling, text overlay, logo"
- 注:出图只交代「材质 + 光」两件事——写清材质(亚麻 / 未上釉陶 / 黄铜 / 丝绒)与光的方向(单侧自然光),别写形容词(高级 / 奢华 / 优雅),那些词只会换来水晶和金色渐变。
