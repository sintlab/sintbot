---
name: 新中式
description: 民国书局与笺谱的克制东方——宣纸底、墨色字、朱砂一点,是文人气不是影楼中国风
name_en: "Neo-Chinese"
description_en: "The restrained East of Republican-era bookshops and letter-paper albums: rice-paper ground, ink-black text and a single touch of cinnabar. Scholarly, not photo-studio chinoiserie."
suits: "内容阅读 · 品牌门面"
colors:
  paper: "#F5F0E6"
  ink: "#2B2620"
  cinnabar: "#C03F2B"
  indigo: "#3D4A52"
  gold: "#B08D46"
fonts:
  cjk: sans
typography:
  headline:
    cjk: serif
    fontSize: "36px"
    fontWeight: 600
  body:
    generic: "serif"
    fontSize: "16px"
    lineHeight: 1.9
    measure: "36em"
    fontWeight: 400
  label:
    fontWeight: 400
    letterSpacing: "0.12em"
border:
  width: "1px"
  style: double
  emphasis: "2px"
rounded:
  none: 0px
spacing:
  unit: 8px
imagery:
  ratio: "3:4"
  treatment: grayscale
  crop: hard
icon:
  style: line
  strokeWidth: "1px"
  linecap: butt
  corner: sharp
---

## Overview

参照物:民国商务印书馆的书籍函套、荣宝斋的木版水印笺谱、故宫文创里做得最素的那一档。
东方感来自「留白 + 竖排的可能性 + 材质的纸感」,不来自龙凤祥云贴纸。
色是宣纸的暖、墨的黑、朱砂印章的一点红;气质是书房,不是酒楼。

## Colors

- **paper (#F5F0E6)**:宣纸暖白,全部底色。
- **ink (#2B2620)**:暖黑墨色,文字与线描主色——不是冷黑。
- **cinnabar (#C03F2B)**:朱砂红,印章逻辑:小面积、方形/圆形色块或单个重点词,一处足矣。
- **indigo (#3D4A52)**:黛青,次级色,用于图案、山形、次标题。
- **gold (#B08D46)**:泥金,极小面积点缀(一条细线、一个纹样),可整张不用。

## Typography

- **标题用宋体**(思源宋体优先),36px / 字重 600 —— 字够大够重,宋体的骨相才立得住。
- **正文与小标签用黑体**。⚠ 宋体横细竖粗,16px 的正文在屏幕上横画发虚,那不是文人气是糊;
  书卷气靠的是留白、字距与朱砂一点,不靠把正文也压成宋体。拿不到思源宋的机器退黑体,
  **不退中易宋体**。
- 字距宽松是关键:标题字距 0.05-0.15em,竖排时更甚——挤密的宋体就俗了。
- 拉丁与数字选衬线(与宋体骨相一致),别混无衬线拉丁。

## Layout

- 大留白 + 不对称:主体偏置一侧,留白处只放一枚小印或一行小字。
- 竖排是可用的排版语汇(标题、短句),但一图内竖排只用一处。
- 分隔用细墨线或什么都不用;不用西式粗分割条。

## Elevation & Depth

宣纸没有阴影。层级来自**墨色浓淡**与**位置经营**。

1. **浓墨**:ink `#2B2620` 满浓度,主标题、主体线描。
2. **淡墨**:同一个 ink 降到 **60% 浓度**(约 `#6E6862`),注文、次级信息、辅助线描——
   这是这个风格唯一的「层级滑杆」,不要改用第二种颜色去做层级。
3. **朱砂一处**:通常是钤印,或题名旁的一点。**它不是「上层」,是「焦点」**;
   全图只有一处,位置定生死。
4. **留白即层级**(计白当黑):空的地方越大,旁边那块越重。想让一个元素更重,
   先把它周围清空,而不是给它加底色或加框。

Don't:任何让宣纸看起来有厚度的效果(投影/渐变/高光);第二处朱砂。

## Shapes

形状语言 = **版框与印章**:方、直、素。

- **圆角恒 0**(`rounded.none`),包括图片与色块。纸上的东西是裁出来的,裁口是直的。
- **版框**:`border.style: double` 是民国书籍的双线版框,外 2px 内 1px、两线间距 3px;
  全图**最多一个**版框,不做嵌套框。
- **线条**:1px 墨线实线,端点 butt。粗细变化交给线描本身的笔意(白描/木版线条),
  不靠分档的 border-width 去模拟。
- **印章形状**:正方或长方(阳文,朱砂底反白字)/ 正圆(阴文,朱砂线描)。二选一,不并用。
- **允许的形状**:矩形、正圆、细直线。不用箭头、不用圆角标签、不用几何装饰件。
- **图标**:走白描的路子——1px 墨线、端点 butt、转角直角,**不填实心**(实色朱砂只属于印章);
  也不用圆头线条,那是屏幕的软,不是纸上的素。

## Components

组件语汇特殊,**不做 token 化**——这个风格里「卡片」「胶囊」这些词本身就不成立,
以下按纸面元素描述:

- **按钮**:直角方块,1px ink 描边 + 纸底 + ink 字;主操作把描边与字**一起换成 cinnabar**,
  **不做实色填充**(实色朱砂块只属于印章)。
- **卡片:不用卡片。** 要分区就用一条 1px 墨线,或直接留白;加底色的白盒子会立刻变成网页。
- **输入框**:只画底部一条 1px 墨线(界画的格线),不封框、不加底色。
- **导航/目录**:齐左或竖排的宋体条目,字距 0.12em;当前项用 cinnabar 标一个小方点或一个字,
  不用底色条。
- **落款区**:页脚固定一行小字 + 一枚印,是这个风格的「品牌区」,位置全站不变。

## Do's and Don'ts

- Don't:红金满铺、大红配明黄——那是年货,不是新中式。
- Don't:龙凤/祥云/灯笼贴纸式元素;要用传统纹样就用细线一笔带过。
- Don't:书法字体当正文;书法只允许出现在单个大字或印章里。
- Don't:纯白底、冷灰底。
- Do:印章思维——朱砂色块 + 反白小字,是全图的「落款」。
- Do:材质感(纸纹、木版水印的边缘晕染)宁可淡到似有似无。

## Composition

- 一图一景:一个主体(器物/山形/植物),四周大片宣纸留白,题字与印章按书画落款位放置。
- 插画走木版水印/白描线条,不走厚涂与 3D。

## Image Prompt Templates

- base: "modern Chinese literati aesthetic, warm rice-paper background (#F5F0E6), warm ink illustration (#2B2620) in fine woodblock-print linework, one small cinnabar red seal accent (#C03F2B), generous asymmetric negative space, elegant serif CJK typography with loose letter spacing, subtle paper texture, refined and restrained, Republic-era book design sensibility"
- negative: "red and gold everywhere, dragon and phoenix clip art, lanterns, glossy 3D, thick paint, crowded layout, cold white background"
- 注:中文字是这个风格的主角——版面里的字务必拼写正确、字距宽松;字错一处全图报废。
