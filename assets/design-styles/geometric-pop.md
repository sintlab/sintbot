---
name: 几何构成
description: 包豪斯与风格派的几何撞色——三原色纪律、大形状、平涂无渐变,明快而有秩序
name_en: "Geometric Pop"
description_en: "The bold geometry of Bauhaus and De Stijl: strict primary colors, large shapes and flat fills with no gradients. Bright and orderly."
suits: "活动推广 · 生图插画"
colors:
  cream: "#F6EFE3"
  ink: "#1C1B1A"
  blue: "#2244A8"
  yellow: "#F2B705"
  red: "#E85D2F"
fonts:
  latin: "'Avenir Next'"
  cjk: sans
typography:
  headline:
    latin: "'Futura', 'Avenir Next'"
    fontSize: "40px"
    fontWeight: 700
  body:
    fontSize: "16px"
    lineHeight: 1.6
    measure: "60ch"
    fontWeight: 400
  label:
    latin: "'Futura'"
    fontWeight: 500
    letterSpacing: "0.1em"
border:
  width: "3px"
  style: solid
  emphasis: "3px"
rounded:
  none: 0px
  circle: 999px
spacing:
  unit: 8px
omitted: ["Components"]
imagery:
  ratio: "1:1"
  treatment: duotone
  crop: hard
icon:
  style: solid
  strokeWidth: "3px"
  linecap: butt
  corner: sharp
---

## Overview

参照物:包豪斯展览招贴、风格派(De Stijl)构成、Paul Rand 的商标草图。
圆、三角、矩形是全部词汇;三个颜色是全部音符。
撞色的秩序感来自「形状大 + 数量少 + 平涂到底」;一多就成了儿童房贴纸。

## Colors

- **cream (#F6EFE3)**:奶油底色——比纯白更有印刷海报感。
- **ink (#1C1B1A)**:近黑,文字与结构线。
- **blue (#2244A8) / yellow (#F2B705) / red (#E85D2F)**:三主色,全部平涂。一张图 2-3 色封顶(含比例悬殊:一色大面积、其余点缀)。
- 不允许出现这五色之外的任何颜色(照片素材除外,且照片要做单色化处理)。

## Typography

- 几何无衬线:拉丁 Futura/Avenir,中文系统黑体(苹方 / 微软雅黑,思源黑体兜底);标题全部粗体,可全大写(拉丁)。
- 文字本身当几何元素用:大字号、实心色块上的反白字、沿形状边缘排布。

## Layout

- 大形状构图:2-4 个几何形占据版面主体,文字嵌在形状的秩序里。
- 对角线是允许的动势来源(旋转 15°/30°/45° 的整角度),但一图只用一个斜向系统。
- 形状可以出血、可以互相咬合(重叠处换色),不加描边。

## Elevation & Depth

**绝对平面**。包豪斯的画面里没有光源,也就没有影子。

1. **层级 = 色块面积比**:最大的那块蓝就是主角,不需要它「浮起来」。
   最大形状是最小形状的 10 倍以上时,主次自明。
2. **重叠 = 实色压印**:蓝压黄的重叠区**直接换成第三色**(画成 red 或 ink),
   不是半透明、不是混色算法——重叠区是一块新的实色形状。
3. **唯一允许的「深度」错觉**:一个正圆压在一个正方上,靠**形状关系**读出前后,不靠阴影。

Don't:box-shadow、渐变、半透明。
Don't:3D 或等距(isometric)透视——那是另一个世纪的语言。

## Shapes

形状语言 = **三个基本形**:正圆、等边三角、矩形。**没有第四种**。

- ⚠ **两档圆角各有专职**:`none 0px` 给一切矩形(色块、按钮、图片、文字块);
  `full 999px` **只给正圆**(圆点、圆形色块、圆形裁图)。**矩形永远不许沾胶囊**——
  胶囊是圆角矩形,不属于基本形,一出现构成就散了。
- **转角族用 `rounded`(直角)不用 `cut`**(M3 逐字:"This makes the corner a straight line
  instead of curved.")——切角会凭空造出第四种形状。
- **不描边**:front matter 的 `border.width: 3px` 是**连线与结构线**的粗细,不是形状的轮廓。
  形状要么实心,要么不存在。
- **线条**:3px 实线,端点 butt,角度只取 0° / 45° / 90°;不用虚线、不用曲线箭头。
- **旋转只取整角度**:15° / 30° / 45°,且一图只用一个斜向系统。
- **图标**:同样由基本形拼成,且**实心平涂**——线性描边图标不属于这套语言(形状要么实心,
  要么不存在)。需要线的地方 3px、端点 butt、转角直角。

## Do's and Don'ts

- Don't:渐变、投影、立体效果——平涂是底线。
- Don't:超过 3 个彩色;第 4 个颜色出现时删掉一个形状。
- Don't:孟菲斯贴纸大杂烩(波浪线、随机圆点、蚯蚓曲线满天飞)。
- Don't:描边形状(要么实心,要么不存在)。
- Do:比例悬殊——最大的形状是最小的 10 倍以上,构成才有张力。
- Do:留出奶油底色的呼吸区,别把版面填满。

## Composition

- 海报:一个主导形状(大圆/大三角)+ 一两个次级形状 + 标题字块,重心稳定在下 1/3。
- 图标/插图:用基本形拼组具象物(几何化的房子/箭头/人形),拼组件数 ≤5。

## Image Prompt Templates

- base: "Bauhaus-inspired geometric poster, flat solid shapes only, cream paper background (#F6EFE3), bold composition of oversized circle and triangle in cobalt blue (#2244A8) and warm red (#E85D2F) with a yellow accent (#F2B705), near-black geometric sans-serif typography, hard edges, no gradients, no outlines, strong scale contrast, 1920s modernist print aesthetic"
- negative: "gradient, drop shadow, 3D, Memphis-style squiggles and confetti, outlined shapes, more than three colors, glossy, childish sticker style"
- 注:形状数量与颜色数量在描述里写死(例如 "three shapes, two colors plus black"),模型不约束就会加料。
