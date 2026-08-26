// Slack does not render Markdown; the host converts at the wire. These pin the
// conversions that made real messages look broken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSlackMrkdwn } from '../host/lib/slack-mrkdwn.mjs';

test('bold and headings become Slack bold', () => {
  assert.equal(toSlackMrkdwn('**Warm engagers** rock'), '*Warm engagers* rock');
  assert.equal(toSlackMrkdwn('## Which motions?'), '*Which motions?*');
});

test('markdown italics become Slack italics', () => {
  assert.equal(toSlackMrkdwn('for *emphasis* only'), 'for _emphasis_ only');
});

test('links become Slack links', () => {
  assert.equal(toSlackMrkdwn('see [docs](https://example.com/x)'), 'see <https://example.com/x|docs>');
});

test('list dashes become bullets', () => {
  assert.equal(toSlackMrkdwn('- one\n- two'), '• one\n• two');
});

test('code spans and fences are left exactly alone', () => {
  assert.equal(toSlackMrkdwn('keep `ft_worked` as-is'), 'keep `ft_worked` as-is');
  const fence = '```\nconst x = **not bold**;\n- not a bullet\n```';
  assert.equal(toSlackMrkdwn(fence), fence);
});

test('a full message converts coherently', () => {
  const input = '## Plan\n\n- **Outbound** — [list](https://x.com/l) daily\n- **CS** — check-ins';
  assert.equal(toSlackMrkdwn(input), '*Plan*\n\n• *Outbound* — <https://x.com/l|list> daily\n• *CS* — check-ins');
});
