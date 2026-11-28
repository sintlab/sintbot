---
name: 手绘温度
description: 旅行手账与刊物插画小品的手绘感——铅笔线稿加水彩淡彩,松弛、真诚、有呼吸
name_en: "Hand-drawn"
description_en: "The hand-drawn feel of travel journals and small editorial illustrations: pencil linework with light watercolor washes. Relaxed, sincere and unhurried."
suits: "生图插画 · 内容阅读"
colors:
  paper: "#FAF7F2"
  pencil: "#4A463F"
  wash-blue: "#6C93B4"
  clay: "#C97B5A"
  leaf: "#8FA678"
fonts:
  cjk: sans
typography:
  headline:
    cjk: serif
    fontSize: "32px"
    fontWeight: 500
  body:
    fontSize: "16px"
    lineHeight: 1.7
    measure: "54ch"
    fontWeight: 400
  hand:
    latin: "'Caveat'"
    cjk: hand
    fontWeight: 400
border:
  width: "1.5px"
  style: solid
  emphasis: "2px"
rounded:
  soft: 4px
spacing:
  unit: 8px
omitted: ["Components"]
imagery:
  ratio: "4:3"
  treatment: watercolor
  crop: rounded
icon:
  style: line
  strokeWidth: "1.5px"
  linecap: round
  corner: round
---

## Overview

参照物:旅行手账里的钢笔速写、《纽约客》的单幅插画小品、日本生活杂志的手绘图解。
线稿是骨(铅笔/钢笔的犹豫和断线都保留),淡彩是肉(水彩不填满、故意出界)。
气质是「一个会画画的朋友随手画给你看」——松弛但不潦草,幼稚感是大忌。

## Colors

- **paper (#FAF7F2)**:纸白底,可带极淡的纸纹。
- **pencil (#4A463F)**:暖深灰的线稿色——不是纯黑,铅笔没有纯黑。
- **wash-blue (#6C93B4) / clay (#C97B5A) / leaf (#8FA678)**:三个水彩淡彩色,低饱和、透明感,一图取其二即可。
- 上色逻辑:大面积留纸白,颜色只点在主体的 30-50%,允许溢出轮廓线。

## Typography

- 印刷体为主(衬线标题 + 无衬线正文),手写体(hand)只做批注、箭头旁的短句——**手绘风 ≠ 全篇手写字**,那会瞬间廉价。
- 中文手写标注若无合适字体,宁可用细黑体 + 手绘下划线代替。

## Layout

- 图解式构图:主体居中偏上,四周散布小元素与手写批注,箭头把它们连起来。
- 元素之间留呼吸,散而不乱的秘诀是「视觉重量往一个角收」。
- 边框若有,用手绘抖线单框,不用规整矩形框。

## Elevation & Depth

深度是**画出来的**,不是渲染出来的。三个手段:

1. **线条轻重**:主体用 1.5-2px 实线重线,背景元素用同一个 pencil 色淡一档(约 50% 浓度)
   的细线——近实远虚,一张图里最多两档。
2. **手绘排线(hatching)**:需要投影时,在物体右下画 **3-5 道 45° 短斜线**,长度约物体边长的
   1/4;这是「阴影」在手绘语言里的唯一写法。
3. **水彩深浅**:同色叠两遍 = 近,叠一遍 = 远;叠色边缘留下的深色沉淀线本身就是层次。

Don't:CSS box-shadow 或任何带 blur 的阴影;任何看起来是软件生成的深度(渐变、体积光、发光)。

## Shapes

形状语言 = **手画出来的形**:没有一条边是绝对直的。

- **圆角 4px**(`rounded.soft`),但**不是 CSS 那种完美圆角**——转角是笔顺自然带出的弧,
  四个角不必一样。
- **线条**:1.5px 主线 / 2px 强调线,端点 **round**(笔尖是圆的);允许断线、重线,
  交叉处出头 2-3px——画过界是手绘的证据,不是错误。
- **边框**:只用手绘抖线单框(振幅 ≤2px);虚线画成长短不一的短划,不用等长等距的机器虚线。
- **允许的形状**:抖线矩形、不圆的圆、手绘箭头(轴线微弯 + 开口三角头)、圈重点的椭圆圈。
- ⚠ **不规则度要全图一致**:一张图里既有精确矩形又有抖线框,读起来是「没做完」而不是「手绘」。
- **图标**:跟线稿同一支笔——1.5px 线描、端点 round、转角是笔顺带出的弧(不是尖角);
  宁可歪一点,也别换成规整的几何图标,那和精确矩形一样会破掉手感。

## Do's and Don'ts

- Don't:塑料感 3D、厚涂、赛璐璐描边卡通——手绘感来自线稿与水彩,不是卡通渲染。
- Don't:emoji 式圆脸表情、大眼睛吉祥物。
- Don't:高饱和纯色填充;水彩没有 #FF0000。
- Don't:全篇手写字体。
- Do:保留手的痕迹——断线、重线、水彩边缘的深色沉淀。
- Do:小面积的白色高光留白(水彩的留白,不是加白)。

## Composition

- 单幅小品:一个主体 + 2-4 个环绕的辅助元素 + 手写短批注与小箭头。
- 图解/流程:手绘图标 + 抖线箭头串联,配印刷体说明文字,像笔记本摊开的一页。

## Image Prompt Templates

- base: "hand-drawn illustration, loose pencil and ink linework with visible sketchy strokes, soft watercolor washes in muted blue (#6C93B4) and clay (#C97B5A) that bleed past the lines, warm paper background (#FAF7F2), generous white space, small handwritten annotations with arrows, New Yorker spot-illustration sensibility, warm and unpolished but skilled"
- negative: "3D render, cel-shaded cartoon, thick outlines, saturated flat colors, emoji faces, mascot character, digital gradient, full handwriting typography"
- 注:描述里写清「线稿保留手感、水彩不填满」;出图若太「精致」,在描述里加 loose/sketchy 加重松弛感。
