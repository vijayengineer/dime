#!/usr/bin/env bash
# Idempotent server preparation for DIME. Run as root ONLY after reviewing it.
# Does not touch other services (e.g. Cathena), does not reload nginx, and never handles keys.
set -euo pipefail
id dime >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/dime --shell /usr/sbin/nologin dime
install -d -o dime -g dime -m 750 /opt/dime/app /opt/dime/app/backend/data
install -d -o root -g dime -m 750 /etc/dime
install -d -o root -g dime -m 750 /etc/dime/keys
command -v node >/dev/null || { echo "node >= 20 is required (not installed); install it first"; exit 1; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || { echo "node >= 20 required"; exit 1; }
install -m 644 deploy/systemd/dime-*.service /etc/systemd/system/
systemctl daemon-reload
[ -f /etc/nginx/sites-available/dime.conf ] || install -m 644 deploy/nginx/dime.conf /etc/nginx/sites-available/dime.conf
echo "Prepared. Next (manual): place key files in /etc/dime/keys (owner root:dime, mode 640),"
echo "write /etc/dime/backend.env, enable nginx site, run certbot, then: systemctl enable --now dime-pricing dime-api dime-keeper dime-watchdog"
