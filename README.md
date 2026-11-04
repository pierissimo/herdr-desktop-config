# herdr-desktop-config

Mods, layouts and key bindings for the [Herdr desktop app](https://github.com/herdrdev/herdr-app).

Everything here uses Herdr's mod and layout APIs: they're copies of Herdr's own mods and layouts with different names, so Herdr updates never overwrite them. Tested on Herdr 0.1.13.

## What's in it

| Path | What it does |
|---|---|
| `mods/my-tabs` | Tab bar. **Automatic tab names** taken from the agent's session name (Claude Code, Codex…); a name you type yourself is never overwritten. **Notes** button and a note marker on tabs. **Claude auto-resume**: after a restart, each tab that was running Claude reruns its original command with `--resume <session>`. **Claude transcript search** command. |
| `mods/my-agents` | Agents panel: status icon on the left, tab name on top, space shown under it in grey. |
| `mods/my-menu` | Right-click **Quote selection**: pastes the selected text into the input as a `> ` markdown quote. |
| `mods/my-sidebar` | Experimental sidebar that combines spaces and agents: agents grouped by space, collapsible spaces, an attention bar, and custom or priority ordering. Sessions idle for more than a day are tucked away. |
| `mods/tab-notes` | Markdown notes for each tab, from [ozcberkay/herdr-coban](https://github.com/ozcberkay/herdr-coban). |
| `layouts/my-main.json` | The default layout, wired to the mods above. |
| `layouts/sidebar-lab.json` | `my-main` with `my-sidebar` in place of the separate spaces and agents lists. |
| `keys.json` | `ctrl-shift-f` opens Herdr's find bar; `ctrl-alt-f` opens Claude's transcript search. |

## Install

Requires `herdr-app`, plus `jq` to merge the key bindings. Quote selection uses `wl-paste` and `wl-copy` to read and write the selection.

```sh
git clone https://github.com/pierissimo/herdr-desktop-config
cd herdr-desktop-config
./install.sh
```

Then, in Herdr, press **Ctrl+Shift+L** and pick `my-main`, or `sidebar-lab` for the combined sidebar.

## Notes

- **Claude auto-resume:** it stores the session ID, folder and original command as terminal labels, which herdr-core keeps across restarts. A Claude you quit yourself isn't resumed. Each Herdr start writes a log to `~/.config/herdr-app/.claude-resume.log`.
- **Herdr updates:** each mod's `mod.json` records the upstream version it was copied from (`cloned_from`). After an update, diff upstream `defaults/mods/<name>` between the two tags and port the fixes into these copies.
- **Updating this repo:** copy `~/.config/herdr-app/mods/my-*`, `mods/tab-notes` and `layouts/{my-main,sidebar-lab}.json` back into the repo, leaving out `gpui-kit.d.ts` and `jsconfig.json`.

## License

Apache-2.0, the same license as Herdr and herdr-coban. See `NOTICE`.
