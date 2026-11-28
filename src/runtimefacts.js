'use strict'

// Supported surfaces of the release host. These are facts passed to the core
// renderer, not an alternative implementation of core policy.
const GROUP_COMMANDS = Object.freeze(['/help', '/status', '/model', '/new', '/hud', '/issue', '/skip', '/stop'])
// The commands the Slack adapter turns back from the typed alias (`!resume`)
// and names that way in the service's own notices: the group commands and the
// resume command a held conversation answers.
const SLACK_COMMANDS = Object.freeze([...GROUP_COMMANDS, '/resume'])
const RUNTIME_ENTRY = require('node:path').join(__dirname, '..', 'bin', 'sintbot-v2.js')
const quoteShell = value => "'" + String(value).replace(/'/g, "'\\''") + "'"
function runtimeCommand(entry = RUNTIME_ENTRY, node = process.execPath) {
  return `${quoteShell(node)} ${quoteShell(entry)}`
}
module.exports = { GROUP_COMMANDS, SLACK_COMMANDS, RUNTIME_ENTRY, runtimeCommand }
