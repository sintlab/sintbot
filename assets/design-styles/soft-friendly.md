---
name: 圆融亲和
description: 消费品与教育产品的温软圆润——奶白底、珊瑚与薄荷、大圆角,亲切但不幼稚
name_en: "Soft & Friendly"
description_en: "The soft roundness of consumer and education products: milk-white ground, coral and mint, and generous corners. Warm without being childish."
suits: "工具产品 · 品牌门面"
colors:
  cream: "#FFFDF8"
  ink: "#3A4254"
  coral: "#F97A6C"
  mint: "#7FD8BE"
  butter: "#FFD98E"
  line: "#E8E2D6"
fonts:
  latin: "'Nunito'"
  cjk: rounded
typography:
  headline:
    latin: "'Nunito', 'Quicksand'"
    fontSize: "24px"
    fontWeight: 700
  body:
    fontSize: "16px"
    lineHeight: 1.75
    measure: "50ch"
    fontWeight: 400
  label:
    fontWeight: 600
border:
  width: "1px"
  style: solid
  emphasis: "2px"
rounded:
  md: 12px
  lg: 20px
  full: 999px
spacing:
  unit: 8px
imagery:
  ratio: "1:1"
  treatment: none
  crop: rounded
icon:
  style: line
  strokeWidth: "2px"
  linecap: round
  corner: round
components:
  card:
    backgroundColor: "{colors.cream}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "24px"
  button-primary:
    backgroundColor: "{colors.coral}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    height: "44px"
    padding: "24px"
  button-secondary:
    backgroundColor: "{colors.mint}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    height: "44px"
    padding: "24px"
  input-field:
    backgroundColor: "{colors.cream}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "16px"
  tag:
    backgroundColor: "{colors.butter}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    height: "28px"
    padding: "12px"
  avatar:
    rounded: "{rounded.full}"
    size: "40px"
---

## Overview

参照物:做得体面的儿童教育 App、健康食品包装、日系文具品牌。
圆是这个风格的核心词:圆角、圆形色块、圆头线条、圆润字体。
但「亲和」靠的是低饱和的暖色与充足留白——饱和度一拉高就成了廉价玩具。

## Colors

- **cream (#FFFDF8)**:奶白底,暖而不黄。
- **ink (#3A4254)**:蓝灰墨色文字——比纯黑柔和,是「不幼稚」的关键一票。
- **coral (#F97A6C)**:珊瑚主色,按钮与重点。
- **mint (#7FD8BE) / butter (#FFD98E)**:薄荷与奶油黄,辅助色块与插画配色。
- **line (#E8E2D6)**:温暖的描边与分隔线。
- 配色纪律:一图一主色(coral),辅助色出现在插画与小标签里;三彩色齐上阵的场合要拉开面积比例。

## Typography

- 圆体系:拉丁 Nunito/Quicksand,中文走系统圆体(圆体-简),取不到再落苹方 / 微软雅黑 —— 圆黑更佳;标题 700 但字号别过大——这个风格音量是中等的。
- 全部字色用 ink 蓝灰,彩色文字只出现在标签胶囊里。

## Layout

- 圆角统一档位:卡片 20px、按钮胶囊、小元素 12px——**同屏别混第三种圆角**。
- 元素之间留白充足(16px 起步),挤密与亲和不共存。
- 插画风格:圆头粗线 + 平涂 + 少量脸部表情(两点一线的极简脸,不是大眼萌系)。

## Elevation & Depth

允许**一层**柔投影,且**只有一层**——这是「亲和」与「廉价果冻感」的分界线。

- **卡片是唯一投影的地方**:key 阴影 `0 1px 2px rgba(58,66,84,0.30)` +
  ambient 阴影 `0 2px 6px 2px rgba(58,66,84,0.15)`。
- **柔投影本质是两层**:近而实的 key + 远而散的 ambient,只画一层会显得硬。
  (依据:Material 3 每一档 elevation 都是 key 0.3 + ambient 0.15 两层;
  Adobe Spectrum 2 逐字说是 key + ambient + transition 三层。)
- **阴影色取 ink 蓝灰 `#3A4254`,不是纯黑**——纯黑投影落在奶白底 `#FFFDF8` 上会发灰发脏。
- **按钮不投影**。按钮的分量来自 coral 实色本身,不来自浮起。
- **按下 = 背景色加深一档**(coral → 约 `#E86657`),不是加深阴影、不是位移。

Don't:卡片里套卡片;多层投影堆出立体按钮。

## Shapes

形状语言 = **圆**:圆角、圆形色块、圆头线条、圆润字体,四件事说的是同一个词。

- **三档分工**:`md 12px` 给输入框/标签/小元素,`lg 20px` 给卡片与图片,
  `full 999px` **只给按钮胶囊、头像、圆点**——**矩形卡片永远不许用 full**。
- **同心嵌套**:外圆角 − 内边距 = 内圆角(M3 optical roundness / Apple HIG concentricity)。
  20px 圆角的卡片 + 8px 内边距 ⇒ 内层元素正好 12px(`md` 档);内边距要开到 16px 时,
  内层就别再套带底色的容器,直接裸放内容,免得出现第四种圆角。
- **线条**:1.5-2px,端点 **round**(`stroke-linecap: round`),贯彻到图标、箭头、下划线、
  图表线——出现一个平头端点就破功。
- **允许的形状**:圆角矩形、正圆、胶囊、圆头弧线与波浪。**不出现锐角三角形**;
  需要箭头时用圆头折线代替三角箭头。
- **图标**:线性圆头,2px 描边、端点与转角**都是 round**,24px 网格上画;实心图标和锐角三角
  一个下场——一出现就硬了。

## Components

- **按钮**:44px 高胶囊 + 左右 24px 内边距,coral 实色 + **ink 字**。
  白字在 coral 上只有 2.6:1,ink 是 3.8:1(16px / 600 字重按大文本判定达标)——所以按钮字用 ink。
- **按钮交互**:hover 背景提亮约 8%,按下背景加深一档(约 `#E86657`);两态都不动阴影、不动位置。
- **输入框**:44px 高、**12px 圆角(不用胶囊)**——胶囊输入框会让光标起始位置变得暧昧;
  cream 底 + 1px line 描边,聚焦时描边换 coral 并加粗到 2px。
- **卡片**:20px 圆角 + 24px 内边距 + 唯一那层柔投影,卡片之间至少 16px。
- **标签**:28px 胶囊,butter 或 mint 底 + ink 字,一屏 ≤3 个。
- **头像**:正圆 40px,不加描边不加投影。

## Do's and Don'ts

- Don't:高饱和彩虹全家桶(纯红纯蓝纯黄挤一屏)。
- Don't:大眼睛萌系吉祥物、emoji 表情当插画。
- Don't:投影堆叠的「果冻感」立体按钮;浮起感最多一层淡投影。
- Don't:纯黑文字、锐利直角元素乱入。
- Do:圆头线条(stroke linecap round)贯彻到图标、箭头、下划线。
- Do:用留白与淡色线维持秩序,亲和的底子是整洁。

## Composition

- 界面/卡片:奶白底 + 圆角卡 + 一个珊瑚色主按钮,插画点缀在角落不抢主体。
- 插画场景:主角居中、配角环绕,地面用一条 mint 或 butter 的圆角色带交代。

## Image Prompt Templates

- base: "friendly rounded illustration style, warm cream background (#FFFDF8), soft coral (#F97A6C) and mint (#7FD8BE) palette with muted saturation, thick round-capped outlines in blue-gray (#3A4254), generous rounded corners, simple dot-eyes minimal faces, clean and airy layout, tasteful children's-education-app aesthetic, flat with at most one soft shadow"
- negative: "oversaturated rainbow colors, big anime eyes mascot, emoji, jelly 3D buttons, harsh black outlines, cluttered layout, sharp corners"
- 注:饱和度是这个风格的生死线——描述里保留 "muted saturation";出图太艳就再加 "pastel, low saturation"。
