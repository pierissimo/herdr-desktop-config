// Automatic tab names: a tab nobody named takes its agent's session name (the
// terminal title Claude Code, Codex, ... set, e.g. after /rename) and follows it.
// Names this sets are remembered in shared "tabs.autoname" ({tab id: name}), so a
// tab keeps following while its name is still the one set here; once someone
// renames it to something else, it's theirs and left alone. Renaming it to ""
// (its number again) hands it back, and so does a name that is only the
// program's ("Claude Code"). With no agent left, a tab keeps its last name.

import { agents, spaces, run, shared, setShared } from "herdr";

const KEY = "tabs.autoname";

// Strip what agents put around the name: spinners and status glyphs in front
// (✳, ⠂, ·), markers after (Claude Code's ⑂).
export function clean(title) {
  return (title ?? "")
    .replace(/^[\s\p{So}\p{Sk}·•*]+/u, "")
    .replace(/[\s\p{So}\p{Sk}·•]+$/u, "")
    .trim();
}

// Titles that are just the program, not a session name.
function generic(name, agent) {
  const n = name.toLowerCase();
  return !n || [agent.app, agent.program?.name, agent.program?.key, "claude", "claude code", "codex", "pi", "agent"]
    .some(g => g && n === String(g).toLowerCase());
}

const pending = new Map(); // tab id -> name asked for, until spaces() shows it

export function syncTabNames() {
  const auto = shared(KEY) ?? {};
  const all = spaces().flatMap(s => s.tabs);
  const byTab = new Map();
  for (const a of agents()) if (!byTab.has(a.tab)) byTab.set(a.tab, a); // first agent in pane order
  let next = null;
  for (const tab of all) {
    if (pending.get(tab.id) === tab.name) pending.delete(tab.id);
    const agent = byTab.get(tab.id);
    if (!agent) continue;
    const want = clean(agent.title);
    if (generic(want, agent)) continue;
    // Ours to set: nobody named it, we named it, or it's just the program's name
    // (Herdr's + menu names a new agent tab "Claude Code").
    const ours = !tab.named || auto[tab.id] === tab.name || generic(tab.name, agent);
    if (!ours || tab.name === want || pending.get(tab.id) === want) continue;
    pending.set(tab.id, want);
    run("tab.rename", { id: tab.id, name: want });
    (next ??= { ...auto })[tab.id] = want;
  }
  if (next) {
    const live = new Set(all.map(t => t.id));
    // Only this machine's: another machine's tabs are missing while it loads or is offline.
    for (const id of Object.keys(next)) if (!live.has(id) && !id.includes("/")) delete next[id];
    setShared(KEY, next);
  }
}
