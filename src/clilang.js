// 命令行输出语言(安装向导、服务安装这些新用户第一眼看到的输出;其余命令仍是中文)。
// 判据与 install.sh 的 detect_lang 一致:SINTBOT_LANG=zh|en 优先;否则 locale(LC_ALL / LC_MESSAGES / LANG)
// 或 macOS 系统语言(AppleLanguages 第一项)有一处是中文就用中文,其余英文。
// 为什么看系统语言:不少人在 ~/.zshenv 里写死 LANG=en_US.UTF-8(工具链兼容),界面却是中文 ——
// 1.0.11 实装时安装脚本因此出英文、向导是中文,同一屏两种语言。
const { spawnSync } = require('node:child_process')

let macCache
function macLanguage({ platform = process.platform, run = spawnSync } = {}) {
  if (platform !== 'darwin') return ''
  if (macCache !== undefined) return macCache
  try {
    const r = run('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 2000 })
    const m = String((r && r.stdout) || '').match(/"?([A-Za-z]{2,3})[-_A-Za-z]*"?/)
    macCache = m ? m[1].toLowerCase() : ''
  } catch { macCache = '' }
  return macCache
}

function cliLang({ env = process.env, platform = process.platform, run } = {}) {
  const forced = String(env.SINTBOT_LANG || '').toLowerCase()
  if (forced === 'zh' || forced === 'en') return forced
  const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || ''
  if (/^zh/i.test(locale)) return 'zh'
  return macLanguage({ platform, run }) === 'zh' ? 'zh' : 'en'
}

// tr('中文', 'English') —— 按当前语言取一句
const tr = (zh, en, lang = cliLang()) => (lang === 'zh' ? zh : en)

module.exports = { cliLang, tr, _resetCache: () => { macCache = undefined } }
