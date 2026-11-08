---
name: 瑞士网格
description: 国际主义排版风格——严格网格、大量留白、单一强调色,冷静克制的现代主义
name_en: "Swiss Grid"
description_en: "The International Typographic Style: a strict grid, plenty of white space and a single accent color. Calm, restrained modernism."
suits: "内容阅读 · 品牌门面"
colors:
  primary: "#111418"
  secondary: "#5C6066"
  accent: "#D93025"
  neutral: "#F4F3EF"
  line: "#C9C7C0"
fonts:
  latin: "'Neue Haas Grotesk', 'Helvetica Neue'"
  cjk: sans
typography:
  headline:
    fontSize: "48px"
    fontWeight: 700
    letterSpacing: "-0.02em"
  body:
    fontSize: "16px"
    lineHeight: 1.6
    measure: "66ch"
    fontWeight: 400
  label:
    fontWeight: 500
    letterSpacing: "0.08em"
border:
  width: "1px"
  style: solid
  emphasis: "1px"
rounded:
  none: 0px
spacing:
  unit: 8px
imagery:
  ratio: "3:2"
  treatment: grayscale
  crop: hard
icon:
  style: line
  strokeWidth: "1px"
  linecap: butt
  corner: sharp
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    height: "40px"
    padding: "20px"
  button-primary-hover:
    backgroundColor: "{colors.accent}"
  button-secondary:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.primary}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    height: "40px"
    padding: "20px"
  input-field:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.primary}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    height: "40px"
    padding: "12px"
  tag:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.neutral}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    height: "24px"
    padding: "8px"
---

## Overview

参照物:1960 年代 Josef Müller-Brockmann 的音乐厅招贴、苏黎世设计学院的展览目录。
一切秩序来自网格与字号,而不是装饰。纸感的暖白底、近黑的墨色文字、唯一一点红。
气质是「工程师的冷静」——信息密度可以高,但每一毫米都有依据。

## Colors

- **primary (#111418)**:近黑墨色,承担 90% 的文字与图形。
- **secondary (#5C6066)**:注释、次级信息的中灰。
- **accent (#D93025)**:全局唯一的强调红,一张图里出现不超过两处(一个标题词、一条线、一个箭头)。红是信号,不是装饰。
- **neutral (#F4F3EF)**:暖白纸底。不用纯白 #FFF——纸感来自这一点点暖。
- **line (#C9C7C0)**:网格线、分隔线专用,细而浅。

## Typography

- 无衬线一族走到底:拉丁 Neue Haas Grotesk / Helvetica,中文系统黑体(苹方 / 微软雅黑,思源黑体在栈尾兜底)。
- 层级只靠字号与字重拉开(大标题可以非常大,与正文形成 4 倍以上的反差),不靠颜色和斜体。
- label 类小字全大写(拉丁)+ 加宽字距,是这个风格的签名细节。

## Layout

- 严格的列网格(海报 6 列、界面 12 列),元素必须落在网格线上;留白占版面 40% 以上。
- 齐左不齐右(拉丁);对齐是唯一的装饰。
- 图片裁成网格整数倍的矩形,不加边框不加圆角不加投影。

## Elevation & Depth

深度**不存在**。这是印刷品,纸只有一层。

- **Level 0 是唯一一层**:所有内容直接落在 neutral 纸底上,没有第二层底色。
- 分区只有两种手段:**一条 1px 的 line 横线**,或**一整段留白**(≥3 倍常规间距 = 24px 起)。
  二者等效,**优先留白**。
- 主次靠字号跳跃(48/16,4 倍差)与 accent 红的位置——红落在哪里,哪里就是第一视线。
- 需要一个区块看起来独立时:加一条线,或多留 3 倍的白。**不要把它变成卡片。**

Don't:任何 box-shadow(哪怕 1px 模糊);白卡叠在白底上制造「浮起」的错觉。

## Shapes

形状语言 = **网格切出来的矩形**。

- **圆角恒 0**(`rounded.none`),包括图片、输入框、头像。圆角一出现,秩序感就换成了亲和感。
- **线条只有一种**:1px 实线 line 色,端点 butt(平头),只走水平或垂直;不用虚线、不用斜线。
- 描边用得极省:图片不描边、区块不描边。线只用来**分隔**,不用来**包围**。
- 允许的形状:矩形、正圆(仅作图表数据点)、实心三角(仅作箭头)。装饰性图形一个都没有。
- **图标**:与网格线同一支笔——1px 实线、端点 butt(平头)、转角直角,不圆头也不填实心。
  图标是标识不是装饰件,能用文字说清的地方就不要图标。

## Components

- **按钮**:方角实心块,高 40px、左右内边距 20px。主按钮 primary 底 + neutral 字;
  hover **换成 accent 红**(不是变深)——这个风格里状态变化是换色,不是加效果。
- **次级按钮**:同尺寸,neutral 底 + 1px line 描边 + primary 字。层级差别只在填色。
- **输入框**:与按钮同高(40px),只画**底部一条 1px line**;聚焦时线换 primary 并加粗到 2px,
  **不加外发光、不加背景色变化**。
- **标签**:accent 实色小块,高 24px。一屏最多一个——它和红标题共用「唯一强调」的配额。
- 所有控件高度取 `spacing.unit` 的整数倍(24 / 40 / 48),对不齐网格的控件不要出现。

## Do's and Don'ts

- Don't:任何渐变、任何投影、任何圆角。
- Don't:第二种强调色。红已经在了,想加蓝的时候删一个元素。
- Don't:斜体、艺术字、描边字。
- Don't:居中排版(标题正文全部齐左;居中只允许出现在单行封面字)。
- Do:敢留白,敢把标题放大到「有点过分」的程度。
- Do:用一条 1px 的线解决所有分区需求。

## Composition

- 单主体、强轴线:主体沿网格垂直/水平轴放置,视线路径从大字号向小字号流动。
- 摄影素材转黑白或单色化处理后再进版面,避免彩色照片打破配色纪律。

## Image Prompt Templates

- base: "Swiss International Typographic Style poster, strict grid layout, generous negative space, warm off-white paper background (#F4F3EF), near-black ink text (#111418), a single red accent (#D93025), Helvetica-style grotesque typography, flat, no gradients, no shadows, precise and rational, 1960s Zurich design school aesthetic"
- negative: "gradient, drop shadow, rounded corners, multiple bright colors, 3D render, glossy, clip art, emoji"
- 注:生成带中文文字的版面时,在 base 里补 "clean CJK sans-serif typography";文字宁少勿多。
