'use strict'
// What the service knows about one conversation right now, read from the
// live bindings and the conversation's own journal. Only facts: the console's
// "say" gate words them as a refusal, and a due scheduled task hands them to
// the core, which decides whether it fires. Reading never changes anything.

function createC2ChatFacts({ getBindings, getConfig, getHeld = () => new Map(), assertWriterLock,
  isServing = () => false, isFrozen = () => false } = {}) {
  for (const hook of [getBindings, getConfig, getHeld, assertWriterLock, isServing, isFrozen]) {
    if (typeof hook !== 'function') throw new TypeError('chat facts need live authority and configuration hooks')
  }
  const bindings = () => {
    const value = getBindings()
    if (!(value instanceof Map)) throw new TypeError('C2 console bindings must be a Map')
    return value
  }
  // The engine's /new guard, read from the same runtime and journal the live
  // view uses: a running, admitted, controlled or queued turn, any receipt of
  // this group's journal not yet settled, or an outbound effect still in
  // flight keeps the current session.
  function groupBusy(chatId, binding) {
    const rt = binding.engine?.rts?.get(chatId)
    const snapshot = binding.journal?.consoleSnapshot?.() || binding.journal?.snapshot()
    return !!(rt?.v2NormalRouteActive || rt?.v2AdmissionPending || rt?.v2Controller ||
      rt?.v2QueueReceiptIds?.length || snapshot?.receipts?.pending?.length ||
      snapshot?.state?.lanes?.queue?.[chatId]?.queue?.length ||
      binding.gate?.blocked || binding.runtime?.blocked)
  }
  //   open              this process holds the writer lock and the service serves
  //   paused / held     the conversation is paused in the configuration / held for a person
  //   upgrading         admission is closed for a service switch
  //   bound             the conversation has an open durable authority
  //   stopping          a stop or skip is settling, or work nobody owns is unsettled
  //   queued            messages waiting behind the running task
  //   admissionPending  the first of them still waits for a model slot
  function read(chatId) {
    let locked = false
    try { locked = assertWriterLock() === true } catch {}
    const open = locked && isServing() === true
    if (!open) {
      return { open: false, paused: false, held: false, upgrading: false, bound: false, stopping: false,
        queued: 0, admissionPending: false }
    }
    const groups = getConfig().groups
    const paused = !!(groups && Object.hasOwn(groups, chatId) && groups[chatId]?.paused)
    const held = getHeld().has(chatId)
    const upgrading = isFrozen() === true
    const binding = bindings().get(chatId)
    const bound = !!binding && binding.runtime?.closed !== true
    if (!bound) return { open, paused, held, upgrading, bound, stopping: false, queued: 0, admissionPending: false }
    const rt = binding.engine?.rts?.get(chatId)
    const snapshot = binding.journal?.consoleSnapshot?.() || binding.journal?.snapshot()
    // A normal active turn may accept ordinary messages. Unowned pending work
    // does not; it must not become a new execution path or bypass recovery.
    const stopping = !!(rt?.v2StopControl || rt?.v2SkipWaiter || snapshot?.state?.lanes?.stopIntent?.[chatId] ||
      !rt?.v2NormalRouteActive && !rt?.v2AdmissionPending && (groupBusy(chatId, binding) || rt?.v2RunningJobs))
    return { open, paused, held, upgrading, bound, stopping,
      queued: snapshot?.state?.lanes?.queue?.[chatId]?.queue?.length || 0,
      admissionPending: !!rt?.v2AdmissionPending }
  }
  // The `chat` object of the core's schedule "due" step (ABI 39: scheduled
  // tasks). A paused or held conversation is still served: the core names
  // those two itself.
  function scheduleChat(chatId) {
    const f = read(chatId)
    return { serving: f.open && (f.bound || f.paused || f.held), paused: f.paused, held: f.held,
      upgrading: f.upgrading, stopping: f.stopping, queued: Math.min(f.queued, 1024),
      admissionPending: f.admissionPending }
  }
  // This conversation's receipt in its journal: 'pending' | 'completed' | null.
  function receiptState(chatId, receiptId) {
    const receipts = bindings().get(chatId)?.journal?.snapshot()?.receipts
    if (receipts?.pending?.some(item => item.id === receiptId)) return 'pending'
    if (receipts?.completed?.some(item => item.id === receiptId)) return 'completed'
    return null
  }
  return { read, scheduleChat, receiptState, groupBusy, bindings }
}

module.exports = { createC2ChatFacts }
