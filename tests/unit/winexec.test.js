// locateBin(src/agent/winexec.js):配置钉死的绝对路径指空时找同一个程序的另一份。
// 典型情况:CLI 自更新把 claude 装进 nvm 前缀、homebrew 那份被清掉,配置钉的路径指空 ⇒ 每轮都失败,而新版就在 ~/.nvm/…/bin。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { locateBin, resolveSpawn } = require('../../src/agent/winexec')

// 临时 HOME + 临时 PATH 把候选位置全圈在沙箱里,测完还原 —— 别让本机真实安装影响判定
function withSandbox(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbot-locate-'))
  const home = path.join(root, 'home'), pathDir = path.join(root, 'pathbin')
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(pathDir, { recursive: true })
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, USERPROFILE: process.env.USERPROFILE }
  const homedir = os.homedir
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.PATH = pathDir
  os.homedir = () => home // os.homedir 优先读 $HOME,但有的平台不读;直接钉死最稳
  try { return fn({ root, home, pathDir }) } finally {
    os.homedir = homedir
    for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v }
    fs.rmSync(root, { recursive: true, force: true })
  }
}
const touch = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '#!/bin/sh\n') }

test('locateBin: 配置路径在 ⇒ 原样返回、fallback 空;裸名字不管(交给 PATH);路径不在且哪儿都没有 ⇒ 原样返回让 ENOENT 照常冒出来', () => withSandbox(({ root, pathDir }) => {
  const cfgBin = path.join(root, 'prefix', 'bin', 'claude')
  touch(cfgBin)
  assert.deepEqual(locateBin(cfgBin), { bin: cfgBin, fallback: null })
  assert.deepEqual(locateBin('claude'), { bin: 'claude', fallback: null })
  fs.rmSync(cfgBin)
  assert.deepEqual(locateBin(cfgBin, { fixedDirs: [] }), { bin: cfgBin, fallback: null }, "没有候选时不能瞎指一个")
  assert.deepEqual(locateBin(''), { bin: '', fallback: null })
  void pathDir
}))

test('locateBin: 配置路径不在 ⇒ 依次找 PATH · ~/.local/bin · nvm 各版本(新到旧);找到的那份随 resolveSpawn 进 spawn', () => withSandbox(({ root, home, pathDir }) => {
  const cfgBin = path.join(root, 'gone', 'bin', 'claude') // 形状:homebrew 那份被清掉
  // nvm 两个版本都有:要挑新的那套
  const nvmOld = path.join(home, '.nvm', 'versions', 'node', 'v20.1.0', 'bin', 'claude')
  const nvmNew = path.join(home, '.nvm', 'versions', 'node', 'v22.22.2', 'bin', 'claude')
  touch(nvmOld); touch(nvmNew)
  assert.deepEqual(locateBin(cfgBin, { fixedDirs: [] }), { bin: nvmNew, fallback: nvmNew })
  // 原生安装器那份优先于 nvm
  const local = path.join(home, '.local', 'bin', 'claude'); touch(local)
  assert.equal(locateBin(cfgBin, { fixedDirs: [] }).bin, local)
  // PATH 上的优先于一切
  const onPath = path.join(pathDir, 'claude'); touch(onPath)
  assert.equal(locateBin(cfgBin, { fixedDirs: [] }).bin, onPath)
  // 同名不同程序互不串:配置的是 codex,找的也只能是 codex
  assert.equal(locateBin(path.join(root, "gone", "bin", "zzz-no-such-agent"), { fixedDirs: [] }).fallback, null)
  // resolveSpawn 带出 fallback,runner 据此记日志;POSIX 下 file 就是兜底那份
  if (process.platform !== 'win32') {
    const r = resolveSpawn(cfgBin, ['--version'])
    assert.equal(r.file, onPath); assert.equal(r.fallback, onPath); assert.deepEqual(r.spawnArgs, ['--version'])
    assert.equal(resolveSpawn(onPath, []).fallback, null, '对照组:路径本来就在,不算兜底')
  }
}))
