'use strict'

// Detached switch process started by the console upgrade. It runs outside the
// service's process group, so stopping the launchd job does not stop it. The
// steps are those of the deploy scripts: stop the job, wait for the writer
// lock, prove the journals unchanged, back up data and plist, preflight the
// new entry with the job's environment, replace only the entry in the plist,
// start the job and wait for every group to connect. Any failure restores the
// original plist bytes and restarts the previous version.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const { isDeepStrictEqual } = require('node:util')
const { atomicWriteJSON } = require('./core/store')
const { journalHashes, readPlist } = require('./c2updater')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function defaultSystem() {
  const uid = process.getuid()
  const run = (file, args, options = {}) => spawnSync(file, args, { encoding: 'utf8', timeout: 60_000, ...options })
  return {
    bootout: label => run('/bin/launchctl', ['bootout', `gui/${uid}/${label}`]),
    bootstrap: plist => run('/bin/launchctl', ['bootstrap', `gui/${uid}`, plist]),
    jobPid: label => {
      const out = run('/bin/launchctl', ['print', `gui/${uid}/${label}`])
      if (out.status !== 0) return null
      const match = /^\s*pid = (\d+)\s*$/m.exec(out.stdout || '')
      return match ? Number(match[1]) : 0
    },
    alive: pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } },
    readPlist: file => readPlist(file),
    writePlist: (file, value) => {
      const json = `${file}.upgrade.json`, tmp = `${file}.upgrade.tmp`
      fs.writeFileSync(json, JSON.stringify(value), { mode: 0o600 })
      try {
        execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', tmp, json], { timeout: 10_000 })
        fs.chmodSync(tmp, 0o600)
        execFileSync('/usr/bin/plutil', ['-lint', tmp], { timeout: 10_000, stdio: 'ignore' })
        fs.renameSync(tmp, file)
      } finally { fs.rmSync(json, { force: true }); fs.rmSync(tmp, { force: true }) }
    },
    backupData: (dataDir, file) => {
      const base = path.basename(dataDir)
      const out = run('/usr/bin/tar', ['-czf', file, '--exclude', `${base}/upgrades`, '-C', path.dirname(dataDir), base])
      if (out.status !== 0) throw new Error(`data backup failed: ${(out.stderr || '').trim().slice(0, 200)}`)
      fs.chmodSync(file, 0o600)
    },
    preflight: (spec, entry) => {
      const env = { HOME: process.env.HOME, USER: process.env.USER, ...(spec.EnvironmentVariables || {}) }
      const args = [entry, ...spec.ProgramArguments.slice(2), '--preflight']
      return run(spec.ProgramArguments[0], args, { env, cwd: '/', timeout: 180_000 })
    },
    logSize: file => { try { return fs.statSync(file).size } catch { return 0 } },
    logSince: (file, offset) => {
      try {
        const fd = fs.openSync(file, 'r')
        try {
          const size = fs.fstatSync(fd).size
          if (size <= offset) return ''
          const buffer = Buffer.alloc(Math.min(size - offset, 4 * 1024 * 1024))
          fs.readSync(fd, buffer, 0, buffer.length, offset)
          return buffer.toString('utf8')
        } finally { fs.closeSync(fd) }
      } catch { return '' }
    },
  }
}

async function runUpgradeSwitch({ stateFile, system = defaultSystem(), hashJournals = journalHashes,
  now = Date.now, wait = sleep, stopTimeoutMs = 60_000, connectTimeoutMs = 90_000, pollMs = 500 } = {}) {
  const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const state = read()
  const job = state.job
  if (job?.state !== 'switching' || typeof job.label !== 'string' || typeof job.plist !== 'string' ||
      typeof job.oldEntry !== 'string' || typeof job.newEntry !== 'string' ||
      typeof job.dataDir !== 'string' || typeof job.backupDir !== 'string') {
    throw new Error('No switching upgrade job to run')
  }
  const steps = []
  const write = (patch, message) => {
    const latest = read()
    if (latest.job?.id !== job.id) throw new Error('The upgrade job changed during the switch')
    latest.job = { ...latest.job, ...patch, ...(message ? { message } : {}), steps: [...steps], updatedAt: now() }
    atomicWriteJSON(stateFile, latest, { mode: 0o600 })
    return latest.job
  }
  const step = (name, ok = true, detail = '') => {
    steps.push({ at: now(), step: name, ok, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) })
    try { write({}) } catch {}
  }
  const lockFile = path.join(job.dataDir, 'daemon.lock')
  const until = async (predicate, ms) => {
    const end = now() + ms
    while (now() < end) { if (await predicate()) return true; await wait(pollMs) }
    return !!(await predicate())
  }
  const stopped = () => until(() => {
    const pid = system.jobPid(job.label)
    return (pid === null || pid === 0) && !system.alive(job.servicePid) && !fs.existsSync(lockFile)
  }, stopTimeoutMs)
  const connected = (offset, expectDone) => until(() => {
    const text = system.logSince(job.logFile, offset)
    if (/ held \(|multi-group failure|startup cleanup was not confirmed/.test(text)) return false
    if (job.expectedGroups > 0 &&
        text.includes(`SintBot Feishu ingress connected for ${job.expectedGroups} groups`)) return true
    try { return expectDone && read().job?.state === 'done' } catch { return false }
  }, connectTimeoutMs)

  fs.mkdirSync(job.backupDir, { recursive: true, mode: 0o700 })
  const original = fs.readFileSync(job.plist)
  fs.writeFileSync(path.join(job.backupDir, 'service.plist'), original, { mode: 0o600 })
  const spec = system.readPlist(job.plist)
  if (spec.Label !== job.label || spec.ProgramArguments?.[1] !== job.oldEntry) {
    write({ state: 'failed' }, '服务配置和发起升级时不一致，没有切换')
    return 'failed'
  }

  // Restore the exact original plist and start the previous version.
  async function rollback(reason) {
    step('rollback', true, reason)
    system.bootout(job.label)
    await stopped()
    fs.writeFileSync(job.plist, original, { mode: 0o600 })
    const offset = system.logSize(job.logFile)
    const started = system.bootstrap(job.plist)
    const back = started.status === 0 && await connected(offset, false)
    step('previous version started', back)
    write({ state: back ? 'rolled-back' : 'failed', finishedAt: now() }, back
      ? `没有切换到 v${job.to}：${reason}；已换回 v${job.from}`
      : `没有切换到 v${job.to}：${reason}；换回 v${job.from} 后服务没有连上，请手动检查`)
    return back ? 'rolled-back' : 'failed'
  }

  const out = system.bootout(job.label)
  step('stop service', out.status === 0, out.stderr)
  if (!await stopped()) return rollback('旧服务没有在规定时间内停止')
  if (!isDeepStrictEqual(hashJournals(job.dataDir), job.journals)) {
    // A journal changed after the idle check: never switch on top of it.
    return rollback('停止过程中群记录发生了变化')
  }
  step('journals unchanged')
  try { system.backupData(job.dataDir, path.join(job.backupDir, 'data.tgz')); step('data backed up') }
  catch (error) { return rollback(error.message) }
  const check = system.preflight(spec, job.newEntry)
  step('new version preflight', check.status === 0, (check.stderr || '').trim().split('\n').pop())
  if (check.status !== 0) return rollback('新版本预检没有通过')
  const next = { ...spec, ProgramArguments: [...spec.ProgramArguments] }
  next.ProgramArguments[1] = job.newEntry
  try {
    system.writePlist(job.plist, next)
    const written = system.readPlist(job.plist)
    const expected = { ...spec, ProgramArguments: next.ProgramArguments }
    if (!isDeepStrictEqual(written, expected)) throw new Error('rewritten service configuration differs')
    step('service entry replaced')
  } catch (error) { return rollback(error.message) }
  const offset = system.logSize(job.logFile)
  const started = system.bootstrap(job.plist)
  step('start new version', started.status === 0, started.stderr)
  if (started.status !== 0 || !await connected(offset, true)) {
    return rollback(`新版本启动后没有在 ${Math.round(connectTimeoutMs / 1000)} 秒内连上全部群`)
  }
  const latest = read().job
  if (latest?.state !== 'done') write({ state: 'done', finishedAt: now() }, `已升级到 v${job.to}`)
  else write({})
  return 'done'
}

module.exports = { runUpgradeSwitch, defaultSystem }
