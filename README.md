# Omux — tmux for Orca

Mirror tmux into Orca's sidebar instead of using Orca worktrees.

- **Layout**: each tmux session is an Orca project group (`local · 0`, `myhost · 0`). Each window
  gets a card in it, like opening its folder in VS Code:
  - folder inside a **git repo** → the repo as an Orca git project (Source Control, diff, branches,
    and "Recent" sort work). Windows in the same repo share that card; a card with one window is
    named after it, a shared one after the repo.
  - otherwise → a folder workspace named after the window (`3 api`), pointing at its folder.
  `cd` moves the window to the matching card; tabs follow. Remote hosts use the orcad server Orca
  runs on them, so their cards and tabs live on the remote machine like Orca's own.
- **Tabs**: one tab per window, attached through a grouped "view" session (`orca-w<id>`) pinned to
  that window. Splits, keys and new panes are plain tmux.
- **Status**: the pane bottom is read for claude/codex (`… (12s` / `esc to interrupt` = working,
  approval prompts = waiting) and published as the tab title via tmux `set-titles`, so Orca's own
  working/waiting/done indicators apply. Completion also posts a notification.
- **"+" in a window's workspace** opens a new tmux window in that session and folder (Claude or
  Codex picked from the "+" menu starts in that window instead of an Orca terminal); a new
  workspace added to a session's group becomes a new tmux window there too, named after the
  workspace. Pick an agent in Orca's dialog and it starts inside that tmux window (`agentCommands`)
  instead of in an Orca terminal. Naming it `claude <name>` / `codex <name>` works too.
- **Resuming from Orca's session history** opens the conversation in a tab; it moves into a new
  tmux window and the same conversation continues there (`--resume <id>` / `resume <id>` carried over).
- **Orca agent status**: each agent tab also gets Orca's in-band status record (the one its own
  agent hooks produce), so Orca's send-to-agent picker, permission alerts, activity feed and agent
  dashboard see tmux agents too. `statusBridge: false` turns it off.
- **Waiting for approval**: the agent row shows what the agent asks to run (e.g.
  `claude - action required · npm publish · …`). Click it and answer in the tab (1 / Esc).
- **Renaming a window's workspace** in Orca renames the tmux window (folder cards; the index
  prefix stays). Renaming in tmux updates the workspace.
- **Names**: a window tmux names after its command (claude shows up as its version, `2.1.311`)
  is named after its agent's task in Orca (`6 Tag the release`); agent tabs read
  `3m · <task>`: time in its current state, idle or working (Orca already shows the agent icon and status). Names you give windows stay.
- **Renaming a session** in tmux renames its group; renaming the group in Orca (with or without
  the `<host> · ` prefix) renames the session.
- **"+" in a card** opens a new tmux window in the card's folder at once, with a card of its own
  (or on the same git card), and its tab gets focus. The "+" tab closes by itself shortly after;
  a Claude/Codex picked in the "+" menu is started in the new window instead.
- **cd into or out of a git repo** moves a window to that card only after it stayed there a
  minute, so a quick `cd` while typing never pulls the tab away.
- **SSH host cards** start with a colored dot per host (🔵 🟣 🟢 …) so hosts tell apart in a status
  lane. Orca refuses tab colors from outside while its window is open, so the dot is on the card.
  `hostColors` picks them (`{ "<host>": "🟢" }`), `hostMarks: false` turns them off.
- **Linear**: a git card whose branch names an issue (`…/sva-1593-…`) is linked to it once, when
  Orca is connected to Linear and the issue exists. Unlinking it sticks.
- **Shared git cards** list their windows in the card's note; a note you write is left alone.
- **Ports**: Orca itself shows dev-server ports on local git cards, tmux ones included. It has no
  port display for folder or SSH workspaces.
- **Notifications**: Orca's completion notification names the card and shows the agent's last
  answer, read off its screen (claude `⏺`, codex `•`; tool calls skipped), or its task.
- **A group added in Orca** as `<host> · <name>` (e.g. `local · api`) becomes a new tmux session.
  Removing a group never kills a session.
- **Closing a tab** kills its pane (agent tab) or window (window tab), only when exactly one
  disappears while another tab of the same session is still open: bulk disappearance (workspace
  slept, Orca restarting) never kills.
- **Removing a window's card** kills the window, also when it is the session's last (Orca never
  removes workspaces by itself), unless an agent in it is working or waiting for approval: then the
  card is only hidden. A hidden card stays hidden across restarts until the window closes or
  "tmux: Reopen Closed Windows".
- **Detach / ssh drop** reopens the tab; the window is kept.
- **Hosts**: local plus SSH hosts connected in Orca (`"hosts": "orca"`) that have an orcad server.
  They are reached over Orca's own connection, never a second SSH login: orcad can read and write
  files there, so a small helper (`~/.orca-tmux/remote`, in a tmux session `omux-relay`) scans tmux
  and runs the runner's command files. It is started once through a hidden workspace ("Omux relay")
  and exits when the runner stops writing `alive` for 10 minutes. `"viaOrca": false` goes back to system `ssh`, where
  a "<host> 로그인" tab asks for the password when ssh can't log in.

Everything goes through the `orca` CLI and the CLI's own runtime client (`lib/bridge.cjs`, run on
Orca's Electron), and nothing lives inside Orca.app, so app updates don't remove it. The runtime
methods used (project groups, folder workspaces, terminals) are internal Orca APIs, so a future
Orca release could change them.

## Run

```sh
bin/install.sh          # launchd agent: runs at login, log in ~/.orca-tmux/runner.log (repeats summed up, kept under 1 MB)
bin/install.sh -u       # remove it
node bin/tmux-agents.mjs scan [host...]   # print the inventory
node bin/tmux-agents.mjs watch            # run the loop in the foreground
node bin/tmux-agents.mjs doctor           # health check: runner, Orca, tmux hooks, each host's last good scan
npm test                                  # unit tests (fake Orca + fake tmux; never touch real ones)
```

With `focusSync: true` in config.json (off by default), focus follows both ways: clicking an Orca tab makes its window current and its pane active in your
own tmux session (the tab's view gets a `client-focus-in` hook; tmux's `focus-events` must be on),
and picking another pane inside an Orca pane tab (click or keys) switches Orca to that pane's tab
(on SSH hosts too, within half a second).

A host that has not synced for 3 minutes (relay helper stuck, tmux gone) is reported once as a
notification (`healthAlerts: false` turns that off) and in the log, until it recovers.

Optional Orca plugin (commands/keybindings, and runs the loop itself if launchd isn't):
Settings → Plugins → enable the experimental plugin system, then add this folder under
Plugin Development. `⌘⌥⇧T` sync now, `⌘⌥⇧N` new window in the focused session card.

## Config — `~/.orca-tmux/config.json`

```json
{
  "hosts": "orca",
  "exclude": [],
  "intervalSec": 3,
  "notify": true,
  "closeTabKillsWindow": true,
  "gitCards": true,
  "agentCommands": { "claude": "claude", "codex": "codex" }
}
```

`hosts`: `"orca"` (connected in Orca), `"ssh-config"` (every `Host` alias), or a list.

`notify`: a macOS notification when an agent finishes a turn ("claude 완료") or starts waiting for
approval ("claude 승인 필요", with the command it asks about; once per wait). Read from the tmux
screen, so it comes for SSH hosts and tabs out of sight too.

`intervalSec`: seconds between light checks. A light check scans tmux (only agent panes' screens
are read; git roots are cached per folder) and lists Orca's groups, workspaces and tabs; the full
sync runs only when something changed, and at least every 30 s. tmux hooks (`set-hook -g …[77]`)
wake the runner the moment windows, panes or sessions come and go, or an agent turns busy or idle
(its title gains or loses the spinner; matched by tmux, once per change), and a tab check four times a second
catches a "+" in Orca. SSH hosts sync on their own lanes, so a slow host never delays the local one.

`idleAfterSec` (default 120, 0 turns it off): after this long with no keyboard or mouse input, the
tab check runs once a second instead of four times; the first input brings it back. Agent status
still arrives at once through the tmux hooks.

A host that has not synced for 3 minutes is reported, but time the Mac slept does not count.

## State

`~/.orca-tmux/` (or `$ORCA_TMUX_HOME`) holds `state.json` (session → group, window → workspace/tab), `config.json`, the
ssh control sockets, and the runner lock.
