'use strict'
// The marks a message of the bot opens a line with. One plain, single-colour
// set for every platform and both languages; no emoji and no other
// pictographic symbol in any text the bot writes into a conversation
// (2026-11-25). The model's own answers follow the same three status marks
// (done, failed, caution) through the reply rules of the binary core.
//
//   working  ◐  received, queued, still running
//   done     ✓  finished, changed, saved
//   failed   ✗  did not finish, went wrong
//   caution  △  refused, needs attention, a risk
//   step     ▶  a finished stage of a running task
//   main     ●  the main agent of a running turn
//   joined   ↳  a follow-up that joined the running turn
//
// The branch lines of the subagent rows (├ └ │) come from the binary core.
const MARK = Object.freeze({ working: '\u25D0', done: '\u2713', failed: '\u2717', caution: '\u25B3', step: '\u25B6',
  main: '\u25CF', joined: '\u21B3' })

// Emoji and other pictographic symbols: what must not appear in such text.
// The plain marks above and the arrows, box lines and geometric shapes of
// ordinary text are outside these ranges.
const PICTOGRAPH = /[\u21A9\u21AA\u231A\u231B\u23E9-\u23FA\u2600-\u2604\u260E\u2611\u2614\u2615\u2618\u261D\u2620-\u2623\u2626\u262A\u262E\u262F\u2638-\u263A\u2640\u2642\u2648-\u2653\u265F\u2660\u2663\u2665\u2666\u2668\u267B\u267E\u267F\u2692-\u2697\u2699\u269B\u269C\u26A0\u26A1\u26A7\u26AA\u26AB\u26B0\u26B1\u26BD\u26BE\u26C4\u26C5\u26C8\u26CE\u26CF\u26D1\u26D3\u26D4\u26E9\u26EA\u26F0-\u26F5\u26F7-\u26FA\u26FD\u2702\u2705\u2708-\u270D\u270F\u2712\u2714\u2716\u271D\u2721\u2728\u2733\u2734\u2744\u2747\u274C\u274E\u2753-\u2755\u2757\u2763\u2764\u2795-\u2797\u27A1\u27B0\u27BF\u2B05-\u2B07\u2B1B\u2B1C\u2B50\u2B55\uFE0F]|[\u{1F000}-\u{1FAFF}]/u

module.exports = { MARK, PICTOGRAPH }
