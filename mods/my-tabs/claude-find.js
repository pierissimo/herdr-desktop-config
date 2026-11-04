// my-tabs.claude-find (bound to ctrl-alt-f) in a Claude Code pane: Claude's own transcript
// search: Ctrl+O (unless its transcript is already open), then "/". Other panes
// are left alone. Keys go through herdr-core (`hc keys`), which encodes them the
// way the program asked for (a raw Ctrl+O byte isn't Claude's Ctrl+O).

import { focused, panes, exec } from "herdr";

let busy = false; // a held key repeats: one search at a time

export async function claudeFind() {
  if (busy) return;
  busy = true;
  try {
    const terminal = focused()?.terminal;
    const pane = panes().find(p => p.terminal === terminal);
    if (!terminal || pane?.app !== "claude-code") return;
    const screen = await exec("hc", ["read", terminal]);
    const open = /Showing detailed transcript/.test(screen.stdout);
    await exec("hc", ["keys", terminal, ...(open ? [] : ["ctrl+o"]), "/"]);
  } finally {
    busy = false;
  }
}
