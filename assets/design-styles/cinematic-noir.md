---
name: 暗场影像
description: 碳黑底上的满幅影像与巨字——胶片颗粒、四角暗角、骨白文字,像放映厅而不是控制台
name_en: "Cinematic Noir"
description_en: "Full-bleed imagery and huge type on carbon black, with film grain, corner vignettes and bone-white text. A screening room, not a dashboard."
suits: "品牌门面 · 生图插画"
colors:
  bg: "#08090A"
  surface: "#131417"
  ink: "#EDE9E1"
  sand: "#E6D5BB"
  muted: "#8B8A86"
  accent: "#FF4D00"
  line: "#23252A"
fonts:
  latin: "'Familjen Grotesk'"
  cjk: sans
typography:
  headline:
    latin: "'PP Neue Montreal', 'Familjen Grotesk'"
    fontSize: "88px"
    fontWeight: 500
    lineHeight: 0.95
    letterSpacing: "-0.03em"
  body:
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.55
    measure: "60ch"
  label:
    latin: "'Martian Mono', 'Geist Mono'"
    generic: "ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    letterSpacing: "0.12em"
    textTransform: uppercase
border:
  width: "0px"
  style: solid
  emphasis: "1px"
rounded:
  none: 0px
spacing:
  unit: "8px"
  gutter: "24px"
  maxWidth: "1440px"
elevation:
  mode: flat
  levels: "1"
imagery:
  ratio: "16:9"
  treatment: grayscale
  crop: full-bleed
icon:
  style: line
  strokeWidth: "1px"
  linecap: butt
  corner: sharp
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.bg}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    height: "48px"
    padding: "24px"
  button-secondary:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.sand}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    height: "48px"
    padding: "24px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "32px"
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    height: "48px"
    padding: "16px"
  tag:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    height: "26px"
    padding: "10px"
---

## Overview

参照物(均实测过 CSS):TRIONN `trionn.com`(Awwwards SOTD,底色 `#040508`、文字 `#D8D8D8`,Familjen Grotesk 配 Martian Mono)、Obys 的 Experiment Space `experiment.obys.agency`、RISK `risk.film`(骨色 `#E6D5BB` 就是它的主文字色)、Monolog `bymonolog.com`。

这是**放映厅的暗**,不是软件的深色模式:满幅影像铺满屏,巨大的标题压在图上,小字是等宽全大写的场记标签,画面有颗粒、四角有暗角。气质是「胶片」—— 克制、有重量、不发光;所有戏都在图与字号的落差里。

**它和「科技深色」是两件事,别混** —— 一个给人操作,一个给人看:
- **科技深色 = 产品控制台**:石墨蓝底 `#0B0E14`、数据青标活数据、6/10px 圆角、有完整组件体系、画面是图表与密排卡片。
- **暗场影像 = 品牌影像面**:纯碳黑 `#08090A`、骨白与灼橙、圆角恒 0、几乎没有组件(只有图、字、线)、画面是满幅图 + 巨字 + 颗粒。

## Colors

- **bg (#08090A)**:碳黑。不用纯黑 `#000` —— 差这一点点,颗粒与暗角才有地方落。
- **surface (#131417)**:比底色只亮一档。它是唯一的「面」,靠明度差从底上浮起来。
- **ink (#EDE9E1)**:**暖白,不是纯白**。纯白 `#FFF` 在碳黑上 19.9:1,刺眼且发蓝;暖白 16.5:1,够用而且有胶片的奶感。**这条最容易被改错。**
- **sand (#E6D5BB)**:骨色(13.9:1),用于标题、引言、需要一点温度的大字。它与 ink 二选一定调:整站要么暖白主骨色点,要么反过来,**别两种主文字色并行**。
- **muted (#8B8A86)**:场记标签、图注、时间码(5.8:1)。
- **accent (#FF4D00)**:灼橙。**一屏一处**,通常只是一个词、一条线或一个小方块;黑字压橙 6.0:1,是它唯一能安全承载文字的用法。
- **line (#23252A)**:分区细线。深色画面的秩序靠线,不靠色块。

## Typography

- 标题 PP Neue Montreal / Familjen Grotesk,**字重 500 就够**,字距 `-0.03em`。大字靠大取胜不靠粗,800 字重在这里会显得吵。
- 正文 Familjen Grotesk 400,行长 60ch 以内;中文系统黑体(苹方 / 微软雅黑),字重同样压在 400-500。
- 小标签走等宽(Martian Mono / Geist Mono)+ 全大写 + `0.12em`,像镜头边上的元数据 —— 占比很小但不能没有;夹在标签里的汉字兜到系统黑体,与正文同一套。
- **字号跨度必须 ≥10 倍**:12px 标签 ↔ 140px 标题同屏出现,中间几乎不放东西。跨度不够,整套就塌回普通深色网页。

## Layout

- 满幅优先:图片贴四边出血,内容压在图上;左右边距 40px 只对文字块生效。
- 12 列网格**只用来对齐文字**,图片不受网格约束。
- 大量垂直留白:标题上下各留屏高的 15-20%,让巨字有呼吸。一屏一个信息单元 —— 这是滚动叙事的版式,不是信息聚合页。

## Elevation & Depth

底色是平的(`flat`,零投影),纵深靠**画面本身**造,三个来源:

1. **胶片颗粒**:整幅覆一层 `<feTurbulence baseFrequency="0.9">` 噪声,`opacity: .06; mix-blend-mode: overlay`。它让纯色区不再死板,是「胶片感」的九成。
2. **四角暗角**:`radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,.45))` 压在图片与整屏上 —— 视线被收进画面中央,这是镜头的物理属性。
3. **明度分层**:bg `#08090A` 与 surface `#131417` 只差一档。面浮起来靠这一档,不靠边框也不靠阴影。

Don't:**任何 `box-shadow`**。碳黑上的柔阴影只会糊成一团脏,毫无立体感 —— 浅底那套抬升手法在这里全部失效。

## Shapes

形状语言 = **矩形与线**,没有第三种。

- **圆角恒 0**,包括图片、按钮、输入框、标签、头像。出现圆角这个风格就变成通用深色 App。
- 线 1px `line` 色、平头相交、不用虚线;线的作用是分区,不是装饰。
- 图标细线 1px、方头、直角,尺寸小(16-20px),永远不填色。
- 允许的图形:矩形、细线、`+` 十字标记(角标/裁切标记)、时间码方块。**不用圆形**,除非画的是真实的镜头或唱片。

## Components

这个风格几乎没有组件体系 —— 下面四个是「不得不有」时的写法,能不用就不用。

- **主按钮**:灼橙实色 + 黑字 + 直角,一屏最多一个。
- **次按钮**:透明底 + 骨色字 + 1px `line` 边;hover **只换文字色**,不加背景。
- **卡片**:surface 底、直角、32px 内边距、无边框无投影;卡片里不放第二张卡片。
- **输入框**:surface 底 + 底部 1px `line` 单边线(不是四边框),聚焦态底线换 accent,**不加发光**。
- **标签**:等宽小字 + surface 底,成排横列,像胶片边上的编号条。

## Do's and Don'ts

- Do:图先行 —— 先定一张能撑满屏的图再排字。这个风格没有好图就不成立。
- Do:颗粒与暗角**全站统一一套参数**,只调一次,别一页一个强度。
- Do:accent 保持稀缺;想加第二处橙色时,先删掉一处。
- Don't:发光、霓虹、辉光描边 —— 那是赛博朋克,不是影像。
- Don't:纯白 `#FFF` 正文(见 Colors)。
- Don't:任何 `box-shadow`、任何圆角、任何渐变按钮。
- Don't:彩色照片直接上版;先转灰阶或压成低饱和暖调,否则配色纪律立刻散架。
- Don't:把它当控制台用 —— 要密排数据与组件时改用「科技深色」。

## Composition

- 满幅图 + 压图巨标题 + 一行等宽小字,三层结束,一屏就这么多。
- 标题可以压在图片较暗的区域,但**必须先压一层暗角或 40% 黑蒙版**再放字。
- 图片处理成灰阶或单一暖调,硬裁、贴边出血,不加边框不加圆角。
- 序列感来自节奏:满幅图 → 大留白文字页 → 满幅图,交替推进。

## Image Prompt Templates

- base: "cinematic dark editorial layout, full-bleed desaturated film still, deep carbon black background (#08090A), warm bone-white oversized headline typography (#EDE9E1), tiny uppercase monospaced caption with wide letter spacing, one burnt orange accent detail (#FF4D00), heavy film grain overlay, strong vignette at corners, sharp 90-degree corners, no glow, flat and matte, 35mm photographic mood"
- negative: "neon glow, cyberpunk purple pink, rounded corners, drop shadow, pure white text, glossy 3D render, lens flare, dashboard widgets, colorful saturated photo, gradient background"
- 注:先写**镜头与光**(侧逆光/夜景街灯/雾)再写内容;文字宁少勿多,一两个大词就够。中文版面补 "clean CJK sans-serif typography, light weight"。
