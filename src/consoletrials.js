'use strict'

// One bounded console trial, sharing the real model capacity. A timeout or
// lease loss asks the runner to stop; only its close proof releases capacity.
function createConsoleTrials({ getCapacity, acquireCapacity, assertWriterLock, isServing, isFrozen }) {
  let active = false
  function assertWritable() {
    if (assertWriterLock() !== true) throw new Error('服务写入权限已失效，试运行结果未保存')
  }
  function assertAdmission() {
    assertWritable()
    if (!isServing() || isFrozen()) throw new Error('服务未就绪或正在维护，暂不能试运行')
  }
  async function begin(controller) {
    assertAdmission()
    const capacity = getCapacity()
    if (active || capacity.closed || capacity.active + capacity.waiting >= capacity.maxConcurrent) {
      throw new Error('试运行或模型并发名额已满，请稍后重试')
    }
    if (typeof acquireCapacity !== 'function') throw new Error('当前服务未接入试运行并发准入')
    active = true
    let release
    try {
      release = await acquireCapacity({ signal: controller.signal })
      assertAdmission()
    } catch (error) { active = false; release?.(); throw error }
    let finished = false
    const monitor = setInterval(() => {
      try { assertAdmission() } catch (error) { controller.abort(error) }
    }, 100)
    monitor.unref?.()
    return { assertWritable,
      finish(closed) {
        if (finished) return
        finished = true; clearInterval(monitor)
        // Unknown closure keeps the shared slot occupied and blocks upgrades.
        if (closed) { active = false; release() }
      },
    }
  }
  return { begin, active: () => active }
}
module.exports = { createConsoleTrials }
