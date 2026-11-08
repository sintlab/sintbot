---
name: 装饰艺术
description: 近黑棕底上的金色细双线、阶梯轮廓与日出放射——贵气来自字距与几何,不是金属贴图
name_en: "Art Deco"
description_en: "Fine gold double rules, stepped outlines and sunbursts on near-black brown. The luxury comes from letter spacing and geometry, not metallic textures."
suits: "品牌门面 · 活动推广"
colors:
  bg: "#12100E"
  panel: "#1D1A16"
  ivory: "#F3EDE1"
  gold: "#C39E6D"
  brass: "#8A6A3B"
  jade: "#0E4C44"
  line: "#3A3229"
fonts:
  latin: "'Jost'"
  cjk: sans
typography:
  headline:
    latin: "'Neutraface Display', 'Poiret One', 'Limelight'"
    fontSize: "46px"
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: "0.14em"
  body:
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.7
    measure: "60ch"
    letterSpacing: "0.01em"
  label:
    latin: "'Josefin Sans'"
    fontSize: "12px"
    fontWeight: 600
    letterSpacing: "0.20em"
border:
  width: "1px"
  style: double
  emphasis: "1px"
rounded:
  none: 0px
  circle: 999px
spacing:
  unit: "8px"
  gutter: "32px"
  margin: "48px"
  maxWidth: "1200px"
elevation:
  mode: flat
  levels: "0"
imagery:
  ratio: "3:4"
  treatment: duotone
  crop: hard
icon:
  style: solid
  strokeWidth: "1px"
  linecap: butt
  corner: sharp
components:
  button-primary:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.bg}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    height: "44px"
    padding: "24px"
  button-primary-hover:
    backgroundColor: "{colors.brass}"
    textColor: "{colors.ivory}"
  card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.none}"
    padding: "32px"
  input-field:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.none}"
    height: "44px"
  tag:
    backgroundColor: "{colors.jade}"
    textColor: "{colors.ivory}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
  badge-circle:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.bg}"
    rounded: "{rounded.circle}"
    size: "40px"
---

## Overview

参照物:1925 年巴黎 Exposition Internationale des Arts Décoratifs(这个展名就是 Art Deco 的出处);**A.M. Cassandre** 的邮轮海报 *Normandie*(1935)与 *Nord Express*(1927),及他与 Deberny & Peignot 合作的 Bifur(1929)/ Acier Noir(1935)/ Peignot(1937);Chrysler Building(William Van Alen,1930);当代样本 **LAFC 品牌识别**(2016,Matthew Wolff + Tue Nguyen:Neutraface + 黑 + California Gold #C39E6D)。气质是「机器时代的贵气」:几何、对称、向上、金属而不炫目。

## Colors

- **bg (#12100E)**:近黑棕(noir),**不是纯黑**——纯黑配金会立刻变成廉价颁奖礼请柬。
- **panel (#1D1A16)**:抬高一档的面板底。深色的层次靠这一档明度差,不靠投影。
- **ivory (#F3EDE1)**:标题与正文色,与 bg 16.3:1。别用纯白。
- **gold (#C39E6D)**:主强调。与 bg **7.6:1**,做正文强调、按钮底、细线都安全;面积 **≤10%**——金是线和字,不是面。
- **brass (#8A6A3B)**:黄铜暗调,与 bg 3.8:1,只够大字与次级信息,不排正文。
- **jade (#0E4C44)**:第二色块。与 bg 只有 1.9:1(几乎融进底色),所以它**只能做大色块**,上面压 ivory 字 8.4:1。
- **line (#3A3229)**:结构线与分栏线;它与金色装饰双线是两套东西,不混用。

## Typography

- **标题**:Neutraface Display(House Industries,Christian Schwartz 2002,据建筑师 Richard Neutra 的招牌字重绘)——⚠ **需商业授权**。免费回退 Poiret One / Limelight,但**两者都只有 400 一个字重**:标题的分量因此必须靠**字号与字距**,**绝不要用 `font-weight` 让浏览器合成假粗**(合成粗体会把 Deco 的细笔画糊成一团,一眼露怯)。
- **正文交给 Jost**(Futura 精神的当代重制,x-height 更高、小字更耐读)。Futura 本尊 x-height 太小,16px 正文读起来累。
- **label**:Josefin Sans 600、字距 0.20em、全大写。**贵气来自字距不来自字重**——标题全大写 + `letter-spacing ≥ 0.12em` 是这个风格的硬约定。

## Layout

- 8px 基准、12 栏;**纵向 section 间距取横向的两倍**(64 / 96px)——Deco 的「向上」感来自纵向拉伸,横向反而要收紧。
- **严格对称是允许的**,主标题居中也是允许的(这是它与瑞士网格、编辑风最大的不同)。
- 两个签名母题(1925 年博览会上同时确立在纺织、珠宝、建筑三处):① **阶梯 / ziggurat 轮廓**——标题栏或卡片顶部做 2-3 级台阶收边,每级等高;② **扇形 / 日出放射线**——作章节分隔或页脚,射线取奇数、角度等分。另在页眉页脚各留一条金色细双线,把版心「装裱」起来。

## Elevation & Depth

`elevation.mode: flat`——没有投影。深度全部来自**线与轮廓**:

1. **金色细双线 rule**:`1px + 3px 间隙 + 1px`,是这个风格的签名。它同时承担分隔、装饰,以及「这一块比那一块重要」的层级表达。
2. **阶梯形色块收边**:panel 底的卡片顶部做 2-3 级台阶,台阶本身就读成厚度。
3. **bg / panel 两级底色**:面板浮起靠这一档明度差。

Don't:模糊阴影、外发光、金属渐变——**单色平涂 + 1px 细线比任何渐变都贵**,这条是本风格最重要的一句话。

## Shapes

- **圆角恒 0**,唯一例外是**正圆**(`rounded.circle`):徽章、序号牌、放射线的圆心。
- **边框 1px 双线**(`border.style: double`),金色;结构性的框改用 line 色单线。
- 允许的形状:矩形、正圆、等腰三角(作射线与山形)、阶梯折线。**不用椭圆、不用波浪、不用切角。**
- 图标:实心、平头、直角转角,用圆 + 三角 + 矩形拼出来,不用线性描边图标。图片双色化(duotone:bg × gold 或 bg × ivory),硬裁 3:4,四边可加一条金色单线。

## Components

- **按钮**:gold 实底 + bg 字 + label 排版(全大写 0.20em),直角、44px 高;hover 落到 brass 底 + ivory 字,**不位移不加圆角**。
- **卡片**:panel 底 + 金色双线上下封边,顶部可做阶梯收边。
- **标签**:jade 实底 + ivory 字,小而扁,一屏 ≤3 个。**徽章**是正圆 40px、gold 底、bg 字——全站唯一的圆形。
- **输入框**:panel 底、底部一条金线;聚焦时那条线加粗到 2px,不发光。

## Do's and Don'ts

- Do:标题全大写 + `letter-spacing ≥ 0.12em`。
- Do:金色面积 ≤10%,并优先做线与字(#C39E6D on #12100E = 7.6:1,做正文强调安全)。
- Do:严格对称;主标题居中是允许的。
- Do:**分层策略**——参照 *BioShock*(2007)的做法:装饰性 deco 字只用在 logo 与世界内的海报上,**HUD、菜单、字幕全部换成安静易读的字**。这是 Art Deco 数字化的正解,也是它不显廉价的关键。
- Don't:金属渐变、金箔贴图、高光扫过的假金属——单色平涂永远更贵。
- Don't:正文用装饰性 deco 字(Poiret One / Limelight 排段落等于让人放弃阅读)。
- Don't:圆角、柔和阴影、「卡片浮起来」的暗示。
- Don't:用 `font-weight: 700` 给只有 400 字重的显示字合成假粗。
- Don't:把它做成「赌场 / 颁奖礼 / 婚礼请柬」——那三样的共同点都是纯黑底 + 渐变金。

## Composition

- 海报式:上下各一条金色双线装裱 → 居中的阶梯形标题栏 → 一张 duotone 竖图 → 页脚放射扇形。
- 版面纵向拉长,元素之间宁可空 96px 也不要挤,左右反而收紧到 48px;一屏的金色元素要数得出来——一条双线、一个按钮、一个徽章,到此为止。

## Image Prompt Templates

- base: "art deco poster, 1925 Paris exposition style, deep near-black brown background (#12100E), flat matte gold linework (#C39E6D), stepped ziggurat framing, sunburst radiating lines, strict bilateral symmetry, geometric machine-age forms, ocean-liner poster composition in the manner of A.M. Cassandre, duotone illustration, 3:4 vertical, crisp 1px rules, no gradients"
- negative: "metallic gradient, gold foil texture, specular highlight, glossy 3d render, rounded corners, soft shadow, casino signage, wedding invitation flourish, neon glow, cluttered ornament"
- 注:模型一听 "gold" 就会给金属渐变和高光——negative 里必须点名 "metallic gradient" 与 "gold foil",base 里强调 "flat matte gold linework";另外别让模型写文字,Deco 标题的字距与阶梯造型它做不准,文字一律后期排。
