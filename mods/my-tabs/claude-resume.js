// Claude sessions come back after a reboot. Herdr gives a lost terminal a shell
// in its last folder and never re-runs its program, so:
//
// - While Herdr runs, each Claude's terminal carries labels herdr-core keeps
//   across reboots: claude.session (from ~/.claude/sessions/<pid>.json; it changes
//   on /clear or a fork), claude.cwd (where that conversation lives) and
//   claude.argv (the command it was started with, minus resume flags).
// - A Claude that exits while Herdr watches (you quit it) loses its labels.
// - On Herdr's start, a labelled terminal whose shell is in front again gets
//   `cd <cwd> && <argv> --resume <session>`, but only when that shell started
//   after the labels were written (claude.at): a shell recreated after a reboot,
//   not the one a Claude you quit left behind.

import { terminals, exec, readTextFile, home } from "herdr";

const SHELLS = new Set(["fish", "bash", "zsh", "sh", "dash", "nu", "pwsh", "xonsh"]);
const isClaude = fg => fg?.name === "claude";
const isShell = fg => !fg || SHELLS.has(fg.name);

// Session flags are the session's, not the command's.
function baseArgv(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (["--resume", "-r", "--session-id", "--teleport"].includes(a)) { i++; continue; }
    if (/^--(resume|session-id|teleport)=/.test(a) || ["--continue", "-c", "--fork-session"].includes(a)) continue;
    out.push(a);
  }
  return out;
}

// fish, bash and zsh all read single quotes this way for these strings.
const quote = s => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

// `ps -o etime` ([[dd-]hh:]mm:ss) in seconds. Linux and macOS both have etime;
// macOS lacks etimes.
const elapsed = s => {
  const m = (s ?? "").trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  return m ? (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + +m[3] * 60 + +m[4] : NaN;
};

const ours = t => t.state === "live" && t.labels?.["herdr.space"] && !t.address.includes("/");

export class ClaudeResume {
  constructor() {
    this.running = new Set(); // terminals seen running Claude since Herdr started
    this.started = false;
  }

  // Every few seconds: label running Claudes, unlabel ones that exited.
  async record() {
    for (const t of terminals().filter(ours)) {
      const fg = t.foreground, labels = t.labels ?? {};
      if (isClaude(fg)) {
        this.running.add(t.address);
        let s;
        try { s = JSON.parse(await readTextFile(`${home()}/.claude/sessions/${fg.pid}.json`) ?? "null"); } catch { s = null; }
        if (!s?.sessionId) continue;
        const want = { "claude.session": s.sessionId, "claude.cwd": s.cwd || fg.cwd || t.cwd, "claude.argv": JSON.stringify(baseArgv(fg.argv ?? ["claude"])) };
        const set = Object.entries(want).filter(([k, v]) => labels[k] !== v).map(([k, v]) => `${k}=${v}`);
        if (set.length) await exec("hc", ["label", t.address, ...set, `claude.at=${Date.now()}`]);
      } else if (labels["claude.session"] && this.running.has(t.address) && isShell(fg)) {
        // Quit while we watched: it stays quit.
        this.running.delete(t.address);
        await exec("hc", ["label", t.address, "claude.session=", "claude.cwd=", "claude.argv=", "claude.at="]);
      }
    }
  }

  // Once per Herdr start: resume labelled terminals whose shell is newer than
  // their labels.
  async resumeAll() {
    if (this.started) return [];
    this.started = true;
    const done = [];
    for (const t of terminals().filter(ours)) {
      const l = t.labels ?? {};
      if (!l["claude.session"] || !isShell(t.foreground) || this.running.has(t.address)) continue;
      const pid = t.foreground?.pid ?? t.pid;
      const age = elapsed((await exec("ps", ["-o", "etime=", "-p", String(pid)])).stdout);
      const shellStart = Date.now() - age * 1000;
      if (!age || !(shellStart > Number(l["claude.at"] || Infinity))) {
        done.push(`${t.address}: kept (shell older than its Claude record)`);
        continue;
      }
      let argv;
      try { argv = JSON.parse(l["claude.argv"] || '["claude"]'); } catch { argv = ["claude"]; }
      const cmd = `cd ${quote(l["claude.cwd"] || t.cwd)} && ${[...argv, "--resume", l["claude.session"]].map(quote).join(" ")}`;
      const r = await exec("hc", ["send", t.address, cmd]);
      done.push(`${t.address}: ${r.code ? `failed (${r.stderr.trim()})` : cmd}`);
    }
    return done;
  }
}
