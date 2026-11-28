'use strict'

// What this machine has left, as read: the free space on the volume holding
// the data directory, and the system's own memory figures. Facts only: what
// the console shows for them, and when it warns, is the built-in core's.
const fs = require('node:fs')
const os = require('node:os')
const { execFile } = require('node:child_process')

const SYSCTL = '/usr/sbin/sysctl'
// The share of memory the system counts as available, and its pressure level.
const MEMORY_LEVEL = 'kern.memorystatus_level'
const MEMORY_PRESSURE = 'kern.memorystatus_vm_pressure_level'
const READ_TIMEOUT_MS = 2_000

async function diskFacts(dir, { statfs = fs.promises.statfs } = {}) {
  try {
    const stat = await statfs(dir)
    const totalBytes = Number(stat.blocks) * Number(stat.bsize)
    const freeBytes = Number(stat.bavail) * Number(stat.bsize)
    if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes) || totalBytes <= 0 || freeBytes < 0 || freeBytes > totalBytes) return null
    return { freeBytes, totalBytes }
  } catch { return null }
}

// `sysctl a b` prints "name: value" per line and still prints the names it
// knows when another is unknown, so the output is read whatever the exit code.
function readSysctl(names, { exec = execFile } = {}) {
  return new Promise(resolve => {
    try {
      exec(SYSCTL, names, { timeout: READ_TIMEOUT_MS, encoding: 'utf8' }, (_error, stdout) => {
        const values = {}
        for (const line of String(stdout || '').split('\n')) {
          const at = line.indexOf(':')
          if (at > 0) values[line.slice(0, at).trim()] = line.slice(at + 1).trim()
        }
        resolve(values)
      })
    } catch { resolve({}) }
  })
}

const wholeNumber = text => /^\d+$/.test(String(text ?? '')) ? Number(text) : null

async function memoryFacts({ platform = process.platform, totalmem = os.totalmem, exec = execFile } = {}) {
  let totalBytes = 0
  try { totalBytes = Number(totalmem()) } catch { return null }
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null
  if (platform !== 'darwin') return { totalBytes, availablePercent: null, pressure: null }
  const values = await readSysctl([MEMORY_LEVEL, MEMORY_PRESSURE], { exec })
  const level = wholeNumber(values[MEMORY_LEVEL])
  const pressure = wholeNumber(values[MEMORY_PRESSURE])
  return { totalBytes,
    availablePercent: level !== null && level <= 100 ? level : null,
    pressure: [1, 2, 4].includes(pressure) ? pressure : null }
}

// `dir` is the data directory: its volume is the one whose space matters to
// the service (journals, releases, the tools it installs).
async function readMachineFacts({ dir, statfs, platform, totalmem, exec } = {}) {
  const [disk, memory] = await Promise.all([
    dir ? diskFacts(dir, { statfs }) : null,
    memoryFacts({ platform, totalmem, exec }),
  ])
  return { disk, memory }
}

module.exports = { readMachineFacts, diskFacts, memoryFacts }
