#!/bin/bash
set -eu
p=$(mktemp -d /tmp/pa10-mount-XXXXXX)
trap 'umount "$p"; rmdir "$p"' EXIT
mount -t tmpfs -o size=1100m,mode=0700 tmpfs "$p"
chown "$SUDO_USER:$SUDO_USER" "$p"
runuser -u "$SUDO_USER" -- env PATH="$PATH" PA10_MOUNT="$p" node test/e2e/plattform-archiv.mjs
