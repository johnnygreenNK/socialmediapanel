#!/usr/bin/env bash
# server-setup.sh — jednorazowa instalacja na czystym Debianie/Ubuntu
# Uruchom jako root: bash server-setup.sh
set -e

APP_DIR=/root/social-panel
SERVICE=social-panel

echo "=== [1/5] Node.js 22 ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

echo "=== [2/5] Google Chrome ==="
curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb
apt-get install -y /tmp/chrome.deb
rm /tmp/chrome.deb

echo "=== [3/5] Zależności systemowe Playwright ==="
apt-get install -y \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
  libxkbcommon0 libpango-1.0-0 libcairo2 libasound2 \
  fonts-liberation xdg-utils wget ca-certificates

echo "=== [4/5] Aplikacja ==="
mkdir -p "$APP_DIR"
cp -r . "$APP_DIR/"
cd "$APP_DIR"
npm ci --omit=dev

echo "=== [5/5] Usługa systemd ==="
cat > /etc/systemd/system/${SERVICE}.service <<EOF
[Unit]
Description=Social Panel Backend
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"

echo ""
echo "=== Gotowe! ==="
echo "Status: systemctl status $SERVICE"
echo "Logi:   journalctl -fu $SERVICE"
