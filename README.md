# Omux — tmux for Orca

Mirror tmux into Orca's sidebar instead of using Orca worktrees.

- **Layout**: each tmux session is an Orca project group (`local · 0`, `myhost · 0`); each
  tmux window is a folder workspace in it, named after the window (`3 api`) and pointing at the
  window's current folder — git or not — so Orca's explorer (and diff for git) shows it. `cd` in
  the window moves the workspace's folder; the tab stays. Remote hosts use the orcad server Orca
  runs on them (reached through the CLI's own runtime client), so their workspaces and tabs live
  on the remote machine like Orca's own and the tabs attach to tmux there directly.
- **Tabs**: one tab per window, attached through a grouped "view" session (`orca-w<id>`) pinned to
  that window. Splits, keys and new panes are plain tmux.
- **Status**: the pane bottom is read for claude/codex (`… (12s` / `esc to interrupt` = working,
  approval prompts = waiting) and published as the tab title via tmux `set-titles`, so Orca's own
  working/waiting/done indicators apply. Completion also posts a notification.
- **"+" in a window's workspace** opens a new tmux window in that session and folder; a new
  workspace added to a session's group becomes a new tmux window there too.
- **Closing a tab** (or deleting the window's workspace) kills its tmux window — only when exactly
  one disappears while another tab of the same session is still open. Bulk disappearance (workspace slept, Orca restarting) never kills.
- **Detach / ssh drop** reopens the tab; the window is kept.
- **Hosts**: local plus SSH hosts connected in Orca (`"hosts": "orca"`) that have an orcad server.
  Scanning and tmux commands use system `ssh`; when it can't log in, a "<host> 로그인" tab asks for
  the password once (ssh reads it from the terminal; nothing stores it) and the login is kept as a
  shared ssh master (`~/.orca-tmux/.cm`). Closing that tab without logging in pauses prompting for
  10 minutes.

Everything goes through the `orca` CLI and the CLI's own runtime client (`lib/bridge.cjs`, run on
Orca's Electron), and nothing lives inside Orca.app, so app updates don't remove it. The runtime
methods used (project groups, folder workspaces, terminals) are internal Orca APIs, so a future
Orca release could change them.

## Run

```sh
bin/install.sh          # launchd agent: runs at login, log in ~/.orca-tmux/runner.log
bin/install.sh -u       # remove it
node bin/tmux-agents.mjs scan [host...]   # print the inventory
node bin/tmux-agents.mjs watch            # run the loop in the foreground
npm test                                  # unit tests (fake Orca + fake tmux; never touch real ones)
```

Optional Orca plugin (commands/keybindings, and runs the loop itself if launchd isn't):
Settings → Plugins → enable the experimental plugin system, then add this folder under
Plugin Development. `⌘⌥⇧T` sync now, `⌘⌥⇧N` new window in the focused session card.

## Config — `~/.orca-tmux/config.json`

```json
{
  "hosts": "orca",
  "exclude": [],
  "intervalSec": 5,
  "notify": true,
  "closeTabKillsWindow": true
}
```

`hosts`: `"orca"` (connected in Orca), `"ssh-config"` (every `Host` alias), or a list.

## State

`~/.orca-tmux/` (or `$ORCA_TMUX_HOME`) holds `state.json` (session → group, window → workspace/tab), `config.json`, the
ssh control sockets, and the runner lock.
