// 项目根目录围栏 —— 控制台里三个「吃本机路径」的入口共用的一份判据:
//   ① 目录浏览 / 新建文件夹(/api/fs/*)  ② 保存群绑定(POST /api/groups 的 workdir)
//   ③ 从本机目录提炼风格(/api/design/extract 的目录侧)
// 以及 doctor(越界的既有绑定要出声)、setup 向导(问一行)、设置页(唯一的修改入口)。
//
// 为什么收成一个模块:此前只有①围在 ~/Projects 里,②③各自敞开 —— 受理侧有围栏、执行侧没重跑
// 一遍,手填一个 /Users/xxx 照样绑得上(2026-09-08 复核)。围栏写在三处必然再漂,这里只写一次。
//
// 判据全部走 realpath:控制台绑的目录是 agent 可写的,agent 一句 `ln -s / ~/Projects/x/root` 就能让
// 字面前缀比较放行整块硬盘;realpath 之后链接指到哪儿就按哪儿算。macOS 用 realpathSync.native 顺带把
// 大小写归一(/users/me/projects → /Users/me/Projects),Windows 再补一层小写比较。
//
// 跨平台:纯字符串部分按**目标平台**的路径规则算(path.win32 / path.posix 由 platform 参数选),这样
// Windows 的规则在 macOS 上也能被单测钉住;只有 realpath 必须在运行的那台机上做。

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// 目标平台的路径实现:Windows 用 win32(盘符 / UNC / 反斜杠),其余 posix。
const P = (platform = process.platform) => (platform === 'win32' ? path.win32 : path.posix)

// 路径比较前的归一:去掉末尾分隔符;Windows 大小写不敏感 ⇒ 小写。
function norm(p, platform = process.platform) {
  let s = String(p || '')
  if (s.length > 1) s = s.replace(/[\\/]+$/, '')
  return platform === 'win32' ? s.toLowerCase() : s
}

// `~` / `~/x` / `~\x` 展开成家目录(Windows 也认,`~` 就是用户目录);别的原样返回(空、非字符串 ⇒ '')。
function expandHome(p, home = os.homedir(), platform = process.platform) {
  if (typeof p !== 'string') return ''
  const s = p.trim()
  if (!s) return ''
  if (s === '~') return home
  if (s.startsWith('~/') || s.startsWith('~\\')) return P(platform).join(home, s.slice(2))
  return s
}

// 平台默认根目录:POSIX 是 ~/Projects;Windows 先看 D:\Projects(D 盘在才算),否则 %USERPROFILE%\Projects。
// ⚠ 永远不落到家目录 —— 旧实现在 ~/Projects 建不出来时静默退到 $HOME,等于围栏悄悄没了。
function defaultProjectsRoot({ platform = process.platform, home = os.homedir(), exists = fs.existsSync } = {}) {
  if (platform === 'win32') {
    let hasD = false
    try { hasD = !!exists('D:\\') } catch { hasD = false }
    return hasD ? 'D:\\Projects' : P(platform).join(home, 'Projects')
  }
  return P(platform).join(home, 'Projects')
}

// 「配了等于没围」的值:文件系统根(/、C:\、UNC 共享根)/ 整个家目录 / 家目录的上一级(/Users、/home、C:\Users)。
// 返回原因文案;'' = 可以当根。
function tooWideReason(p, { home = os.homedir(), platform = process.platform } = {}) {
  const pp = P(platform)
  const r = pp.resolve(p)
  const same = (a, b) => norm(a, platform) === norm(b, platform)
  if (same(pp.parse(r).root, r)) return '是文件系统根目录'
  if (same(r, home)) return '是整个家目录'
  if (same(r, pp.dirname(home))) return '是所有用户目录的上一级'
  return ''
}

// 人输入的多根文本 → 数组:换行或 `;` 分隔(两个平台都认 `;`,Windows 路径里有 `:` 所以不用冒号),去空白去空项。
function parseRootsInput(text) {
  return String(text == null ? '' : text).split(/[\r\n;]+/).map((s) => s.trim()).filter(Boolean)
}

// 配置 → 有效的根目录清单。输入是原始配置对象(读的是顶层 `projectsRoots`,字符串或字符串数组)。
// 返回 { roots, dropped: [{ value, why }], fromConfig }:
//   roots      绝对路径数组,已去重;没配或配的全被丢时 = [平台默认],fromConfig=false
//   dropped    被忽略的条目与原因 —— doctor / 设置页要报出来,不能让人以为围栏按他写的在跑
// 「等于没围」按字面与 realpath **各判一次**:`/Users/ME`(macOS 大小写不敏感)、指向 /Users 的链接,
// 字面上都不是家目录,realpath 之后才是 —— 只判字面等于给「永不退到家目录」留了后门。realpath 只在
// 目标平台就是本机平台时做(别的平台的路径本机解析不了),每次调用只 realpath 一两条根,控制台每个请求调也不贵。
function resolveProjectsRoots(raw, opts = {}) {
  const home = opts.home || os.homedir()
  const platform = opts.platform || process.platform
  const pp = P(platform)
  const canReal = platform === process.platform
  let v = raw && raw.projectsRoots
  if (typeof v === 'string') v = [v]
  const dropped = []
  const roots = []
  // 写成对象 / 数字这类既不是字符串也不是数组的形状:整个忽略,但要记一笔 —— 否则 doctor 只会显示默认根,
  // 人看不出自己写的那段根本没被读
  if (v != null && !Array.isArray(v)) dropped.push({ value: JSON.stringify(v), why: '不是字符串或字符串数组' })
  if (Array.isArray(v) && v.length) {
    for (const item of v) {
      const s = expandHome(item, home, platform)
      if (!s) { dropped.push({ value: String(item), why: '不是字符串或为空' }); continue }
      if (!pp.isAbsolute(s)) { dropped.push({ value: s, why: '不是绝对路径' }); continue }
      const why = tooWideReason(s, { home, platform }) || (canReal ? tooWideReason(realpathLenient(s), { home: realpathLenient(home), platform }) : '')
      if (why) { dropped.push({ value: s, why }); continue }
      const r = pp.resolve(s) // Windows 上正斜杠写法在这里归成反斜杠
      if (!roots.some((x) => norm(x, platform) === norm(r, platform))) roots.push(r)
    }
    if (roots.length) return { roots, dropped, fromConfig: true }
  }
  return { roots: [defaultProjectsRoot({ platform, home, exists: opts.exists })], dropped, fromConfig: false }
}

// 内核语义的宽松 realpath:从盘符/根开始**逐段**走,存在的段立刻 realpath(链接当场跟过去),`..` 作用在
// 跟过链接**之后**的位置上;走到不存在的段之后按字面接下去(算出「它要是存在会落在哪」,新建文件夹 /
// 手填打错的路径都用得上)。只在本机平台上有意义(别的平台的路径本机解析不了)。
// ⚠ 绝不能先 path.resolve 再 realpath:resolve 会先把 `link/..` 字面折叠成 link 的父目录,而内核是先跟链接
//   再上一级 —— `~/Projects/proj/link/..`(link → /anything/deep)按字面在根内、按内核在 /anything。
//   spawn 时 cwd 交给内核,围栏若按字面算就放行了整块硬盘。对抗审查 2026-09-08 逮到,连测试都差点被
//   path.join 折叠的 `..` 骗成恒真(构造用例要用字符串拼接,不能用 path.join)。
function realpathLenient(p) {
  let s = String(p || '')
  if (!path.isAbsolute(s)) s = path.join(process.cwd(), s) // 相对路径不是围栏的正路(保存绑定已拒),这里只求不炸
  const parsed = path.parse(s)
  let cur = parsed.root
  try { cur = fs.realpathSync.native(cur) } catch { /* 根解析不了就按字面 */ }
  let exists = true
  for (const seg of s.slice(parsed.root.length).split(/[\\/]+/)) {
    if (!seg || seg === '.') continue
    if (seg === '..') { cur = path.dirname(cur); continue }
    cur = cur.endsWith(path.sep) ? cur + seg : cur + path.sep + seg
    if (exists) { try { cur = fs.realpathSync.native(cur) } catch { exists = false } }
  }
  return cur
}

// 两个路径按内核语义是不是同一处(realpath 之后再比)。
function samePath(a, b, platform = process.platform) {
  if (!a || !b) return false
  return norm(realpathLenient(a), platform) === norm(realpathLenient(b), platform)
}

// `p` 在哪个根目录之内?返回那个根(配置里写的原样),不在任何根内返回 null。
// 等于根本身也算在内(把整个根绑给一个群是允许的,虽然不推荐)。
function withinRoots(p, roots, platform = process.platform) {
  if (!p || !Array.isArray(roots) || !roots.length) return null
  const rp = norm(realpathLenient(p), platform)
  for (const root of roots) {
    const rr = norm(realpathLenient(root), platform)
    if (rp === rr || rp.startsWith(rr + path.sep)) return root
  }
  return null
}

// 给人看的根目录清单文案(多根用「或」连)。
function describeRoots(roots) { return (roots || []).join(' 或 ') }

// 绑定群目录时的输入归一(向导与控制台保存绑定同一份):先展开 `~`;只收规范的绝对路径 —— 相对路径会随
// daemon 的 cwd 漂,含 `.`/`..` 段或重复分隔符的写法直接拒,不替人猜(`proj/link/..` 字面在根内、内核在
// 链接指向处)。返回 { path }(展开后的绝对路径)或 { error }(给人看的中文)。
function workdirInput(input, { home = os.homedir(), platform = process.platform } = {}) {
  const s = typeof input === 'string' ? input.trim() : ''
  if (!s) return { error: 'workdir 为空' }
  const pp = P(platform)
  // 不用 expandHome:它经 path.join 拼接,会把 `~/a/../b` 里的 `..` 消掉,下面的规范性检查就看不到了
  const p = s === '~' ? home : /^~[\\/]/.test(s) ? home.replace(/[\\/]+$/, '') + pp.sep + s.slice(2) : s
  if (!pp.isAbsolute(p)) return { error: `workdir 要写绝对路径(可以用 ~ 开头): ${p}` }
  const tidy = p.replace(/[\\/]+$/, '') || p
  const cmp = platform === 'win32' ? tidy.replace(/\//g, '\\') : tidy
  if (pp.normalize(cmp) !== cmp) return { error: `workdir 请写规范的绝对路径(不含 . 或 .. 段、不重复分隔符): ${p}` }
  return { path: p }
}

// 向导绑群时的默认项目目录(1.0.4):第一个项目根目录下、以群名命名的子目录;不知道群名(手填的 ID)就用 my-project。
// 此前这一问没有默认值,新手不知道该填哪。群名只做最少的清洗:路径分隔符、Windows 不认的字符、括号和空白换成 `-`,
// 英文转小写,中文原样保留(目录名用中文没问题)。
function defaultWorkdir(name, roots, { platform = process.platform, home = os.homedir() } = {}) {
  const root = (roots && roots[0]) || defaultProjectsRoot({ platform, home })
  const slug = String(name || '').trim().toLowerCase().replace(/['’]s\b/g, '').replace(/['’]/g, '')
    .replace(/[\\/:*?"<>|#()（）\[\]\s]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60)
  return P(platform).join(root, slug || 'my-project')
}

module.exports = { norm, expandHome, defaultProjectsRoot, tooWideReason, parseRootsInput, resolveProjectsRoots, realpathLenient, samePath, withinRoots, describeRoots, workdirInput, defaultWorkdir }
