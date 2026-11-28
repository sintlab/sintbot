'use strict'
// The language of the bot's own words in one conversation: notices, command
// replies, errors and status. Never the agent's answer.
//
// It is a per-conversation setting, `groups[chatId].lang` ("zh" or "en").
// Without the setting the platform decides: a Slack conversation speaks
// English (Slack is where the English-speaking users are), every other
// conversation speaks Chinese as it always has.
// Releases without the setting keep the key in the configuration file and
// ignore it.
const CHAT_LANGS = Object.freeze(['zh', 'en'])
const isChatLang = value => value === 'zh' || value === 'en'
// What a conversation speaks when nothing is set for it.
const defaultChatLang = platform => (platform === 'slack' ? 'en' : 'zh')
// `platform` is for a caller that knows where the conversation is although the
// entry does not say (a conversation not in the configuration, or a file read
// as written): the entry's own `platform` comes first.
const chatLang = (group, platform) => (group && isChatLang(group.lang) ? group.lang
  : defaultChatLang((group && group.platform) || platform))
// pick(lang, '中文', 'English')
const pick = (lang, zh, en) => (lang === 'en' ? en : zh)

module.exports = { CHAT_LANGS, isChatLang, defaultChatLang, chatLang, pick }
