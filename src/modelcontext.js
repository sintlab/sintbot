'use strict'

// Configuration projection shared by chat, cards and the console. A configured
// model is not proof of what an executor ultimately selected or fell back to.
function modelContext(group = {}, provider = {}) {
  group ||= {}; provider ||= {}
  const environment = provider.runner === 'codex' ? '' : provider.env?.ANTHROPIC_MODEL
  const model = group.model || provider.model || environment || ''
  return { model, source: group.model ? 'group' : provider.model ? 'provider' : environment ? 'environment' : 'default',
    actualModel: null }
}

module.exports = { modelContext }
