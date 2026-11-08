// 项目长期记忆与约定文件的探测(跨模型记忆交接)。
//
// 由来:一个群换了模型大脑之后,上一任攒下的东西并不跟着走。⭐ 但**缺的不是能力,是可达** ——
// 群都是完全访问(codex 侧 = danger-full-access),那些 markdown 它本来就读得到;只是没有任何
// 地方告诉过它「有这东西、在哪、什么规矩」。所以正解落在**自知清单**上,不是搬运数据、
// 不是第三本账、也不是切换那一刻补一轮握手 —— 交接该是持续发生的。
//
// 已验死的事实:
//  · codex 运行时**不读 CLAUDE.md**(二进制里 AGENTS.md 出现 77 次,CLAUDE.md 只出现在
//    「从 Claude Code 一次性导入」的向导串里)⇒ claude 群里天天更新的那份约定,换成 codex
//    就等于不存在。反过来 claude 不读 AGENTS.md。⇒ **约定文件那一行**无条件点名存在的每一份,
//    对本来就会自动加载的那一方是无害冗余,对另一方是救命。
//  · 私有记忆目录 = <配置目录>/projects/<slug>/memory。slug 规则见 memorySlug —— **从实物
//    反推,不是猜**。
//
// ⚠ **路径只能探测,不许推算** —— 给错路径比不给更糟:agent 会照着去读,读不到就学会
// 「这项目没有记忆」这条错信念(一次失败的交互会在会话里固化成信念,之后它绕路不再试),
// 而更坏的一头是读到**别的项目**的记忆还照着做。所以:每条路径都 stat 过才敢往外报,
// workdir 本身必须是真实目录,归属还要再过一道权威源。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// 项目根的约定文件。⚠ 顺序有语义(清单按它挑「往哪写」的落点),故测试里用字面量断言,
// 不许拿这个常量自己当期望 —— 那样顺序怎么改都测不出来。
const CONVENTION_FILES = ['CLAUDE.md', 'AGENTS.md']

// 记忆条数只报**档位**,不报精确值。
// ⚠ 这是清单指纹的硬约束,不是偷懒:engine 靠「清单文本变了没」决定要不要重注入,并在变了时
// 对 agent 说一句「你的能力/配置已更新」。而真实项目**每天都在长记忆**(实测四天 +1),报精确
// 值 ⇒ 指纹天天变 ⇒ 每天白重注入一份几 KB 的清单,还对 agent 说了假话(能力根本没更新)。
// ⚠ 残留(已知、接受):claude 侧框架会**自己**往记忆目录写 ⇒ 跨档那一刻仍会翻一次指纹。
//   这是清单里第一个 agent 自己就能触发的字段。档位只把频率从「每天」压到「跨档时」,没有消除。
const BUCKETS = [500, 200, 100, 50, 20, 10]
function countBucket(n) {
  for (const b of BUCKETS) if (n >= b) return `${b}+ 条`
  return '不到 10 条' // 10 以下不报数:小项目每加一条都会翻指纹,而 3 条与 5 条对读不读毫无区别
}

// slug 规则 = **realpath 之后,把 `/` 和 `_` 都压成 `-`**。本机 20 个记忆目录逐一对账反推得出,
// 不是猜。两条都有实物,且都是对抗审查逮出来的真事故:
//  ⚠ 漏掉 `_`:`…/Doc-TTS`(压根不存在)会命中 `…/Doc_TTS` 的记忆 ⇒ 报出**别的项目**的记忆,
//    而真主人(带 `_` 的那个)自己反而永远探不到。两头都坏,且「没有记忆」与「slug 算错了」
//    在清单里长得一模一样。
//  ⚠ 漏掉 realpath:`/tmp/x` 被记成 `-private-tmp-x`(macOS 上 /tmp、/var 都是软链)⇒ workdir
//    填软链路径的群,记忆永远探不到,不出任何声。
// ⚠ Windows 规则**无样本**:这里照同一套算,算错的后果是 stat 不到 ⇒ 返回 null(fail-safe),
//   不会报出错路径 —— 但也等于该平台上这个功能不生效。
function memorySlug(realPath) {
  return String(realPath).replace(/\\/g, '/').replace(/[/_]/g, '-')
}

// 归属的权威源:claude.json 的 `projects` 以**真实绝对路径**为键(本机实测 18 键)。
// ⭐ 用查表替代「猜一条替代路径存不存在」的启发式 —— 一次读文件(实测 98KB / 0.29ms,与同一
// 函数里已有的读 .git/config、读风格档同量级)就把 `_`、`/`、软链三个维度一次覆盖;而启发式
// 只覆盖其中一维的一个位置,还会被一个**跟 claude 毫无关系的普通兄弟目录**误判成歧义
// (旧实现:项目里新建个 demo/ 子目录,整段记忆就静默消失)。
// ⚠ 它权威但**不完备** —— 2026-09-01 实测:18 个带记忆的目录里有 4 个在 claude.json 里没有键
//   认领。所以「没人认领」不算歧义(照报);只有「别人认领了」或「两个键撞同一 slug」才闭嘴。
// ⚠ 读不到权威源时返回 null = 「无归属信息」,按不阻断处理:realpath + `_` 已经消掉了现实中
//   真正发生过的那类错配,而两个键撞同一 slug 实测为 0 次。
// ⚠ 候选路径要先归一 —— cfgDir 带个尾斜杠就会让两个候选双双落空,然后**静默** fail-open。
function claudeJsonPath(cfgDir) {
  const base = path.resolve(String(cfgDir))
  for (const p of [base + '.json', path.join(base, '.claude.json')]) {
    try { if (fs.statSync(p).isFile()) return p } catch { /* 换下一个候选 */ }
  }
  return null
}

function slugOwners(cfgDir, slug) {
  const p = claudeJsonPath(cfgDir)
  if (!p) return null
  try {
    const projects = JSON.parse(fs.readFileSync(p, 'utf8')).projects || {}
    const out = []
    for (const k of Object.keys(projects)) {
      // ⚠ 键**不随目录删除而清理**(实测 18 个键里 6 个是幽灵键)。目录都不在了的键认领不了
      // 任何东西 —— 留着它参与匹配,会让一个早就删掉的老项目**压制住一个活着的项目**的记忆,
      // 而且不出任何声。方向虽是 fail-safe,但这是旧实现没有的新压制面。
      let real
      try { real = fs.realpathSync(k) } catch { continue }
      if (memorySlug(real) === slug) out.push(real)
    }
    return out
  } catch { return null }
}

function probeMemoryDir(workdir, opts = {}) {
  // workdir 必须是**真实存在的目录**,并走 realpath(claude 记的就是 realpath)。
  // 顺带挡掉「控制台把路径填错 / 项目被移走 / 盘没挂上」这一整类 —— 旧实现对一个压根不存在
  // 的 workdir 也能报出一个真实可读的记忆目录。path.resolve 先吃掉尾斜杠、`.`、`..`、重复斜杠。
  let real
  try {
    real = fs.realpathSync(path.resolve(String(workdir)))
    if (!fs.statSync(real).isDirectory()) return null
  } catch { return null }
  const home = opts.home || os.homedir()
  const cfgDir = opts.configDir || (opts.env || process.env).CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  const slug = memorySlug(real)
  const dir = path.join(cfgDir, 'projects', slug, 'memory')
  let names
  try {
    if (!fs.statSync(dir).isDirectory()) return null
    // withFileTypes:名字以 .md 结尾的**子目录**不该被算成一条记忆(真实记忆目录里就有
    // _archive/ 这类子目录)。软链不排除 —— 软链到记忆文件是正当用法。
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name.endsWith('.md') && !e.isDirectory()).map((e) => e.name)
  } catch { return null }
  const index = names.includes('MEMORY.md') ? 'MEMORY.md' : null
  const count = names.length - (index ? 1 : 0)
  // 空目录 / 只剩一份索引 ⇒ 没东西可交接。清单每轮都付 token,不为「这里什么都没有」占篇幅。
  if (count <= 0) return null
  const owners = slugOwners(cfgDir, slug)
  if (owners && (owners.length > 1 || (owners.length === 1 && owners[0] !== real))) return null
  return { dir, count, bucket: countBucket(count), index }
}

// 原始层判据:「这个项目有没有东西可交接」。只服务 probeProjectMemory 自己 —— 保证它返回非 null
// 时一定有东西。⚠ 消费者不该用这一条(它不知道这一轮的权限/runner 够不够得着),消费者用 probeHandover。
function hasHandover(pm) { return !!(pm && (pm.convention.length || pm.memory)) }

/**
 * 探测一个项目目录里「跨会话还留得住的东西」。
 * @returns {{convention: string[], memory: {dir,count,bucket,index}|null}|null}
 *   两样都没有时返回 null —— 探测式:项目里没有这些东西,清单里就一个字都不出现。
 */
function probeProjectMemory(workdir, opts = {}) {
  const wd = workdir && String(workdir).trim()
  if (!wd) return null
  const convention = []
  for (const f of CONVENTION_FILES) {
    try { if (fs.statSync(path.join(wd, f)).isFile()) convention.push(f) } catch { /* 不存在 ⇒ 不点名 */ }
  }
  const out = { convention, memory: probeMemoryDir(wd, opts) }
  return hasHandover(out) ? out : null
}

// ⭐ 换脑时对群成员说的那一句。**控制台切模型与群内 `/model` 都要说它** —— 各写一份必然漂移
// (教训 26/35),故收在这里当唯一来源,经 probeHandover 的 `note` 交给两个消费者。
// ⚠ **只陈述事实(东西还在),不承诺行为**(「它会先读」):读不读是半可信 agent 的判断,编排层
//   保证不了 —— 清单自己都写着「上下文里没有就自己读一遍」。
// ⚠ 用户面零工具名:不提约定文件名、更不提机器上的目录。
const HANDOVER_NOTE = '本项目的长期约定与积累都还在,不必从头交代'

/**
 * ⭐ **消费者唯一入口**:这一轮**实际给得出去**的交接信息。自知清单与切模型通知都调它。
 *
 * 为什么必须收成一个函数(教训 26/35 家族):门控之前两个消费者天然一致,加了门控就多出第三种
 * 状态 ——「探到了东西,但这一轮一条都给不出去」。各写各的判据 ⇒ 控制台在群里说「之前交代过的
 * 都还在」,而清单里一个字都没有、那个目录 agent 还够不着。**注释挡不住复发,得收成一个被调用的
 * 东西**;而落点选哪份、够不够得着,都属于「哪个 runner 会自动加载什么、文件工具被围在哪」
 * 这类**具体 agent 的行为知识**,本就不该写进 core。
 *
 * @param {string} workdir
 * @param {{full?: boolean, isCodex?: boolean}} opts full = 该群完全访问;isCodex = 走 codex runner
 * @returns {{convention: string[], memory: object|null, landing: string|null}|null}
 */
function probeHandover(workdir, opts = {}) {
  const pm = probeProjectMemory(workdir, opts)
  if (!pm) return null
  // 记忆目录在 workdir **之外**,而 claude runner 唯一的 --add-dir 就是 workdir 本身 ⇒ 非完全
  // 访问的 claude 群读不到。指了它读不到的路,只会**亲手教出**「这项目没有记忆」那条错信念
  // (一次失败的交互会在会话里固化成信念,之后它绕开不再试)—— 比从没告诉过它更糟。
  // codex 的 read-only 是只读**文件系统策略**、不是路径牢笼,够得着。
  const memory = pm.memory && (opts.full || opts.isCodex) ? pm.memory : null
  // 落点:两份都在时选它**自己会自动加载**的那一份 —— 让 codex 把交接写进一份它不读的档,等于白写。
  const want = opts.isCodex ? 'AGENTS.md' : 'CLAUDE.md'
  const landing = pm.convention.length ? (pm.convention.find((f) => f === want) || pm.convention[0]) : null
  // 探到了但一条都给不出去 ⇒ 两个消费者一致地闭嘴(清单不留光秃秃的标题,群里也不说那句话)。
  if (!landing && !memory) return null
  return { convention: pm.convention, memory, landing, note: HANDOVER_NOTE }
}

module.exports = { probeHandover, probeProjectMemory, probeMemoryDir, memorySlug, slugOwners, hasHandover, countBucket, CONVENTION_FILES, HANDOVER_NOTE }
