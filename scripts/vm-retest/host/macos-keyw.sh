#!/bin/bash
# macos-keyw.sh <disk.img> <public key line> <user>: runs ON the VM host while the tart VM is off. Appends the public key
# to <user>'s authorized_keys inside the guest disk without booting it and without any password or sudo:
# attach the raw image unmounted, find the APFS container whose physical store is on that image, mount only its
# unencrypted "Data" volume (nobrowse), write the key (700/600), sync, unmount, detach. Prints key-ok on success.
set -u
img="$1"; pub="$2"; user="$3"
[ -f "$img" ] || { echo "no image $img"; exit 1; }
dev="$(hdiutil attach -imagekey diskimage-class=CRawDiskImage -nomount "$img" 2>/dev/null | awk 'NR==1{print $1}')"
[ -n "$dev" ] || { echo "attach failed"; exit 1; }
trap 'hdiutil detach "$dev" >/dev/null 2>&1 || diskutil eject "$dev" >/dev/null 2>&1' EXIT
d="${dev#/dev/}"
vol=""
for _ in $(seq 1 15); do
  # only containers synthesized from this image's partitions, never the host's own volumes
  for c in $(diskutil list | awk -v d="$d" '/^\/dev\/disk/{cur=$1} $0 ~ ("Physical Store " d "s[0-9]+$"){print cur}'); do
    for v in $(diskutil list "$c" | awk '/APFS Volume Data /{print $NF}'); do vol="$v"; done
  done
  [ -n "$vol" ] && break; sleep 2
done
[ -n "$vol" ] || { echo "no Data volume on $dev"; exit 1; }
info="$(diskutil info "$vol")"
echo "$info" | grep -Eq 'FileVault: +No' && echo "$info" | grep -Eq 'Locked: +No' || { echo "Data volume is encrypted or locked: stopping"; exit 1; }
diskutil mount -mountOptions nobrowse "$vol" >/dev/null || { echo "cannot mount $vol without sudo: stopping"; exit 1; }
mp="$(diskutil info "$vol" | sed -n 's/^ *Mount Point: *//p')"; h="$mp/Users/$user"
ok=1
if [ -d "$h" ]; then
  mkdir -p "$h/.ssh" && chmod 700 "$h/.ssh" &&
  { grep -qxF "$pub" "$h/.ssh/authorized_keys" 2>/dev/null || echo "$pub" >> "$h/.ssh/authorized_keys"; } &&
  chmod 600 "$h/.ssh/authorized_keys" && ok=0
else echo "no home $h"; fi
sync
diskutil unmount "$vol" >/dev/null || { echo "unmount failed"; exit 1; }
[ "$ok" = 0 ] && echo key-ok
