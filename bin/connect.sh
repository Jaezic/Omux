#!/bin/sh
# Open a persistent ssh master for a password-auth host so the sync can reuse it.
# usage: connect.sh <host>    (prompts for the password once)
#        connect.sh -x <host> (close it)
mkdir -p "$HOME/.orca-tmux/.cm"
if [ "$1" = "-x" ]; then
  exec ssh -o ControlPath="$HOME/.orca-tmux/.cm/%C" -O exit "$2"
fi
exec ssh -fN -o ControlMaster=yes -o ControlPersist=yes -o ControlPath="$HOME/.orca-tmux/.cm/%C" "$1"
