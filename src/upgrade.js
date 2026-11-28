// 版本升级群播报:发版部署重启后,各绑定群收到一条版本更新消息(此前升级群内无感)。
// daemon 启动时对比 state 里记录的上个版本号,变了就用 CHANGELOG.json(与官网更新记录
// 同一事实源)的新增条目拼文案。纯函数,bin/sbot.js 接线;零依赖。

// 产品在群成员面前的名字;顶层 `brand` 配置覆盖。⚠ 改默认值 = 替所有没配 `brand` 的部署改名。
const DEFAULT_BRAND = 'SintBot'

// 详情引导:每版的更新记录在官网(1.4.30 起控制台不再带版本历史正文),中文 /zh/changelog/、英文 /changelog/,
// 每版一节,锚点 #v<版本>。播报指向当前版本那一节。
const changelogUrl = (version, en) => `https://sintbot.com/${en ? '' : 'zh/'}changelog/#v${version}`
const changelogLine = (version, en) => (en ? 'Release notes: ' : '更新记录：') + changelogUrl(version, en)

// "0.3.10" vs "0.3.9" 逐段数值比较(字符串比较会把 .10 排在 .9 前);非法段按 0。
function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

// 升级播报文案;无需播报返回 null:首次运行(无基线,播了像误报)/ 版本没变 / 降级(回滚
// 不宣传)。列出 (last, current] 区间的全部版本条目 —— 跨多版升级不漏说,新版在前;
// 条目只列标题(t),详情引导去官网的更新记录,群消息保持一屏内。
function upgradeSpan(lastVersion, currentVersion, changelog = []) {
  if (!lastVersion || !currentVersion) return null
  if (cmpVersion(currentVersion, lastVersion) <= 0) return null
  return (Array.isArray(changelog) ? changelog : []).filter((e) =>
    e && cmpVersion(e.version, lastVersion) > 0 && cmpVersion(e.version, currentVersion) <= 0)
}

function buildUpgradeNotice(lastVersion, currentVersion, changelog = [], brand = DEFAULT_BRAND) {
  const span = upgradeSpan(lastVersion, currentVersion, changelog)
  if (!span) return null
  const L = [`✓ ${brand || DEFAULT_BRAND} 已升级:v${lastVersion} → v${currentVersion}`]
  for (const e of span) {
    L.push(`【v${e.version}${e.name ? ' · ' + e.name : ''}】`)
    for (const it of e.items || []) if (it && it.t) L.push(`· ${it.t}`)
  }
  L.push(changelogLine(currentVersion, false))
  return L.join('\n')
}

// `lang: 'en'` = the notice for an English conversation. Which versions are listed still comes from
// `changelog` (CHANGELOG.json, the single source); their names and items come from `changelogEn`
// (CHANGELOG.en.json, matched by version). A version without an English entry is listed by its
// number alone: an English conversation gets no Chinese line.
function buildUpgradeNoticeParts(lastVersion, currentVersion, changelog = [], brand = DEFAULT_BRAND, { lang = 'zh', changelogEn = [] } = {}) {
  let span = upgradeSpan(lastVersion, currentVersion, changelog)
  if (!span) return null
  const en = lang === 'en'
  if (en) {
    const english = new Map((Array.isArray(changelogEn) ? changelogEn : []).filter((e) => e && e.version).map((e) => [String(e.version), e]))
    span = span.map((e) => english.get(String(e.version)) || { version: e.version })
  }
  const one = span.length === 1 ? span[0] : null
  const body = span.map((e) => [
    `**v${e.version}${e.name ? ' · ' + e.name : ''}**`,
    ...(e.items || []).filter((it) => it && it.t).map((it) => `· ${it.t}`),
  ].join('\n')).join('\n\n')
  if (en) {
    return {
      tone: 'upgrade',
      label: 'Upgrade',
      title: `${brand || DEFAULT_BRAND} upgraded to v${currentVersion}`,
      subtitle: `v${lastVersion} → v${currentVersion}` +
        (one && one.name ? ` · ${one.name}` : (span.length > 1 ? ` · ${span.length} versions` : '')),
      body,
      footer: changelogLine(currentVersion, true),
    }
  }
  return {
    tone: 'upgrade',
    title: `${brand || DEFAULT_BRAND} 已升级到 v${currentVersion}`,
    subtitle: `v${lastVersion} → v${currentVersion}` +
      (one && one.name ? ` · ${one.name}` : (span.length > 1 ? ` · 共 ${span.length} 个版本` : '')),
    body,
    footer: changelogLine(currentVersion, false),
  }
}

module.exports = { cmpVersion, upgradeSpan, buildUpgradeNotice, buildUpgradeNoticeParts, DEFAULT_BRAND }
