// The command an Orca tab types to show a tmux window. It runs in the tab's own shell — locally,
// or on the remote host through Orca's orcad terminal — so no ssh hop is involved.
//
// A grouped "view" session gives the tab its own current window without moving the user's other
// clients. The view is pinned to the window, forwards a computed title (so Orca's title-based agent
// status works), and is destroyed when the tab detaches.
//   window tab: view orca-w<window>, title = the active pane's
//   pane tab:   view orca-p<pane>,   title = that pane's only, and its own active pane (see below)
// The view's tmux status line is off: Orca's sidebar already lists the windows, and every status
// redraw re-runs the user's status scripts and streams output into a (often hidden) tab.
// Bells are not forwarded either: with tmux's default bell-action any, a bell in any window would
// ring every tab and Orca marks each one unread. Real completions still reach Orca via the title.
import { PANE_VIEW_PREFIX, VIEW_PREFIX } from './scan.mjs'

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

// Single line: the command is typed into an interactive shell, where a newline would run it early.
// set/set-hook take the plain name (they reject the "=" exact-match prefix); attach and
// select-window take "=name". destroy-unattached is set only once attached, or tmux reaps the view.
// "#{m:?N,#{pane_id}}" matches pane %N ("?" stands for the "%", which "==" can't compare).
const SCRIPT = [
  'PATH=$PATH:/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin',
  's=$1; w=$2; p=$3',
  `if [ -n "$p" ]; then v="${PANE_VIEW_PREFIX}\${p#%}"; t="#{P:#{?#{m:?\${p#%},#{pane_id}},#{?@orca_title,#{@orca_title},#{pane_title}},}}"; else v="${VIEW_PREFIX}\${w#@}"; t="#{?@orca_title,#{@orca_title},#{pane_title}}"; fi`,
  'tmux has-session -t "=$v" 2>/dev/null || tmux new-session -d -t "=$s" -s "$v" || exit 1',
  'tmux set -t "$v" status off \\; set -t "$v" bell-action none \\; set -t "$v" set-titles on \\; set -t "$v" set-titles-string "$t" \\; set-hook -t "$v" session-window-changed "select-window -t =$v:$w" \\; select-window -t "=$v:$w" || exit 1',
  // A pane tab's client gets its own active pane (tmux >= 3.2 "active-pane"), so typing and Orca's
  // prompt sends reach that pane and the user's other clients keep their active pane.
  'ap=""; [ -n "$p" ] && tmux -V | awk \'{split($2,a,"."); exit !(a[1]>3 || (a[1]==3 && a[2]+0>=2))}\' && ap="-f active-pane"',
  // The pane is picked by a client-attached hook: only a command run in the client's own context
  // moves its independent active pane (a select-pane from outside moves the shared one).
  'if [ -n "$ap" ]; then tmux set-hook -t "$v" client-attached "select-pane -t $p"; exec tmux attach-session -f active-pane -t "=$v" \\; set -t "$v" destroy-unattached on; fi',
  // tmux < 3.2: no per-client pane; select it in the window so input at least starts there.
  'if [ -n "$p" ]; then tmux select-pane -t "$p"; fi',
  'exec tmux attach-session -t "=$v" \\; set -t "$v" destroy-unattached on'
].join('; ')

export function attachCommand(session, windowId, paneId = null) {
  return `sh -c ${shq(SCRIPT)} _ ${shq(session)} ${shq(windowId)} ${shq(paneId ?? '')}`
}

export const unitViewName = (windowId, paneId) =>
  paneId ? `${PANE_VIEW_PREFIX}${paneId.slice(1)}` : `${VIEW_PREFIX}${windowId.slice(1)}`
