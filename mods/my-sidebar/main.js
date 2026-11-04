// Spaces with their agents (a copy of Herdr's spaces mod, plus agents). Each space:
// a stable colored avatar, worktrees under their checkout, grouped by machine when
// more than one is known, the repo/branch/ahead-behind only where unusual. Under
// it, one row per agent: status first, running and waiting ones tinted with a
// colored edge, idle ones dimmed. On top, a bar counts what needs you and what's
// running; clicking it goes to the next one. Click a space to switch, right-click
// for its menu, drag to reorder; click an agent to go to it.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, agents, terminals, run, openOverlay, exec, hc, theme, shared, setShared, setAgentOrder, watchFolder, window, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

// Priority view: an idle agent nobody touched for this long (no state change, not
// looked at) goes under its space's "N inactive" row.
const INACTIVE_MS = 24 * 60 * 60 * 1000;

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const tabOf = a => spaces().flatMap(s => s.tabs).find(t => t.id === a.tab);

// The tab's name, else the agent's own title (minus spinners), else its program.
function agentName(a, tab) {
  if (tab?.named) return tab.name;
  const title = (a.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return title && title !== a.program?.name ? title : a.program?.name || tab?.name || a.address;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    // When each agent last changed state (ms), kept across restarts: Herdr's own
    // changed_at starts empty at every launch. Done and idle count as one
    // (looking at a finished agent isn't the agent doing anything).
    this.activity = JSON.parse(localStorage.getItem("activity") ?? "{}");
    // Since when this panel keeps that record: an agent started before then has no
    // known activity; one started after counts its start as activity.
    this.tracking = Number(localStorage.getItem("activity.since")) || Date.now();
    localStorage.setItem("activity.since", String(this.tracking));
    this.frozen = null; // the priority order while the pointer is over the list
    this.openInactive = new Set(JSON.parse(localStorage.getItem("inactive.open") ?? "[]")); // spaces showing theirs
    // Spaces folded to their running / waiting agents (idle ones hidden).
    this.foldedSpaces = new Set(JSON.parse(localStorage.getItem("spaces.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
    // Durations on agent rows ("5m") change once a minute.
    cx.timer.every(30000, (cx) => cx.notify());
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      // Looking at an agent is activity too.
      if (a.focused && this.activity[a.address]?.s === s && now - (this.activity[a.address].at ?? 0) > 60000) {
        this.activity[a.address].at = now;
        dirty = true;
        continue;
      }
      if (this.activity[a.address]?.s === s) continue;
      // First sighting after a start isn't activity: keep any older record's time.
      this.activity[a.address] = { s, at: this.activity[a.address] ? now : this.activity[a.address]?.at ?? 0 };
      dirty = true;
    }
    if (!dirty) return;
    const live = new Set(list.map(a => a.address));
    for (const [k, v] of Object.entries(this.activity)) if (!live.has(k) && now - v.at > 30 * 86400000) delete this.activity[k];
    localStorage.setItem("activity", JSON.stringify(this.activity));
  }

  priority() { return shared("sidebar.order") === "priority"; }

  // When an agent last did something: its last state change or look, else when
  // its terminal started if that was after tracking began (a new agent is fresh;
  // one that was already running is unknown, so it counts as untouched).
  lastActive(a) {
    const at = this.activity[a.address]?.at;
    if (at) return at;
    this.created ??= new Map();
    if (!this.created.has(a.address)) {
      const created = terminals().find(x => x.address === a.address)?.created_ms ?? 0;
      this.created.set(a.address, created > this.tracking ? created : 0);
    }
    return this.created.get(a.address);
  }

  // An idle agent nobody touched for INACTIVE_MS (no state change, not looked at).
  inactive(a, now = Date.now()) {
    return a.status === "idle" && !a.focused && now - this.lastActive(a) > INACTIVE_MS;
  }

  // Priority view, every agent of the space inactive: the space shows as one row.
  sleeping(w) {
    if (!this.priority() || this.foldedSpaces.has(w.id)) return false;
    const tabs = new Set((w.tabs ?? []).map(tab => tab.id));
    const mine = agents().filter(a => tabs.has(a.tab));
    return mine.length > 0 && mine.every(a => this.inactive(a));
  }

  // Needs you > running > idle; then the most recent activity. Running counts as now.
  score(a, now) {
    const urgency = a.status === "blocked" || a.status === "done" ? 3 : a.status === "working" ? 2 : 1;
    return [urgency, a.status === "working" ? now : this.lastActive(a)];
  }

  // The priority order: space id -> rank, agent address -> rank. Kept while the
  // pointer is over the list, so nothing moves under a click.
  ranking() {
    if (this.hovering && this.frozen) return this.frozen;
    const now = Date.now(), cmp = (x, y) => y[0] - x[0] || y[1] - x[1];
    const all = agents();
    const agentRank = new Map(all.slice().sort((x, y) => cmp(this.score(x, now), this.score(y, now))).map((a, n) => [a.address, n]));
    const spaceScore = s => {
      const tabs = new Set((s.tabs ?? []).map(t => t.id));
      return all.filter(a => tabs.has(a.tab)).map(a => this.score(a, now)).sort(cmp)[0] ?? [0, 0];
    };
    const sp = spaces();
    const spaceRank = new Map(sp.map((s, i) => ({ s, i, k: spaceScore(s) })).sort((x, y) => cmp(x.k, y.k) || x.i - y.i).map((r, n) => [r.s.id, n]));
    return (this.frozen = { spaceRank, agentRank });
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    let out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Herdr's own space order follows this list (worktrees under their repo), so
    // Ctrl+1..9 match what's shown (from Herdr 0.1.13). Always the custom order:
    // priority sorting below is for display only and never moves spaces.
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    out = out.filter(r => this.shown.has(r.w.id));
    if (!this.priority()) return out;
    // Priority: move whole blocks (a space and the worktrees under it) by their best rank.
    const { spaceRank } = this.ranking();
    const blocks = [];
    for (const r of out) (r.tree ? blocks.at(-1) : blocks[blocks.push([]) - 1]).push(r);
    const best = b => Math.min(...b.map(r => spaceRank.get(r.w.id) ?? Infinity));
    return blocks.map((b, n) => ({ b, n })).sort((x, y) => best(x.b) - best(y.b) || x.n - y.n).flatMap(x => x.b);
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const draw = (r) => (collapsed ? [this.compact(r, t)] : [this.row(r, t), ...this.agentRows(r.w, t)]);
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.flatMap(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      if (!collapsed && rebuilt) return [head];
      return [head, ...(folded ? [] : mine.length ? mine.flatMap(draw) : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, g, tree }, t) {
    // The selected fill goes on one row only: the focused agent's when it's in
    // this space, else the space's. The active space's name is semibold either way.
    const tabs = new Set((w.tabs ?? []).map(tab => tab.id));
    const agentFocused = agents().some(a => a.focused && tabs.has(a.tab));
    const on = w.active && !agentFocused;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        if (this.priority()) return; // the order is the panel's: no dragging
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).when(w.active, el => el.font_semibold()).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1())
          .child(this.fold(w, t)),
      );
  }

  // One row per agent in the space, in tab order: status, name, how long. A
  // folded space keeps the ones running or waiting: attention never folds away.
  agentRows(w, t) {
    const tabs = new Map((w.tabs ?? []).map(tab => [tab.id, tab]));
    let mine = agents().filter(a => tabs.has(a.tab));
    if (this.priority()) {
      const { agentRank } = this.ranking();
      mine = mine.sort((x, y) => (agentRank.get(x.address) ?? Infinity) - (agentRank.get(y.address) ?? Infinity));
    }
    if (this.foldedSpaces.has(w.id)) return mine.filter(a => a.status !== "idle").map(a => this.agentRow(a, tabs.get(a.tab), t));
    if (!this.priority()) return mine.map(a => this.agentRow(a, tabs.get(a.tab), t));
    // Priority: idle agents nobody touched for a while go under one "N inactive" row.
    const now = Date.now();
    const active = mine.filter(a => !this.inactive(a, now)), rest = mine.filter(a => this.inactive(a, now));
    const open = this.openInactive.has(w.id);
    // All inactive: the space row's chevron opens it; no "inactive" row of its own.
    if (!active.length) return open ? rest.map(a => this.agentRow(a, tabs.get(a.tab), t)) : [];
    const rows = active.map(a => this.agentRow(a, tabs.get(a.tab), t));
    if (!rest.length) return rows;
    rows.push(h_flex().id(`inactive-${w.id}`).h(24).mt(2).ml(10).pl(12).pr(8).gap(8).flex_none().items_center().rounded(7)
      .text_size(11.5).text_color(t.dim).cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(rest.map(a => agentName(a, tabs.get(a.tab))).join("\n"))
      .on_click((_e, cx) => {
        open ? this.openInactive.delete(w.id) : this.openInactive.add(w.id);
        localStorage.setItem("inactive.open", JSON.stringify([...this.openInactive]));
        cx.notify();
      })
      .child(h_flex().w(14).flex_none().justify_center().child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11)))
      .child(div().flex_1().child(`${rest.length} inactive`)));
    if (open) rows.push(...rest.map(a => this.agentRow(a, tabs.get(a.tab), t)));
    return rows;
  }

  toggleSpace(id) {
    this.foldedSpaces.has(id) ? this.foldedSpaces.delete(id) : this.foldedSpaces.add(id);
    const live = new Set(spaces().map(s => s.id));
    localStorage.setItem("spaces.folded", JSON.stringify([...this.foldedSpaces].filter(x => live.has(x))));
  }

  agentRow(a, tab, t) {
    const hot = a.status === "working" || a.status === "blocked" || a.status === "done";
    const color = t[a.status] ?? t.dim;
    const since = a.status === "working" ? tab.working_since : tab.changed_at;
    return h_flex()
      .id(`agent-${a.address}`)
      .relative()
      .h(28)
      .mt(2)
      .flex_none()
      .ml(10)
      .pl(12)
      .pr(8)
      .gap(8)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      // Fill means selected (neutral, one row); status speaks through the edge,
      // the icon and the time. Only "needs you" keeps a faint tint.
      .when(a.status === "blocked" && !a.focused, el => el.bg(color + "14"))
      .when(a.focused, el => el.bg(t.selected))
      .hover(s => s.bg(a.focused ? t.selected : t.hover))
      .on_click(() => run("pane.focus", { pane: a.pane }))
      // The colored edge: the part that catches the eye from across the room.
      .when(hot, el => el.child(div().absolute().left(0).top(5).bottom(5).w(3).rounded(2).bg(color)))
      .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a.status)))
      .child(div().flex_1().min_w(0).truncate()
        .text_size(12.5)
        .when(hot, el => el.font_medium().text_color(t.foreground))
        .when(!hot, el => el.text_color(a.focused ? t.foreground : t.muted))
        .child(agentName(a, tab)))
      .when(a.status === "blocked", el => el.child(div().flex_none().px(6).h(17).rounded(5).bg(color + "33").text_size(10.5).font_semibold().text_color(color).flex().items_center().child("Needs you")))
      .when(a.status !== "blocked" && Boolean(since), el => el.child(div().flex_none().text_size(11).text_color(hot ? color : t.dim).child(duration(Date.now() - since))));
  }

  // The fold chevron; folded, how many idle agents it hides. Its press is its own
  // (no select, no drag of the row).
  fold(w, t) {
    const tabs = new Set((w.tabs ?? []).map(tab => tab.id));
    const mine = agents().filter(a => tabs.has(a.tab));
    if (!mine.length) return div().w(18).flex_none();
    const sleeping = this.sleeping(w);
    const folded = sleeping ? !this.openInactive.has(w.id) : this.foldedSpaces.has(w.id);
    const hidden = !folded ? 0 : sleeping ? mine.length : mine.filter(a => a.status === "idle").length;
    return h_flex().id(`fold-${w.id}`).flex_none().h(20).px(3).gap(3).items_center().rounded(5)
      .text_size(11).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(sleeping ? (folded ? "Nothing here for a day. Show its agents" : "Hide its agents") : folded ? "Show all agents" : "Fold: keep only running and waiting agents")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (sleeping) {
          folded ? this.openInactive.add(w.id) : this.openInactive.delete(w.id);
          localStorage.setItem("inactive.open", JSON.stringify([...this.openInactive]));
        } else this.toggleSpace(w.id);
        cx.notify();
      })
      .when(hidden > 0, el => el.child(`+${hidden}`))
      .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(12).flex_none());
  }

  status(t, status) {
    if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
    if (status === "blocked") return div().size(14).flex_none().rounded(4).bg(t.blocked).text_size(10.5).font_bold().text_color("#ffffff").flex().items_center().justify_center().child("!")
      .loop("opacity", { from: 0.55, to: 1, period: 1100 });
    if (status === "done") return div().size(8).flex_none().rounded(4).bg(t.done);
    return div().size(7).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
  }

  // One chip per state, in the colors and icons the rows use: "1 needs you",
  // "1 finished", "2 running". A click goes to the next one (after the focused agent).
  attention(t, collapsed) {
    const all = agents();
    const groups = [
      { id: "blocked", list: all.filter(a => a.status === "blocked"), label: n => `${n} need${n === 1 ? "s" : ""} you` },
      { id: "done", list: all.filter(a => a.status === "done"), label: n => `${n} finished` },
      { id: "working", list: all.filter(a => a.status === "working"), label: n => `${n} running` },
    ].filter(g => g.list.length);
    if (!groups.length) return null;
    const next = list => list[(list.findIndex(a => a.focused) + 1) % list.length];
    return h_flex().flex_none().px(collapsed ? 4 : 10).pb(6).gap(6).flex_wrap()
      .children(groups.map(g => {
        const color = t[g.id];
        return h_flex().id(`attn-${g.id}`).h(24).px(collapsed ? 4 : 8).gap(6).items_center().rounded(6)
          .bg(color + "24").text_size(11.5).font_medium().text_color(color).cursor_pointer()
          .hover(s => s.bg(color + "3d"))
          .tooltip(g.list.map(a => agentName(a, tabOf(a))).join("\n"))
          .on_click(() => run("pane.focus", { pane: next(g.list).pane }))
          .child(this.status(t, g.id))
          .when(!collapsed, el => el.child(g.label(g.list.length)));
      }));
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    this.track(agents(), Date.now());
    // agent.next / agent.prev follow this list: spaces in order, agents in tab order
    // (priority: as ranked).
    if (this.priority()) {
      const { agentRank } = this.ranking();
      setAgentOrder(agents().slice().sort((x, y) => (agentRank.get(x.address) ?? 0) - (agentRank.get(y.address) ?? 0)).map(a => a.address));
    } else {
      const order = new Map(sp.flatMap(s => s.tabs).map((tab, n) => [tab.id, n]));
      setAgentOrder(agents().slice().sort((x, y) => (order.get(x.tab) ?? 0) - (order.get(y.tab) ?? 0)).map(a => a.address));
    }
    const prio = this.priority();
    const bar = this.attention(t, collapsed);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(!collapsed, el => el.child("Spaces"))
        .when(!collapsed, el => el.child(h_flex().flex_1()))
        .child(div().id("order").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .when(prio, el => el.text_color(t.accent))
          .tooltip(prio ? "Priority order: needs you, running, then most recent. Click for your own order." : "Your order (drag to change). Click for priority order.")
          .on_click(() => { this.frozen = null; setShared("sidebar.order", prio ? "custom" : "priority"); })
          .child(svg(`mods/workspace-chrome/${prio ? "clock" : "layers"}.svg`).size(14)))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .when(Boolean(bar), el => el.child(bar))
      .child(v_flex().id("space-list").flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        // Priority order holds still while the pointer is here; it catches up on leaving.
        .on_hover((on, cx) => { this.hovering = on; if (!on) { this.frozen = null; cx.notify(); } })
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(this.grouped(t, collapsed)));
  }
}
