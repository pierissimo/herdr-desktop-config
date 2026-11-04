// Turns text selected in a terminal into a markdown quote ("> " lines).
// Terminal text comes hard-wrapped and indented (Claude Code draws its own
// wrapping, with a "●" bullet before each message), so this strips the bullet
// and the shared indent and joins wrapped lines back into paragraphs. Lists,
// code fences, tables and headings keep their own lines.

const BULLET = /^(\s*)[●⏺]\s/;
const MARKER = /^\s*([-*+•]|\d+[.)])\s/;          // list item
const KEEP = /^\s*(```|~~~|#{1,6}\s|>|\||[│┃┌┐└┘├┤┬┴┼─━╭╮╰╯])/; // lines that stay as they are

export function toQuote(text) {
  let lines = text.replace(/\r\n?/g, "\n").split("\n").map(l => l.replace(/\s+$/, ""));
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (!lines.length) return "";

  // "● text" becomes "  text", so a message's wrapped lines line up with its first.
  lines = lines.map(l => l.replace(BULLET, (_m, sp) => sp + "  "));
  const indent = Math.min(...lines.filter(Boolean).map(l => l.match(/^\s*/)[0].length));
  lines = lines.map(l => l.slice(indent));

  const out = [];
  let fence = false, joinable = false;
  for (const l of lines) {
    const isFence = /^\s*(```|~~~)/.test(l);
    if (fence || isFence) {
      out.push(l);
      if (isFence) fence = !fence;
      joinable = false;
      continue;
    }
    if (!l) { out.push(""); joinable = false; continue; }
    if (joinable && !MARKER.test(l) && !KEEP.test(l)) {
      out[out.length - 1] += " " + l.trim();
      continue;
    }
    out.push(l);
    joinable = !KEEP.test(l);
  }
  return out.map(l => (l ? `> ${l}` : ">")).join("\n") + "\n";
}
