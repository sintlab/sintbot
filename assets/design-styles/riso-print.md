---
name: 复古印刷
description: Riso 孔版双色印刷——真实油墨色、网点纹理、轻微套印错位,独立 zine 的粗粝浪漫
name_en: "Riso Print"
description_en: "Two-color Risograph printing: real ink colors, halftone texture and slight misregistration. The rough romance of an indie zine."
suits: "生图插画 · 活动推广"
colors:
  paper: "#F3EEE2"
  ink-blue: "#0078BF"
  ink-pink: "#FF48B0"
  ink-orange: "#FF6C2F"
  ink-black: "#1A1A1A"
fonts:
  cjk: sans
typography:
  headline:
    latin: "'Cooper Hewitt', 'GT Pressura'"
    fontSize: "44px"
    fontWeight: 700
  body:
    fontSize: "16px"
    lineHeight: 1.55
    measure: "56ch"
    fontWeight: 400
  mono:
    latin: "'IBM Plex Mono'"
    fontWeight: 400
border:
  width: "0px"
  style: solid
  emphasis: "0px"
rounded:
  none: 0px
spacing:
  unit: 8px
omitted: ["Components"]
imagery:
  ratio: "1:1"
  treatment: halftone
  crop: hard
icon:
  style: solid
  strokeWidth: "2px"
  linecap: butt
  corner: sharp
---

## Overview

参照物:80 年代大学讲义的油印质感、独立出版 zine、日本 riso 工作室的双色海报。
Riso 的美学全部来自限制:一次只印一色、油墨半透明、套印会错位、实色会有网点。
选两个油墨色,把这些「缺陷」当作语言,粗粝但被精心控制。

## Colors

- **paper (#F3EEE2)**:再生纸的米黄底。
- 油墨四选二:**ink-blue (#0078BF)**、**ink-pink (#FF48B0)**、**ink-orange (#FF6C2F)**、**ink-black (#1A1A1A)**——蓝/粉/橙是真实 riso 油墨的标准色号,别自调;黑刻意用近黑(纯黑在纸上并不存在)。
- 双色叠印出第三色(蓝×粉=深紫调),是免费的丰富度;大面积实色要带网点感(50-80% 网点)。
- 一图恒定两油墨 + 纸色,没有例外。

## Typography

- 粗壮的印刷感无衬线(拉丁 Cooper Hewitt/GT Pressura 一路,中文系统黑体 Bold:苹方 / 微软雅黑,思源黑体兜底);等宽字体做编号、日期等「档案感」信息;中文没有等宽族,夹在里面的汉字兜到系统黑体。
- 文字直接用油墨色印,大标题可做 1-2px 的套印错位(两色版本轻微offset)。

## Layout

- 版面像印刷品不像屏幕:通栏大标题、粗规矩的分栏、页码页眉一应俱全。
- 图像处理成单色网点版(halftone)再套油墨色;照片不以全彩出现。
- 大色块 + 反白字是 riso 的强项,敢用。

## Elevation & Depth

孔版印刷是单层纸,**物理上不存在深度**。层级全部由工艺提供,三样:

1. **叠印**:两个油墨色的重叠区自然生成第三色(蓝 × 粉 = 深紫调)。重叠区是画面上最「重」
   的地方——主体压在哪里,哪里就是视觉中心。
2. **网点密度**:这是它的明度台阶。**80% 网点比 50% 重**;同一个油墨色靠 30 / 50 / 80 三档网点
   就能拉出三个层级,不用另调颜色。
3. **纸色留白**:未上墨的 paper `#F3EEE2` 恒为最底层,也是唯一的「后退」手段。

Don't:任何 box-shadow(油印做不出投影,加了立刻变数字味);用半透明模拟层次
(油墨是**叠印**不是混色,半透明会出中间灰,而 riso 没有灰)。

## Shapes

形状语言 = **制版印得出来的东西**:实心块、粗线、网点面。

- **圆角恒 0**(`rounded.none`);`border.width: 0` 是认真的——这个风格**不描边**,
  形状靠色块自身的边界成立。
- **线条**:最细 2px(1px 线在油印上会断),端点 butt、直角相交;**不用虚线**
  (虚线遇上套印错位会碎成乱点)。
- **边缘允许 1-2px 的套印错位**,这是形状语言的一部分,不是瑕疵——但整张图错位方向要一致。
- **允许的形状**:矩形、正圆、粗箭头、网点密度渐变带。不用细腻曲线与小圆角,制版分辨率吃不下。
- **图标**:跟着制版走——**实心块造形**,不描细边;非画线不可时最细 2px、端点 butt、直角相交。
  线描图标印不出来:1px 的边在纸上会断,套印一错位就碎。

## Do's and Don'ts

- Don't:超过两个油墨色;渐变(riso 的「渐变」只能是网点密度渐变)。
- Don't:假做旧滤镜(划痕、咖啡渍、揉纸效果)——riso 的旧来自工艺,不来自贴图。
- Don't:光滑的数字纯色平涂;实色区域必须有油墨的不均匀与网点。
- Don't:细字重(300 以下)——油印糊掉细节,细字是工艺不允许的。
- Do:套印错位控制在「刚能察觉」的程度(1-2px),错太多是印坏了。
- Do:利用叠印色做层次:两色 + 叠印色 + 纸色 = 四个层级,够用。

## Composition

- 海报:一个网点化的大图像主体 + 通栏粗标题 + 档案感小字(编号/日期),像一页被认真印出来的 zine。
- 图解:粗线条图形 + 网点填充,标注用等宽字体。

## Image Prompt Templates

- base: "risograph print poster, two-ink design in riso blue (#0078BF) and fluorescent pink (#FF48B0) on off-white recycled paper (#F3EEE2), visible halftone dots, slight registration misalignment, ink overprint creating a third color, bold chunky sans-serif typography, grainy ink texture, independent zine aesthetic, 1980s duplicator print"
- negative: "full color photo, smooth digital flat color, gradient, fake vintage scratches and coffee stains, thin delicate typography, glossy, 3D"
- 注:换油墨组合时同步改 base 里的两个色名与 hex;两色纪律写死在描述里("exactly two ink colors")。
