---
name: 伊斯兰几何
description: girih 拼块的 36° 体系与交错编织——全库唯一能自动判对错的风格:角度画错了图案就拼不上
name_en: "Islamic Geometry"
description_en: "The 36° system and interlacing of girih tiles. The only style in the library that can be checked automatically: get an angle wrong and the pattern will not close."
suits: "品牌门面 · 生图插画"
colors:
  paper: "#F1EBDF"
  ink: "#2E241D"
  accent: "#1F4E8C"
  emeraude: "#147D6F"
  safran: "#D8A03D"
  muted: "#8A7C6A"
  line: "#DCD0BA"
fonts:
  cjk: sans
typography:
  headline:
    latin: "'Futura PT', 'Futura', 'Avenir Next'"
    fontSize: "36px"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "0.12em"
  body:
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.7
    measure: "60ch"
  label:
    fontSize: "12px"
    fontWeight: 500
    letterSpacing: "0.16em"
border:
  width: "1px"
  style: solid
  emphasis: "1px"
rounded:
  none: 0px
spacing:
  unit: "8px"
  gutter: "24px"
  margin: "40px"
  maxWidth: "1120px"
  columns: 12
elevation:
  mode: flat
  levels: "0"
imagery:
  ratio: "1:1"
  treatment: duotone
  crop: hard
icon:
  style: line
  strokeWidth: "1.5px"
  linecap: butt
  corner: sharp
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    height: "44px"
    padding: "24px"
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "24px"
  tag:
    backgroundColor: "{colors.safran}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "8px"
---

## Overview

参照物:阿尔罕布拉宫与轩尼洛里菲花园的八重星图案;非斯(Fès)的 zellij 手工釉砖。
**这是本库唯一有「自动判对错」判据的风格。** girih 五种拼块——正十角形、长六边形、领结形、正五边形、菱形——内角**全部是 36° 的倍数**、**边长全等**,所以图案能无缝无限拼接;**画错了会拼不上**。
不需要凭感觉判断好不好看,拼不严就是错的。用它做设计的收益也在这里:一套规则生成无穷变体,而每个变体都自动是"对"的。

## Colors

色板取非斯 zellij 的历史序列:10 世纪只有白与褐,17 世纪起蓝红绿黄齐备,经典组合是**非斯白釉 + 钴蓝 + 釉绿 + 藏红**。

- **paper (#F1EBDF,blanc de Fès)**:非斯白釉,偏奶黄,**不是纯白**——手工釉砖的白从来带温度。
- **ink (#2E241D)**:锰褐近黑,文字与图案骨架线。配 paper 12.5:1。
- **accent (#1F4E8C)**:钴蓝,主强调。配 paper 7.0:1,**是唯一能安全承载正文级白字的釉色**。
- **emeraude (#147D6F)**:釉绿。配 paper 4.2:1 ⇒ 只放 ≥18px 的字,或纯做图案。
- **safran (#D8A03D)**:藏红。配锰褐字 6.5:1,是这套里唯一适合"深字浅底"的强调。
- **muted (#8A7C6A)**:次级信息。配 paper 3.4:1 ⇒ ≥18px 或非文字用途。
- **line (#DCD0BA)**:砖缝色,分隔线与网格线专用。

## Typography

- 拉丁走几何无衬线(Futura 一族)500 + 0.12em 字距——几何字与几何图案同源,圆是正圆、三角是正三角。中文走系统黑体 400(苹方 / 微软雅黑,思源黑体兜底),**不加字距**(汉字加字距会散)。
- 小标签 0.16em、拉丁全大写,与图案的网格节奏对齐。
- **字不与图案争主角**:图案区是主体时,标题最多两行,正文另辟白底区。
- 参照:**TPTQ Arabic**(Kristyan Sarkis 与 Peter Biľak,2015 阿姆斯特丹)、**Khatt Foundation**(Huda Smitshuijzen AbiFarès,2004);**Studio Safar**(贝鲁特,2012)的《Journal Safar》——同一本刊物一端翻是英文左起、另一端翻是阿拉伯文右起,双向阅读排版的现代范本。

## Layout

- 图案区与文字区**分开**:图案铺满一个整块(常为正方或整栏),正文区保持釉白底。
- 12 列网格定文字;图案自己的骨架是 36°(十重)或 45°(八重)体系,**两套网格不混用**。
- 图案单元必须能**无缝重复**:裁切沿单元的重复边界,不沿视觉舒服的位置。
- 留白靠釉白区的整块,不靠元素之间的碎缝。

## Elevation & Depth

**零阴影**。深度来自 **strapwork 交错编织**——带子在每一个交叉点交替压盖(上、下、上、下),这就是这个体系里的"图层"。

1. 底:非斯白釉。
2. 图案带(strapwork):等宽带子,每个交叉点严格交替。**同一根带子的压盖必须全程一致**,走一遍数一遍,错一个点整片图就露馅。
3. 釉色填充:带子围出的多边形上釉,同类多边形同色。

编织本身就够表达前后关系,所以**任何投影都是多余的**,加了反而把二维图案假装成三维浮雕。
Don't:blur 阴影、内阴影、浮雕/斜面效果、渐变填充。

## Shapes

- 一切角度取 **36° 的倍数**(十重体系)或 **45° 的倍数**(八重体系),**一版只用一套**。圆角恒 0,所有交点是尖角。
- 带宽全图统一一个值(图标 1.5px / 版面上 8-12px),不按区域变。允许的形:girih 五拼块、八角星、十角星,以及由它们切出的多边形。
- **方体库法 / banna'i**(بنائي,波斯语"营造"):起源是**用砖砌字**——把曲线的阿拉伯文压进方格,砖块就是像素,釉砖与素砖交替出字。落到品牌上:字标只走直角、笔画等宽、填满 n×n 网格。**拉丁与中文同理可做**,这是本风格最可直接落地的一件事。

## Components

- **按钮**:钴蓝实底 + 釉白字 + 1px 锰褐边,直角;悬停 = 底色换釉绿,**不加影不加圆角**。
- **卡片**:釉白底 + 1px 砖缝色边,padding 24px;顶部或左侧可嵌一条 8px 高的图案带。
- **标签**:藏红实底 + 锰褐小字(6.5:1),小而成排。

## Do's and Don'ts

- Do:一切角度取 36°(或八重的 45°)的倍数,图案单元必须能无缝重复。
- Do:用交错编织表达层次,不用投影。釉色只上在图案上,**正文区保持釉白底**。
- Do:图案要真按几何画。girih 拼块自约 1200 年起用于建筑装饰,1453 年伊斯法罕 Darb-i Imam 神殿是排布水平的分水岭;2007 年 Lu 与 Steinhardt 指出 15 世纪波斯 girih 已具备准晶自相似性质,比 Penrose 铺砌早五个世纪。这套体系的精度是它的全部价值,画歪了就什么都不剩。
- Don't:**把《古兰经》经文或清真言当装饰花纹**。那是圣典文本——用作背景纹样、被裁切、被色块叠压、被拉伸都不得体;要文字元素就用中性词做方体库法。**这一条是本档最重要的红线。**
- Don't:**仿阿拉伯拉丁字体**(把拉丁字母掰成阿拉伯外形的那类 display 字体)。那是把一种文字画成另一种文字的漫画,在使用阿拉伯文的读者眼里是拙劣模仿。
- Don't:灯神、飞毯、骆驼沙丘、月牙星拼贴。**月牙星是国旗与宗教符号,不是素材**。
- Don't:把图案当无骨架的背景贴图随手裁切。**图案有骨架,裁在星心上就散架**。
- Don't:渐变、投影、玻璃质感、3D 浮雕。

## Composition

- 单主体:一整块图案 + 一块釉白文字区,比例约 2:1 或 1:1,**边界是直线**。
- 图案中心放一颗完整的八/十角星,四周的星必须完整或沿重复边界切断,不出现半颗残星。
- 插画走平涂矢量,只用釉色四色 + 锰褐线,不用厚涂、不用高光。
- 照片素材少用;必须用时转双色(锰褐 + 釉白)并硬裁成正方。

## Image Prompt Templates

- base: "Islamic geometric pattern design, girih tiling with tenfold symmetry, every angle a multiple of 36 degrees, equal-length edges, interlaced strapwork bands alternately passing over and under at each crossing, seamless repeating unit, Fez zellij glazed tile palette: warm white glaze ground (#F1EBDF), cobalt blue (#1F4E8C), glazed emerald (#147D6F), saffron yellow (#D8A03D), manganese near-black outline (#2E241D), flat vector, hard edges, no shading, complete eight-pointed and ten-pointed stars"
- negative: "Quranic calligraphy as decoration, arabic script used as ornament, faux-arabic latin lettering, genie lamp, flying carpet, camel, sand dune, crescent and star emblem, mosque silhouette clip art, gradient, bevel, emboss, drop shadow, 3D render, glossy, random crop through star centers, warped pattern"
- 注:模型很爱往图案里塞看起来像阿拉伯文的假字符,提示词必须明写 "no arabic script, no calligraphy, pattern only";出图后**逐个交叉点核对压盖是否交替**、**数星角是否为 8 或 10**,这两项对了这张就成立。
