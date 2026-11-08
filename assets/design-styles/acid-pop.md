---
name: 酸性荧光
description: 灰白底上的荧光二次色与铬金属——挤压变宽字、2px 硬描边、贴纸式拼贴,吵得有纪律
name_en: "Acid Pop"
description_en: "Fluorescent secondaries and chrome on off-white: extended type, 2px hard outlines and sticker-style collage. Loud, but disciplined."
suits: "活动推广 · 品牌门面"
colors:
  bg: "#F5F4F2"
  ink: "#101010"
  accent: "#C6FF1B"
  pink: "#F98DFF"
  cyan: "#99F8FF"
  butter: "#FFF8A5"
  chrome: "#C9CDD3"
  muted: "#5C5A57"
  line: "#101010"
fonts:
  latin: "'Schibsted Grotesk'"
  cjk: sans
typography:
  headline:
    latin: "'PP Right Grotesk', 'Bricolage Grotesque'"
    fontSize: "60px"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "-0.04em"
  body:
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
    measure: "60ch"
  label:
    latin: "'Space Grotesk', 'DM Mono'"
    generic: "ui-monospace"
    fontSize: "12px"
    fontWeight: 500
    letterSpacing: "0.1em"
    textTransform: uppercase
border:
  width: "2px"
  style: solid
  emphasis: "2px"
rounded:
  none: 0px
  full: 999px
spacing:
  unit: "8px"
  gutter: "24px"
  margin: "32px"
  maxWidth: "1200px"
  columns: 12
elevation:
  mode: offset
  levels: "2"
imagery:
  ratio: "1:1"
  treatment: duotone
  crop: hard
icon:
  style: solid
  strokeWidth: "2px"
  linecap: butt
  corner: sharp
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    height: "44px"
    padding: "20px"
  button-secondary:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"
    height: "44px"
  tag:
    backgroundColor: "{colors.cyan}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    height: "28px"
  card:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "24px"
---

## Overview

参照物:Glitch&Grit(glitchandgrit.com)、Made With GSAP(madewithgsap.com)、UNITS(units.gr)、Viens-La(viens-la.com)——四个都是活站,底色与荧光色号从它们的 CSS 里实测出来。
血统在 90 年代末的锐舞传单与唱片视觉(acid / anti-design):荧光二次色、铬金属、被挤扁的字。
落到界面上一句话:**灰白纸底 + 最多两种荧光 + 全站 2px 纯黑描边**,元素像贴纸一样硬拼在一起。它吵,但吵得有纪律 —— 纪律只有两条:荧光只用两种,圆角只有 0 与 999 两极。

## Colors

- **bg (#F5F4F2)**:灰白,**不是纯白**。⚠ 这是专业与业余的分界:纯白抢走了画面最亮的位置,荧光在它上面只会显脏发灰;底压掉两三度,荧光才浮得起来。
- **ink (#101010)**:文字、2px 描边、图标三者同一个值,bg 上 17.3:1。
- **accent (#C6FF1B)**:酸绿,主强调,**黑字在它上面 16.1:1**;**pink (#F98DFF)** / **cyan (#99F8FF)** / **butter (#FFF8A5)** 是另外三支荧光,配黑字分别 9.3 / 15.6 / 17.4。⚠ **没有一支能配白字**(accent 上白字仅 1.2:1,其余同样低于 2:1)—— 荧光是「亮」不是「浅」,反白必挂。
- **chrome (#C9CDD3)**:铬渐变的中段色,不单独当色块;**muted (#5C5A57)** 是全档唯一的中性灰,只给次级文字;**line (#101010)** 与 ink 同值 —— 这里「线」和「字」本来就是一回事。
- ⚠ **一屏最多两种荧光**,第三种一定是黑或白。四支全上是彩虹糖,不是酸性。

## Typography

- 标题 PP Right Grotesk / Bricolage Grotesque,800,字距 -0.04em —— 字要挤到几乎咬合;**与正文差 3.75 倍**(60/16),中间字号越少越好,这个风格靠尺度悬殊说话。
- ⚠ **挤压走可变字的 width 轴**(Bricolage Grotesque 自带 `wdth`,免费可商用),**别用 `transform: scaleX()`** —— 缩放会把竖笔画连着字重一起压细,一眼就是假窄体。
- 正文 Schibsted Grotesk 400,16px / 1.6 —— 正文是这个风格里唯一老实的地方,别跟着一起玩;小标签 Space Grotesk 或 DM Mono 500 + 0.1em + 全大写,做编号、日期、按钮文字;中文没有真正的等宽族,夹在标签里的汉字兜到系统黑体(苹方 / 微软雅黑,思源黑体在栈尾兜底)。

## Layout

- 12 列网格立着,但内容**故意越栏**:大字出血、贴纸压住栏线 —— 网格是被违反的参照物,不是笼子。元素允许重叠 8-24px,重叠处**不做半透明**,后来的直接盖住,交界留 2px 黑边把两层分开。
- 疏密两极:一块极空,一块塞满(标签成排、编号密集),均匀铺满是这个风格最没气质的做法。
- 允许整体轻微倾斜(≤6°),但**一屏只用一个角度**,且它要和某条边有关系,不是随手转的;元素可出血、可歪,**绝不旋转超过 10°**。

## Elevation & Depth

没有柔阴影,一颗 blur 都不许有。深度只有三个来源,而且**互斥**:

1. **2px 纯黑硬描边**(`0 0 0 2px #101010`):贴纸的边界,卡片 / 按钮 / 图片 / 标签共用同一个宽度。
2. **单色外发光**(`0 0 32px rgba(198,255,27,.5)`):只给悬停 / 激活的**那一个**元素,发光色 = 它自己的荧光色;同屏出现第二处,两处就都不亮了。
3. **铬金属渐变**(`linear-gradient(160deg,#F2F4F7 0%,#C9CDD3 40%,#8E949C 55%,#EDF0F3 100%)`):55% 那道暗带是「反射的地平线」,少了它只是一块灰渐变。⚠ **一屏只允许一个物件用铬**,两个互相打架,金属感立刻塌成塑料感。

Don't:任何带模糊半径的 `box-shadow`;半透明黑投影;发光与铬同屏。

## Shapes

- 形状语言 = **贴纸 + 胶囊**,两极并置没有中间态 —— **圆角只有两个值**:卡片 / 图片 / 输入框 / 容器恒 `0`,按钮与标签恒 `999`(胶囊)。⚠ 8/12/16 这类中间档一出现,它立刻变成通用模板 —— 这是本风格与「模板长相」最直观的一道分界。
- **描边恒 2px 纯黑**,不随元素大小变;直角相交,端点 butt,不用虚线,1px 在这里读作「没画完」。允许的形状只有:矩形、胶囊、正圆(徽章)、四角星闪光(≤2 处)、箭头。

## Components

- **按钮**:accent 胶囊 + 2px 黑边 + 全大写标签体黑字,一屏最多两个;次级按钮 bg 底同款黑边,hover 换 pink 或 cyan,**不加阴影**。
- **标签**:小胶囊,黑边 + 荧光底,成排密集出现是这个风格的典型画面。
- **卡片 / 输入框**:bg 底 + 2px 黑边 + 直角;卡片里可以压图,但**卡片不套卡片**(两圈黑边立刻脏);输入框聚焦态 = 外发光,这是唯一允许发光的常规控件。

## Do's and Don'ts

- Do:荧光色一屏最多两种,第三种一定是黑白;正文永远落在 bg 上用 ink 字(17.3:1)。
- Do:挤压走可变字 width 轴不用 `scaleX`(见 Typography);描边一律 2px 纯黑全站统一 —— 粗细统一比粗细讲究更重要。
- Don't:**紫蓝渐变**(#7C3AED→#2563EB 那一套)。那是 AI 通病的签名,不是酸性;酸性的渐变只有铬。
- Don't:中间档圆角(8/12/16),一出现就变模板;别给荧光色配柔和阴影(荧光是自发光的,不该有柔影);别拿荧光当文字底(全部低于 2:1,见 Colors)。
- **与「几何构成」的分界**:包豪斯是三原色 + 平涂 + 正交网格的秩序;酸性是荧光**二次色** + 金属渐变 + 变宽字挤压 + 贴纸拼贴。一个讲秩序,一个讲过载。
- **与「圆融亲和」的分界**:分在饱和度与硬度 —— 那边低饱和 + 大圆角 + 柔阴影,这边高饱和 + 两极圆角 + 零模糊。

## Composition

- 活动页 / 海报:一个巨大的挤压标题吃掉半屏 + 一块荧光色面 + 一个铬物件 + 一排小标签,就是一屏。
- 图片做双色(ink + 一种荧光),硬裁成正方,加 2px 黑边;人像可先高反差二值化再上色。留白区里什么都不放 —— 这个风格的呼吸全靠那块空着的灰白,它敢空,荧光才敢响。

## Image Prompt Templates

- base: "acid graphic design poster, off-white grey background (#F5F4F2), exactly two fluorescent colors — acid lime (#C6FF1B) and fluorescent pink (#F98DFF), 2px solid pure black outline on every element, one polished chrome metal object with a sharp specular highlight band, ultra-condensed variable-width sans-serif display type with tight letter spacing, sticker collage layout, flat hard-edge shapes, pill-shaped buttons with square containers, 1990s rave flyer aesthetic"
- negative: "purple to blue gradient, soft drop shadow, blurry glow everywhere, pastel palette, 12px rounded corners, 3D render, glossy plastic, watercolor, more than two neon colors, white text on neon"
- 注:荧光数量写死在描述里("exactly two neon colors, everything else black and white");铬写成 "one chrome object",不写死数量模型会满屏铺金属。中文版面补 "clean CJK sans-serif, heavy weight, tight tracking",文案压到几个大词。
