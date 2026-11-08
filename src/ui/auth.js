// 控制台访问密码:scrypt 哈希 + 常量时间校验(零依赖)。
//
// 精简口径(局域网访问加固):控制台默认绑 loopback 免密;一旦对外(--host
// 非环回)就要求登录。密码只干一件事 —— 换取一个本进程 session token,其余鉴权管线原样
// 复用(token 放 x-sbot-token 头,天然免 CSRF)。密码永不明文落盘,存成 `scrypt$salt$hash`。

const crypto = require('node:crypto')

const KEYLEN = 32 // 派生密钥字节数

// 明文密码 → `scrypt$<saltHex>$<hashHex>`(salt 随机,每次不同)
function hashPassword(pw) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(String(pw), salt, KEYLEN)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

// 明文密码 vs 存储串;格式不符 / 长度不符 / 派生失败 → false(绝不抛)。timingSafeEqual 防计时侧信道。
function verifyPassword(pw, stored) {
  if (typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  let expected
  try { expected = Buffer.from(parts[1] && parts[2] ? parts[2] : '', 'hex') } catch { return false }
  if (expected.length !== KEYLEN) return false
  let hash
  try { hash = crypto.scryptSync(String(pw), Buffer.from(parts[1], 'hex'), KEYLEN) } catch { return false }
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected)
}

module.exports = { hashPassword, verifyPassword }
