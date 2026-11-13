'use strict'

// Process-local counterpart of the durable queue lane. The journal contains
// receipt-backed IDs and flags only; message bodies, reply contexts, platform
// objects and group configuration live here until dispatch or interruption.
const RECEIPT_ID = /^[0-9a-f]{32}$/
const MAX_HANDLES = 1024
const { taskId } = require('./enginecheckpoint')

function receiptId(value) {
  if (typeof value !== 'string' || !RECEIPT_ID.test(value)) {
    throw new TypeError('C2 payload receipt ID invalid')
  }
  return value
}

function authority(journal) {
  if (!journal || typeof journal.snapshot !== 'function' ||
      typeof journal.noticeStatus !== 'function') {
    throw new TypeError('C2 payload handles need durable journal')
  }
  const snapshot = journal.snapshot()
  if (!snapshot || !snapshot.state || snapshot.state.version !== 2 ||
      !snapshot.receipts || !Array.isArray(snapshot.receipts.pending) ||
      !Array.isArray(snapshot.receipts.completed)) {
    throw new Error('C2 payload authority invalid')
  }
  return snapshot
}

function pending(snapshot, id) {
  return snapshot.receipts.pending.find(item => item.id === id) || null
}

function queued(snapshot, id, chatId) {
  return (snapshot.state.lanes.queue?.[chatId]?.queue || [])
    .some(item => item.id === `receipt:job:${id}`)
}

function handedOff(snapshot, id, chatId) {
  const lane = snapshot.state.lanes.handoff?.[chatId]
  return lane?.phase === 'handoff' && lane.nextJobId === id
}

class C2PayloadHandles {
  #journal
  #jobs = new Map()
  #blocked
  #capacity

  constructor({ journal, capacity = MAX_HANDLES } = {}) {
    const snapshot = authority(journal)
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_HANDLES) {
      throw new TypeError('C2 payload capacity invalid')
    }
    this.#journal = journal
    this.#capacity = capacity
    // A newly created registry cannot prove ownership of preexisting queued
    // bodies or callback handles. Recovery must settle them before reopening.
    this.#blocked = snapshot.cursor !== 0 || snapshot.receipts.pending.length > 0 ||
      Object.keys(snapshot.state.lanes).length > 0
  }

  get blocked() { return this.#blocked || this.#journal.blocked === true }
  get size() { return this.#jobs.size }

  snapshot() {
    return { blocked: this.blocked, capacity: this.#capacity,
      receiptIds: [...this.#jobs.keys()] }
  }

  preflight(receipt, job) {
    if (this.blocked) throw new Error('C2 payload handles closed pending startup recovery')
    const id = receiptId(receipt?.id)
    if (receipt.source !== 'message' || receipt.id !== taskId(receipt) ||
        typeof receipt.chatId !== 'string' || !receipt.chatId ||
        typeof receipt.sourceId !== 'string' || !/^om_[A-Za-z0-9_-]{1,124}$/.test(receipt.sourceId) ||
        typeof receipt.quiet !== 'boolean' ||
        !job || typeof job !== 'object' || !job.msg || typeof job.msg !== 'object' ||
        !job.platform || typeof job.platform !== 'object' ||
        job.msg._c2ReceiptId !== id || job.msg.chatId !== receipt.chatId ||
        (job.msg.receiptSourceId || job.msg.msgId) !== receipt.sourceId ||
        !!job.msg.quiet !== receipt.quiet) {
      throw new Error('C2 payload does not match candidate source receipt')
    }
    if (this.#jobs.has(id)) throw new Error('C2 payload receipt already attached')
    if (this.#jobs.size >= this.#capacity) throw new RangeError('C2 payload capacity exceeded')
    return id
  }

  attach(id, job) {
    receiptId(id)
    if (this.blocked) throw new Error('C2 payload handles closed pending startup recovery')
    const snapshot = authority(this.#journal)
    const receipt = pending(snapshot, id)
    if (!receipt || receipt.source !== 'message' ||
        !queued(snapshot, id, receipt.chatId) || this.#journal.noticeStatus(id) !== null) {
      throw new Error('C2 payload has no matching accepted queue receipt')
    }
    if (!job || typeof job !== 'object' || !job.msg || typeof job.msg !== 'object' ||
        !job.platform || typeof job.platform !== 'object' ||
        job.msg._c2ReceiptId !== id || job.msg.chatId !== receipt.chatId ||
        (job.msg.receiptSourceId || job.msg.msgId) !== receipt.sourceId) {
      throw new Error('C2 payload does not match durable source receipt')
    }
    if (this.#jobs.has(id)) throw new Error('C2 payload receipt already attached')
    if (this.#jobs.size >= this.#capacity) throw new RangeError('C2 payload capacity exceeded')
    this.#jobs.set(id, job)
    return id
  }

  requireQueued(id) {
    receiptId(id)
    if (this.blocked) throw new Error('C2 payload handles closed pending startup recovery')
    const snapshot = authority(this.#journal)
    const receipt = pending(snapshot, id)
    const job = this.#jobs.get(id)
    if (!receipt || !queued(snapshot, id, receipt.chatId) || !job) {
      throw new Error('C2 queued payload handle missing')
    }
    return job
  }

  takeSteer(id, chatId, effectId) {
    const snapshot = authority(this.#journal)
    const entry = snapshot.state.lanes.steer?.[chatId]?.entries.find(item => item.receiptId === id)
    const receipt = pending(snapshot, id)
    const job = this.#jobs.get(id)
    if (this.blocked || !job || receipt?.chatId !== chatId || entry?.effectId !== effectId ||
        entry.status !== 'pending' || queued(snapshot, id, chatId)) throw new Error('steer payload authority invalid')
    this.#jobs.delete(id)
    return job
  }

  takeHandoff(id) {
    receiptId(id)
    if (this.blocked) throw new Error('C2 payload handles closed pending startup recovery')
    const snapshot = authority(this.#journal)
    const receipt = pending(snapshot, id)
    const job = this.#jobs.get(id)
    if (!receipt || !handedOff(snapshot, id, receipt.chatId) || !job) {
      throw new Error('C2 handoff payload handle missing or unauthorized')
    }
    this.#jobs.delete(id)
    return job
  }

  // Inspect the successor before the durable begin transition. The handle
  // stays owned by this registry until that transition is fsynced.
  peekHandoff(id) {
    receiptId(id)
    if (this.blocked) throw new Error('C2 payload handles closed pending startup recovery')
    const snapshot = authority(this.#journal)
    const receipt = pending(snapshot, id)
    const job = this.#jobs.get(id)
    if (!receipt || !handedOff(snapshot, id, receipt.chatId) || !job ||
        job.msg?._c2ReceiptId !== id || job.msg.chatId !== receipt.chatId ||
        (job.msg.receiptSourceId || job.msg.msgId) !== receipt.sourceId ||
        this.#journal.noticeStatus(id) !== null) {
      throw new Error('C2 handoff payload handle missing or unauthorized')
    }
    return job
  }

  // Consume only after the exact atomic dispatch event is on disk. Validate
  // every member before deleting any handle, so a partial/mismatched batch
  // cannot lose its in-memory payload while the journal still owns a receipt.
  consumeCommittedDispatch({ eventId, turnToken, receiptIds } = {}) {
    if (this.blocked) throw new Error('C2 payload handles closed pending startup recovery')
    if (typeof eventId !== 'string' || !eventId ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
        !Array.isArray(receiptIds) || receiptIds.length === 0 ||
        receiptIds.length > this.#capacity || new Set(receiptIds).size !== receiptIds.length) {
      throw new TypeError('C2 committed dispatch identity invalid')
    }
    const snapshot = authority(this.#journal)
    if (snapshot.state.lastEventId !== eventId || snapshot.cursor !== snapshot.state.seq) {
      throw new Error('C2 dispatch event is not the latest durable commit')
    }
    const jobs = []
    let chatId = null
    for (const id of receiptIds) {
      receiptId(id)
      const receipt = pending(snapshot, id)
      const job = this.#jobs.get(id)
      if (!receipt || !job || this.#journal.noticeStatus(id) !== null ||
          job.msg?._c2ReceiptId !== id || job.msg.chatId !== receipt.chatId ||
          (job.msg.receiptSourceId || job.msg.msgId) !== receipt.sourceId ||
          queued(snapshot, id, receipt.chatId)) {
        throw new Error('C2 committed dispatch payload differs from receipt')
      }
      if (chatId !== null && chatId !== receipt.chatId) {
        throw new Error('C2 committed dispatch crosses groups')
      }
      chatId = receipt.chatId
      jobs.push(job)
    }
    const handoff = snapshot.state.lanes.handoff?.[chatId]
    const turn = snapshot.state.lanes.turn?.[chatId]
    if (handoff?.phase !== 'running' || handoff.turnToken !== turnToken ||
        turn?.active !== turnToken ||
        handoff.acceptedReceiptIds?.length !== (receiptIds.length > 1
          ? receiptIds.length : 0) ||
        receiptIds.length > 1 && receiptIds.some((id, index) =>
          handoff.acceptedReceiptIds[index] !== id)) {
      throw new Error('C2 committed dispatch lacks active durable turn')
    }
    for (const id of receiptIds) this.#jobs.delete(id)
    return jobs
  }

  dropConfirmed(id) {
    receiptId(id)
    const snapshot = authority(this.#journal)
    const completed = snapshot.receipts.completed.some(item => item.id === id)
    const status = this.#journal.noticeStatus(id)
    if (!completed || !['acked', 'quiet-settled'].includes(status)) {
      throw new Error('C2 payload interruption is not durably confirmed')
    }
    return this.#jobs.delete(id)
  }

  // A platform recall has no notification to ACK. The queue removal and quiet
  // receipt completion must already be one durable transition before the raw
  // message handle can be forgotten. A stale or different event never grants
  // permission to discard another queued payload.
  dropDurablyCancelled(id, eventId, control) {
    receiptId(id)
    if (this.blocked || !['recall', 'stop'].includes(control) ||
        eventId !== `sbot-c2-queue-drop-v1:${id}:${control}` ||
        !this.#journal.hasEvent(eventId)) {
      throw new Error('C2 recalled payload lacks durable event')
    }
    const snapshot = authority(this.#journal)
    if (snapshot.state.lastEventId !== eventId ||
        !snapshot.receipts.completed.some(item => item.id === id) ||
        snapshot.receipts.pending.some(item => item.id === id) ||
        Object.values(snapshot.state.lanes.queue || {}).some(lane =>
          lane.queue.some(item => item.id === `receipt:job:${id}`)) ||
        !this.#jobs.has(id)) {
      throw new Error('C2 recalled payload still has live queue authority')
    }
    this.#jobs.delete(id)
    return true
  }

  // A visible stop drops every queued body only after the single durable
  // stop-all transition settled those exact queued receipts.
  dropDurablyStopped(ids, eventId) {
    if (this.blocked || !Array.isArray(ids) || new Set(ids).size !== ids.length ||
        typeof eventId !== 'string' || !/^sbot-c2-stop-all-v1:/.test(eventId) ||
        !this.#journal.hasEvent(eventId)) {
      throw new Error('C2 stop payloads lack durable commit')
    }
    const snapshot = authority(this.#journal)
    const completed = new Set(snapshot.receipts.completed.map(item => item.id))
    const pending = new Set(snapshot.receipts.pending.map(item => item.id))
    const queued = new Set(Object.values(snapshot.state.lanes.queue || {}).flatMap(lane =>
      lane.queue.flatMap(item => [item.id, ...(item.batch || []).map(member => member.id)])))
    if (snapshot.state.lastEventId !== eventId || ids.some(id => {
      receiptId(id)
      return !completed.has(id) || pending.has(id) || !this.#jobs.has(id) ||
        queued.has(`receipt:job:${id}`) || queued.has(`receipt:member:${id}`)
    })) {
      throw new Error('C2 stop payload still has live queue authority')
    }
    for (const id of ids) this.#jobs.delete(id)
    return true
  }

  auditQueued() {
    const snapshot = authority(this.#journal)
    if (this.blocked) throw new Error('C2 payload handles closed pending startup recovery')
    for (const lane of Object.values(snapshot.state.lanes.queue || {})) {
      for (const item of lane.queue) {
        const id = item.id.slice('receipt:job:'.length)
        if (!this.#jobs.has(id)) throw new Error('C2 queued payload handle missing')
      }
    }
    return true
  }

  // A normal visible-message chain may hold many queued payloads but cannot
  // silently acquire a batch or an unrelated handle while dispatch is in
  // progress. Verify the entire local projection before another admission.
  auditOrdinaryQueue(chatId, expectedIds) {
    if (this.blocked || typeof chatId !== 'string' || !chatId ||
        !Array.isArray(expectedIds) || expectedIds.length > this.#capacity ||
        new Set(expectedIds).size !== expectedIds.length ||
        expectedIds.some(id => !RECEIPT_ID.test(id))) {
      throw new Error('C2 ordinary queue projection invalid')
    }
    const snapshot = authority(this.#journal)
    const queue = snapshot.state.lanes.queue?.[chatId]?.queue
    if (!Array.isArray(queue) || queue.length !== expectedIds.length ||
        this.#jobs.size > this.#capacity) {
      throw new Error('C2 ordinary queue size differs from durable lane')
    }
    const pendingReceipts = new Map(snapshot.receipts.pending.map(item => [item.id, item]))
    for (let index = 0; index < queue.length; index++) {
      const id = expectedIds[index]
      const item = queue[index]
      const receipt = pendingReceipts.get(id)
      const job = this.#jobs.get(id)
      if (item?.id !== `receipt:job:${id}` || item.batch ||
          item.quiet !== false || item.polled !== false ||
          item.synthetic !== false || item.wantsAck !== false ||
          receipt?.source !== 'message' || receipt.chatId !== chatId ||
          receipt.quiet !== false || !job ||
          job.msg?._c2ReceiptId !== id || job.msg.chatId !== chatId ||
          job.msg.msgId !== receipt.sourceId || job.msg.quiet ||
          typeof job.platform?.replyOnce !== 'function' ||
          // A card platform, or one that declared plain replies at admission.
          !(typeof job.platform.createStreamingCard === 'function' ||
            job.platform.features?.plainReplies === true && job.platform.createStreamingCard === undefined) ||
          this.#journal.noticeStatus(id) !== null) {
        throw new Error('C2 ordinary queue payload differs from durable receipt')
      }
    }
    const localIds = [...this.#jobs.entries()]
      .filter(([, job]) => job.msg?.chatId === chatId).map(([id]) => id)
    if (localIds.length !== expectedIds.length ||
        localIds.some((id, index) => id !== expectedIds[index])) {
      throw new Error('C2 ordinary queue has extra or missing payload handle')
    }
    return true
  }

  reopenAfterRecovery() {
    const snapshot = authority(this.#journal)
    if (snapshot.receipts.pending.length ||
        Object.values(snapshot.state.lanes.queue || {}).some(lane => lane.queue.length) ||
        Object.values(snapshot.state.lanes.handoff || {}).some(lane =>
          lane.phase === 'handoff' || lane.phase === 'releasing') ||
        [...snapshot.effects.values()].some(status => status !== 'acked') ||
        [...snapshot.notices.values()].some(notice =>
          notice.status === 'attempting' || notice.status === 'unknown')) {
      throw new Error('C2 payload recovery has unresolved durable work')
    }
    this.#jobs.clear()
    this.#blocked = false
    return true
  }
}

module.exports = { C2PayloadHandles }
