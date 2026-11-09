// 版本升级群播报:发版部署重启后,各绑定群收到一条版本更新消息(此前升级群内无感)。
// daemon 启动时对比 state 里记录的上个版本号,变了就用 CHANGELOG.json(与控制台
// 「版本历史」同一事实源)的新增条目拼文案。纯函数,bin/sbot.js 接线;零依赖。

// 产品在群成员面前的名字;顶层 `brand` 配置覆盖。⚠ 改默认值 = 替所有没配 `brand` 的部署改名。
const DEFAULT_BRAND = 'SintBot'

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
// 条目只列标题(t),详情引导去控制台「版本历史」,群消息保持一屏内。
function upgradeSpan(lastVersion, currentVersion, changelog = []) {
  if (!lastVersion || !currentVersion) return null
  if (cmpVersion(currentVersion, lastVersion) <= 0) return null
  return (Array.isArray(changelog) ? changelog : []).filter((e) =>
    e && cmpVersion(e.version, lastVersion) > 0 && cmpVersion(e.version, currentVersion) <= 0)
}

function buildUpgradeNotice(lastVersion, currentVersion, changelog = [], brand = DEFAULT_BRAND) {
  const span = upgradeSpan(lastVersion, currentVersion, changelog)
  if (!span) return null
  const L = [`🚀 ${brand || DEFAULT_BRAND} 已升级:v${lastVersion} → v${currentVersion}`]
  for (const e of span) {
    L.push(`【v${e.version}${e.name ? ' · ' + e.name : ''}】`)
    for (const it of e.items || []) if (it && it.t) L.push(`· ${it.t}`)
  }
  L.push('详情见控制台「设置 → 版本历史」')
  return L.join('\n')
}

function buildUpgradeNoticeParts(lastVersion, currentVersion, changelog = [], brand = DEFAULT_BRAND) {
  const span = upgradeSpan(lastVersion, currentVersion, changelog)
  if (!span) return null
  const one = span.length === 1 ? span[0] : null
  const body = span.map((e) => [
    `**v${e.version}${e.name ? ' · ' + e.name : ''}**`,
    ...(e.items || []).filter((it) => it && it.t).map((it) => `· ${it.t}`),
  ].join('\n')).join('\n\n')
  return {
    tone: 'upgrade',
    title: `${brand || DEFAULT_BRAND} 已升级到 v${currentVersion}`,
    subtitle: `v${lastVersion} → v${currentVersion}` +
      (one && one.name ? ` · ${one.name}` : (span.length > 1 ? ` · 共 ${span.length} 个版本` : '')),
    body,
    footer: '详情见控制台「设置 → 版本历史」',
  }
}

module.exports = { cmpVersion, upgradeSpan, buildUpgradeNotice, buildUpgradeNoticeParts, DEFAULT_BRAND }
