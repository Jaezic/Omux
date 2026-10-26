#!/bin/bash
# Log in to a host once and keep the connection as a shared ssh master.
# usage: login.sh <host>
# ssh reads the password from this terminal; nothing else sees or stores it.
host=$1
cm="$HOME/.orca-tmux/.cm"
mkdir -p "$cm"

# Orca types the startup command into the shell; drop any type-ahead so ssh's
# password prompt doesn't consume it.
sleep 1
while read -r -t 1 _; do :; done

echo "tmux 미러링을 위해 $host 에 로그인합니다. (한 번만 입력하면 연결이 유지됩니다)"
until ssh -fN -o ControlMaster=yes -o ControlPersist=yes -o ServerAliveInterval=15 \
  -o ControlPath="$cm/%C" "$host"; do
  echo "연결 실패 — Enter로 다시 시도"
  read -r _
done
echo "✓ 연결됨 (이 탭은 곧 닫힙니다)"
