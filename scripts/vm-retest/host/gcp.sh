#!/bin/bash
# gcp.sh <linux|windows> put <local files...>   copy files into the guest root
# gcp.sh <linux|windows> get <guest path> <local dir>   copy one file (or, with a trailing /, a folder) out of the guest root
set -u
. "$(dirname "$0")/env.sh"
p="${1:-}"; dir="${2:-}"; need_platform "$p"; shift 2 || die "usage: gcp.sh <linux|windows> put|get ..."
dest="$(user_of "$p")@$(guest_of "$p")"; r=wh
case "$dir" in
  put) scp -q "${SSH_OPTS[@]}" "$@" "$dest:$r/" ;;
  get) src="$1"; out="$2"
       case "$src" in */) scp -q -r "${SSH_OPTS[@]}" "$dest:$r/${src%/}" "$out/" ;; *) scp -q "${SSH_OPTS[@]}" "$dest:$r/$src" "$out/" ;; esac ;;
  *) die "usage: gcp.sh <linux|windows> put|get ..." ;;
esac
