---
name: 液态玻璃
description: 半透明材质浮在真实内容之上——模糊加折射、边缘内高光、同心圆角,清透但不牺牲可读
name_en: "Liquid Glass"
description_en: "Translucent material floating over real content: blur and refraction, inner edge highlights and concentric corners. Clear, without giving up legibility."
suits: "工具产品 · 品牌门面"
colors:
  bg: "#E8EDF4"
  surface: "#FFFFFF"
  ink: "#0B0D12"
  muted: "#5A6273"
  accent: "#007AFF"
  line: "#D3DAE5"
fonts:
  latin: "'SF Pro Text', -apple-system, 'Host Grotesk'"
  cjk: sans
typography:
  headline:
    latin: "'SF Pro Display', -apple-system, 'Host Grotesk'"
    fontSize: "34px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.022em"
  body:
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.01em"
    measure: "64ch"
  label:
    fontSize: "15px"
    fontWeight: 600
border:
  width: "1px"
  style: solid
  emphasis: "1px"
rounded:
  md: 12px
  lg: 22px
  xl: 28px
  full: 999px
spacing:
  unit: "8px"
  gutter: "16px"
  maxWidth: "1080px"
elevation:
  mode: glass
  levels: "2"
imagery:
  ratio: "16:9"
  treatment: none
  crop: rounded
icon:
  style: line
  strokeWidth: "1.5px"
  linecap: round
  corner: round
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    height: "44px"
    padding: "20px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    height: "44px"
    padding: "20px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "20px"
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "12px"
  tag:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    height: "26px"
    padding: "10px"
---

## Overview

参照物:Apple 2025 年 6 月发布的 Liquid Glass 材质(发布稿原文 "reflects and refracts its surroundings"、控件要 "fit perfectly concentric with the rounded corners")、WWDC25 Session 219《Meet Liquid Glass》、HIG › Materials。

核心不是「半透明白卡片」,是一层**有厚度的材质**:它取下层内容做模糊 + 提饱和,边缘留一道内高光当作光打在玻璃棱上,所以它跟着底下的内容变颜色。判断做没做对只有一条标准:**底下必须是真实内容**(照片/地图/视频/长列表),玻璃滑过时看得出下面的东西在动。底下若是一块装饰渐变,玻璃就退化成一张磨砂贴纸。

⚠ **这个风格有个表达天花板**:它的性格全在「半透明 + 实时模糊」,而微缩预览图画不出这两样(图上只会显示浅底 + 大圆角 + 一个蓝按钮)。选它之前最好另找一张真实截图看,别只看预览图。

## Colors

- **bg (#E8EDF4)**:冷调浅灰蓝。它是**占位的衬底不是画面** —— 真做起来这层该被照片/地图/内容列表替掉,玻璃需要下面有东西可折射。
- **surface (#FFFFFF)**:玻璃本色。落地时**永远带透明度**(见 Elevation),纯不透明白只出现在承载正文的实底卡。
- **ink (#0B0D12)**:近黑。白底 19.4:1、bg 底 16.5:1 —— 玻璃上文字能不能读全指望它。
- **muted (#5A6273)**:次级文字,白底 6.1:1。⚠ **只用在实底区**;玻璃层上一律 ink 或纯白,半透明背景已经吃掉一档对比,再降级必挂。
- **accent (#007AFF)**:系统蓝,给按钮填充、图标、激活态。⚠ **它承载文字只有 4.02:1(白底),不达正文 4.5:1** —— 链接文字用深一档的 `#0062CC`(5.8:1),`#007AFF` 留给填充与图标;白字压 #007AFF 同样是 4.02:1,按钮文字请 15px/600 起,要严格达标就把按钮底压到 `#0062CC`(白字 5.8:1)。**这是这套色板唯一要自己拍板的取舍,别假装它过了。**
- **line (#D3DAE5)**:实底区的分隔线与描边。⚠ 玻璃层**不用它描边**,见 Shapes。

## Typography

- 全族 SF Pro(拉丁)+ 苹方 / 微软雅黑(中文,思源黑体兜底),Host Grotesk 作无 SF 环境的回退。
- 标题 Display 600 `-0.022em`、正文 Text 400 `-0.01em` —— **大字收紧、小字放松**是这一族的光学字距规则,不是随手写的数。
- 小标签 **600 字重,不加宽字距**:这套体系靠字重区分层级,给小字加 0.08em 是瑞士/科技风的手法,放这里立刻串味。
- 标题与正文反差只有 2 倍(34/17),克制是它的性格。⚠ 玻璃上最小字号 **15px / weight 500**,12px 白细字在玻璃上等于没有。

## Layout

- 分层不分块:内容是**一整片连续的滚动流**,chrome(导航条/标签栏/工具条)浮在它上面。别把版面切成一格一格的玻璃卡片阵 —— 那是把材质当装饰用。
- 8px 栅格,组件间距 16/20/24;玻璃面板内边距 20px 起,材质要留白才看得出通透。
- 浮动控件贴边距 16px,与内容之间**不留分隔线**,靠材质本身分离;内容区最大宽 1080px,正文行长 64ch。

## Elevation & Depth

深度来自**材质**而不是投影距离:玻璃有厚度,所以它同时有模糊、有高光、有一点很淡的落影。

1. **Level 0**:内容层。完全实底、不加任何模糊 —— 它是被折射的对象。
2. **Level 1**(导航条/标签栏/工具条):`backdrop-filter: blur(24px) saturate(180%)`;`box-shadow: 0 1px 1px rgba(11,13,18,.04), 0 8px 24px rgba(11,13,18,.10)`;内高光 `inset 0 1px 0 rgba(255,255,255,.65)`。
3. **Level 2**(弹窗/菜单/浮层):同一套材质,阴影加到 `0 16px 40px rgba(11,13,18,.16)`,模糊**不要再加**(超过 30px 底下糊成一片灰,折射感反而没了)。

三条硬规矩:**内高光是签名**,漏了玻璃就变磨砂塑料;`saturate(180%)` 不能省,只模糊不提饱和会把底下的颜色洗成灰;**阴影永远比模糊轻**,它只把玻璃抬起 1-2mm,不做立体感。

Don't:两层玻璃直接叠;给玻璃再加内阴影;用渐变去「画」出玻璃 —— 这材质必须由 `backdrop-filter` 实时算,画出来的假玻璃一滚动就露馅。

## Shapes

形状语言 = **连续圆角的胶囊与圆角矩形**,没有一处直角。

- **同心圆角规则(最容易做坏的一条)**:外圆角 = 内圆角 + 内边距。22px 圆角的面板里放 8px 内边距的按钮 ⇒ 按钮圆角必须是 14px。嵌错了(内比外圆、或两者相等)整套观感立刻塌成「随手套的圆角」。
- 圆角档位:输入框 12 / 卡片与面板 22 / 大浮层 28 / 按钮与标签走 `full` 胶囊。
- **玻璃边缘不用 1px 灰描边** —— 那是 2013 年的拟物残留。边缘靠内高光划定;`border.width` 那个 1px 是给**实底组件**(输入框、实底卡)用的,别混。
- 图标细线 1.5px、圆头圆角,与胶囊语言同构。

## Components

- **主按钮**:accent 实色胶囊 + 白字,一屏最多一个 —— 唯一允许用满强调色的元素。
- **次按钮**:玻璃胶囊(surface + 55-72% 透明 + 同款模糊),文字用 ink。
- **卡片**:22px 圆角。⚠ **承载正文的卡片一律实底**,只有 chrome 层才用玻璃(见下一节)。
- **输入框**:实底白 + 12px 圆角 + 1px `line` 描边;聚焦态描边换 accent 加 3px 外圈 `rgba(0,122,255,.18)`,**不加发光**。
- **标签**:胶囊,玻璃或浅实底二选一,全站只用一种。

## Do's and Don'ts

- Do:让底下有真东西 —— 照片、地图、视频、内容列表。背景决定这个风格成不成立。
- Do:玻璃只给 chrome 层,正文内容区一律实底;同心圆角算清楚再画,档位全站锁死这四个值。
- Don't:**玻璃叠玻璃**。两层模糊叠加后对比度不可控,文字必挂,性能也塌。
- Don't:玻璃上承载表格、长文、密集数据 —— 要读的东西放实底。
- Don't:玻璃上放 12px 白细字(最小 15px / weight 500)。
- Don't:**紫蓝渐变背景 + 白玻璃卡片**。那是被模板玩烂的长相,也正是 AI 生成图的标准脸;背景该是真实内容,不是装饰渐变。
- Don't:用 PNG 或 CSS 渐变伪造玻璃;不做无模糊回退与 `prefers-reduced-transparency`。

## 可用性底线

这一节不是建议,是能不能交付的门槛。NN/g《Liquid Glass Is Cracked》点名了四类实测问题:**文字压在图上对比不足 · 图标融进背景认不出 · 半透明层里文字叠文字 · 浮动控件与内容争视觉**。Apple 自己在后续测试版里下调过透明度 —— 连原厂都要往回收,说明这材质的默认值天然偏激进。

1. **玻璃只用在 chrome 层**:导航条、标签栏、工具条、弹窗可以;正文区、表格、表单、长文一律实底。判据是一句话 —— **要读的东西不放在会动的背景上**。
2. **透明度按底色分两档**:暗底场景 `rgba(255,255,255,0.10)`,亮底场景 `rgba(20,22,26,0.55)`,保证其上文字 ≥4.5:1。
3. **两张背景各测一次**:找应用里**最亮和最暗**的两张真实背景,把同一块玻璃分别放上去量对比度,**两次都过才算过**。只测一张等于没测 —— 玻璃的对比度是随背景浮动的。
4. **图标不能只靠颜色立住**:玻璃上的线性图标要么加 1.5px 深色描边,要么坐在一块实底圆形上。
5. **回退与偏好**:`@supports not (backdrop-filter: blur(1px))` 给实底回退(不透明 surface + line 描边);响应 `prefers-reduced-transparency: reduce` 时整套换实底 —— 这是系统级无障碍开关,不是可选项。
6. **浮动控件让位内容**:玻璃层面积一屏不超过 20%,滚动时**不加放大或视差**,它是容器不是主角。

## Composition

- 一屏一层玻璃:满幅真实内容 + 顶部或底部一条玻璃 chrome,结束。
- 玻璃条要**压着内容边缘**放(看得见下面的东西被它切走一半),悬在纯色空白上等于白做。
- 图片 16:9,圆角与所在容器同心,不加描边不加投影 —— 深度由玻璃提供,图片只管平铺。想展示材质本身时让内容在玻璃下滚动一段再截图,静态图选下层色彩丰富的画面。

## Image Prompt Templates

- base: "iOS-style translucent glass panel floating over a real photographic background, heavy background blur with increased saturation, subtle inner top highlight along the panel edge, very soft ambient shadow, continuous rounded corners with concentric nesting, blue accent pill button (#007AFF), near-black text (#0B0D12), clean SF-Pro-like sans-serif typography, light cool gray-blue environment (#E8EDF4), crisp and legible"
- negative: "purple blue gradient background, frosted plastic card on flat gradient, 1px gray border on glass, neon glow, heavy drop shadow, tiny thin white text, sharp 90-degree corners, skeuomorphic bevel, stacked glass layers"
- 注:底层背景要写成**具体的真实画面**(照片/地图/列表),写 "gradient background" 出来的就是那张烂大街的模板脸;中文版面补 "clean CJK sans-serif typography, 15px minimum text size"。
