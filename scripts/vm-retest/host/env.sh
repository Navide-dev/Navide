#!/bin/bash
# env.sh: shared settings for the host-side VM re-test scripts. Source it; every value can be overridden from the
# environment (or a file named by VM_RETEST_ENV), so nothing here is specific to one machine.
#
#   VM_HOST           empty = VMware Fusion runs on this machine; otherwise an ssh destination (user@mac-mini) that
#                     runs vmrun, and that the guests are reached through (ProxyJump)
#   VM_DIR            folder that holds the .vmwarevm bundles
#   LINUX_VMX / WINDOWS_VMX              the two VMs
#   LINUX_SNAPSHOT / WINDOWS_SNAPSHOT    the snapshot every round starts from and is reverted to
#   LINUX_GUEST / WINDOWS_GUEST          guest address; empty = ask vmrun getGuestIPAddress
#   LINUX_USER / WINDOWS_USER            test account in the guest (never a real person's account)
#   SSH_KEY           key the test accounts accept; the guests hold no other credential
#   VMRUN             vmrun binary on the VM host
#   The guest working folder is always ~/wh (several guest scripts assume it).
[ -n "${VM_RETEST_ENV:-}" ] && [ -f "$VM_RETEST_ENV" ] && . "$VM_RETEST_ENV"

VM_HOST="${VM_HOST:-}"
VM_DIR="${VM_DIR:-$HOME/Virtual Machines.localized}"
LINUX_VMX="${LINUX_VMX:-$VM_DIR/Ubuntu 24.04 arm64.vmwarevm/Ubuntu 24.04 arm64.vmx}"
WINDOWS_VMX="${WINDOWS_VMX:-$VM_DIR/Windows 11 ARM64 navide.vmwarevm/Windows 11 ARM64 navide.vmx}"
LINUX_SNAPSHOT="${LINUX_SNAPSHOT:-pre-navide-0.2.13}"
WINDOWS_SNAPSHOT="${WINDOWS_SNAPSHOT:-installed-clean-updated}"
LINUX_GUEST="${LINUX_GUEST:-}"
WINDOWS_GUEST="${WINDOWS_GUEST:-}"
LINUX_USER="${LINUX_USER:-navide}"
WINDOWS_USER="${WINDOWS_USER:-navide}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/navide_vm_ed25519}"
VMRUN="${VMRUN:-/Applications/VMware Fusion.app/Contents/Library/vmrun}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUEST_DIR="$(cd "$HERE/../guest" && pwd)"

# ssh options for throwaway test guests: their host keys change on every snapshot revert
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o ControlMaster=no -o ControlPath=none -o StrictHostKeyChecking=no
          -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o IdentitiesOnly=yes -i "$SSH_KEY")
[ -n "$VM_HOST" ] && SSH_OPTS+=(-o "ProxyJump=$VM_HOST")

die() { echo "vm-retest: $*" >&2; exit 1; }
need_platform() { case "$1" in linux|windows) ;; *) die "first argument is linux or windows" ;; esac; }

# vmrun on the VM host (local, or over ssh). Its output is never piped: a pipe that closes early can take a
# `vmrun start` down with it.
vmr() {
  if [ -z "$VM_HOST" ]; then "$VMRUN" -T fusion "$@"
  else ssh -o BatchMode=yes "$VM_HOST" "$(printf '%q ' "$VMRUN" -T fusion "$@")"; fi
}

vmx_of() { case "$1" in linux) echo "$LINUX_VMX" ;; windows) echo "$WINDOWS_VMX" ;; *) die "platform is linux or windows" ;; esac; }
snapshot_of() { case "$1" in linux) echo "$LINUX_SNAPSHOT" ;; windows) echo "$WINDOWS_SNAPSHOT" ;; esac; }
user_of() { case "$1" in linux) echo "$LINUX_USER" ;; windows) echo "$WINDOWS_USER" ;; esac; }

guest_of() {
  local p="$1" a
  case "$p" in linux) a="$LINUX_GUEST" ;; windows) a="$WINDOWS_GUEST" ;; esac
  # vmrun prints "Error: The VMware Tools are not running ..." on stdout while the guest boots: keep asking (up to
  # a minute) until the answer is an IPv4 address. A guest without VMware Tools never answers: set <PLATFORM>_GUEST
  local i; for i in $(seq 1 12); do
    [ -n "$a" ] && break
    a="$(vmr getGuestIPAddress "$(vmx_of "$p")" -wait 2>/dev/null | tr -d '\r')"
    printf '%s' "$a" | grep -Eq '^[0-9]+(\.[0-9]+){3}$' || { a=""; sleep 5; }
  done
  [ -n "$a" ] || die "no address for the $p guest (set $(echo "$p" | tr a-z A-Z)_GUEST or start the VM)"
  echo "$a"
}
