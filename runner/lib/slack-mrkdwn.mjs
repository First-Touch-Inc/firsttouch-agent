// Markdown → Slack's mrkdwn.
//
// Slack does not speak Markdown. `**bold**` renders as literal asterisks, `##`
// headings as literal hashes, and `[text](url)` as literal brackets — so a model
// writing perfectly ordinary Markdown produces a message that looks broken to
// the person reading it.
//
// Telling the model "write Slack formatting" is necessary but not sufficient:
// it drifts back to Markdown constantly, because nearly everything it has ever
// read is Markdown. So the wire format is enforced here, at the last moment
// before the text goes out, where drift cannot reach.
//
// Code spans are parked and restored around the rewrites: Slack renders ``` and
// ` itself, and rewriting emphasis inside code would corrupt the code.

// Private-use code points. They cannot appear in a real message, so parking
// spans behind them is unambiguous.
const CODE = '';
const BOLD = '';

export function toSlackMrkdwn(input) {
  const parked = [];

  let out = String(input ?? '')
    .replace(/```[\s\S]*?```/g, (m) => CODE + (parked.push(m) - 1) + CODE)
    .replace(/`[^`\n]+`/g, (m) => CODE + (parked.push(m) - 1) + CODE);

  out = out
    // Links: [text](url) → <url|text>
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
    // Headings have no equivalent. Bold the line.
    // `[ \t]*$` not `\s*$`: the greedy \s swallowed the blank line AFTER a
    // heading, collapsing paragraph spacing everywhere a heading appeared.
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*$/gm, BOLD + '$1' + BOLD)
    // Bold, parked so the italic pass below cannot see these asterisks.
    .replace(/\*\*([^\n*]+?)\*\*/g, BOLD + '$1' + BOLD)
    .replace(/__([^\n_]+?)__/g, BOLD + '$1' + BOLD)
    // A surviving single *x* is Markdown italic; Slack spells that _x_.
    .replace(/(^|[\s(])\*([^\n*]+?)\*(?=[\s.,;:!?)]|$)/gm, '$1_$2_')
    // Strikethrough: ~~x~~ → ~x~
    .replace(/~~([^\n~]+?)~~/g, '~$1~')
    // List markers render literally in Slack; a real bullet reads better.
    .replace(/^(\s*)[-*+][ \t]+/gm, '$1• ')
    // Horizontal rules have no equivalent and render as a line of noise.
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, '');

  return out
    .split(BOLD).join('*')
    .replace(new RegExp(CODE + '(\\d+)' + CODE, 'g'), (_, i) => parked[Number(i)]);
}
