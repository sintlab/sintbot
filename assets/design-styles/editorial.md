---
name: 杂志编辑
description: 独立生活杂志的版式——大图、衬线大标题、不对称留白,安静而有故事感
name_en: "Editorial"
description_en: "The layout of an independent lifestyle magazine: big images, large serif headlines and asymmetric white space. Quiet, with a story to tell."
suits: "内容阅读"
colors:
  paper: "#FBF9F4"
  ink: "#1A1A1A"
  accent: "#7A342E"
  muted: "#8C8578"
fonts:
  cjk: sans
typography:
  headline:
    latin: "'Canela', 'Playfair Display'"
    cjk: serif
    fontSize: "56px"
    fontWeight: 500
  standfirst:
    generic: "serif"
    fontWeight: 400
  body:
    latin: "'Neue Haas Grotesk'"
    fontSize: "17px"
    lineHeight: 1.75
    measure: "58ch"
    fontWeight: 400
  caption:
    fontWeight: 400
    letterSpacing: "0.06em"
border:
  width: "0px"
  style: solid
  emphasis: "1px"
rounded:
  none: 0px
spacing:
  unit: 12px
omitted: ["Components"]
imagery:
  ratio: "4:5"
  treatment: none
  crop: full-bleed
icon:
  style: line
  strokeWidth: "1px"
  linecap: butt
  corner: sharp
---

## Overview

参照物:Kinfolk、Monocle、《生活月刊》的内页——摄影当主角、文字当配乐的编辑版式。
一整页只讲一件事:一张好图 + 一个衬线大标题 + 两三行导语。
气质是安静、笃定、略带温度的高级感;所有戏剧性都交给「图片与留白的比例」。

## Colors

- **paper (#FBF9F4)**:米白纸底。
- **ink (#1A1A1A)**:标题与正文的近黑。
- **accent (#7A342E)**:酒红,只用于页码、栏头、一个关键词——编辑元素,不是视觉主角。
- **muted (#8C8578)**:图注、辅助信息的暖灰。
- 摄影本身是第五种颜色:选图时偏自然光、低饱和、有生活痕迹的画面。

## Typography

- 标题衬线(拉丁 Canela/Playfair 一路的现代衬线,中文走系统宋体、思源宋体兜底),字号大但字重不重(500 以内)——大而轻是编辑感的来源。
- 正文与图注用无衬线小字,与标题形成衬线/无衬线的质感对比。
- 导语(standfirst)单独一档:比正文大一号的衬线,行长短、行距松。

## Layout

- 不对称是纪律:图占 2/3 版面时字压另 1/3;绝不左右居中对称。
- 大图出血(贴边),小图留宽白边;两种用法不混在同一版。
- 图注紧贴图片,小字 + 一条细线或什么都不加。

## Elevation & Depth

版面是平的。层级来自**图片的裁切方式**与**字号**,不来自 z 轴。

1. **满出血大图**:顶到版心之外、贴到纸边——它是版面上最「上层」的东西,**一页只有一张**。
2. **版心内图**:规矩落在栏宽上,与正文同层;它是内容,不是主角。
3. **正文唯一的层级工具是字号与行距**:56px 标题 / standfirst / 17px 正文 / caption 小字,
   四档到底,不靠颜色不靠底色块。

Don't:投影、卡片、圆角容器——**这三样一出现,就从杂志变成了网页**。
Don't:用底色块框住一段文字来「强调」;编辑版式的强调靠位置与留白。

## Shapes

形状语言 = **矩形**,而且是**照片本身的矩形**。

- **圆角恒 0**(`rounded.none`),包括图片、图注、页脚。圆角是屏幕的语言,不是印刷的。
- **图片形状只有两种**:4:5 竖构图(默认)与满出血。**不裁圆、不裁异形、不加白色描边**。
- **线条**:0.5-1px 发丝线,ink 或 muted 色、端点 butt;全页最多两条(栏间线、图注线),
  **不用作装饰**。
- `border.width: 0` 是默认状态——元素一律不描边;`emphasis 1px` 只留给图注上方那一条。
- 允许的图形:矩形、页码数字、一个 accent 色的小方点(栏头标记)。**没有图标。**
- **图标**:版面里不放装饰性图标(见上);功能位不得不用时(分享、目录、翻页),用与栏间线
  同一支笔——1px 发丝线、端点 butt、转角是直角,不描粗也不填实心。

## Do's and Don'ts

- Don't:一切元素居中堆成轴对称——那是 PPT,不是杂志。
- Don't:装饰性分割线、花边、角标。
- Don't:图片加圆角、加白色描边、加投影。
- Don't:标题用粗黑体大写吼人;编辑风的音量靠字号,不靠字重。
- Do:留白敢占一半版面;一页只有一个视觉入口。
- Do:图片调性统一(同一组图同一种光线与饱和度)。

## Composition

- 封面/海报:主图 + 压图或邻接的衬线大标题 + 极小的辅助信息行,三层结束。
- 内页式排版:栏宽窄(45-65 字符),行距 1.6 以上,段间不空行用首行缩进(中文)。

## Image Prompt Templates

- base: "editorial magazine layout, large natural-light photograph as hero, warm off-white paper (#FBF9F4), elegant light-weight serif headline, asymmetric composition with generous white space, small sans-serif captions, one burgundy accent detail (#7A342E), Kinfolk-style quiet sophistication, printed matter aesthetic"
- negative: "centered symmetrical layout, decorative dividers, rounded photo corners, drop shadow, bold heavy typography, oversaturated colors, stock-photo look"
- 注:选图气质大于构图技巧——描述画面时写清光线(自然光/侧光)与饱和度(低),否则出图容易素材库味。
