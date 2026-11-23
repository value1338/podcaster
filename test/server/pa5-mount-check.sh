#!/bin/bash
set -eu
mountdir=$(mktemp -d /tmp/pa5-mount-XXXXXX)
trap 'umount "$mountdir"; rmdir "$mountdir"' EXIT
mount -t tmpfs -o size=1100m,mode=0700 tmpfs "$mountdir"
chown "$SUDO_USER:$SUDO_USER" "$mountdir"
runuser -u "$SUDO_USER" -- env PATH="$PATH" PA5_MOUNT="$mountdir" node_modules/.bin/vitest run test/server/platform-pa5.test.mjs --no-file-parallelism
