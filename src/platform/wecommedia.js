'use strict'
const { createHash } = require('node:crypto')
const CHUNK_BYTES = 512 * 1024
// Official WebSocket media framing. No additional connection and no implicit
// retry: callers retain authority over an unconfirmed outward send.
async function uploadWecomMedia(call, bytes, { type, filename } = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 100 * CHUNK_BYTES) throw new Error('媒体文件应为 1 字节至 50 MiB')
  if (!['image', 'file'].includes(type) || typeof filename !== 'string' || !filename || /[\x00-\x1f/\\]/.test(filename)) throw new Error('媒体类型或文件名无效')
  const request = async (cmd, body) => {
    const ack = await call(cmd, body)
    if (!ack || ack.errcode !== 0) throw new Error('媒体上传未确认')
    return ack.body || {}
  }
  const count = Math.ceil(bytes.length / CHUNK_BYTES)
  const init = await request('aibot_upload_media_init', { type, filename, total_size: bytes.length,
    total_chunks: count, md5: createHash('md5').update(bytes).digest('hex') })
  if (typeof init.upload_id !== 'string' || !init.upload_id) throw new Error('媒体上传未返回标识')
  for (let i = 0; i < count; i++) {
    await request('aibot_upload_media_chunk', { upload_id: init.upload_id, chunk_index: i,
      base64_data: bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).toString('base64') })
  }
  const finish = await request('aibot_upload_media_finish', { upload_id: init.upload_id })
  if (typeof finish.media_id !== 'string' || !finish.media_id) throw new Error('媒体上传未返回素材标识')
  return finish.media_id
}
module.exports = { uploadWecomMedia, CHUNK_BYTES }
