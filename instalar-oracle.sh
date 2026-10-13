#!/bin/bash
# Instalación automática de Recorridas en un servidor Ubuntu (Oracle Cloud Always Free).
# Se pega como "script de inicialización" (cloud-init) al crear el servidor: corre solo una vez, al primer arranque.
# El avance queda en /var/log/recorridas-instalacion.log

# ======== DATOS A COMPLETAR ========
REPO="https://github.com/USUARIO_GITHUB/recorridas.git"
ADMIN_USER="plateroadmin"
ADMIN_PASS="CAMBIAR"
VENDOR_USER="msayago"
VENDOR_PASS="CAMBIAR"
# ===================================

set -euo pipefail
exec >>/var/log/recorridas-instalacion.log 2>&1
echo "=== Inicio de la instalación: $(date) ==="
export DEBIAN_FRONTEND=noninteractive
SIMULAR="${SIMULAR:-0}"   # 1 = prueba sin systemd ni firewall

APP_DIR=/opt/recorridas/app
REPO_DIR=/opt/recorridas/repo
DATA_DIR=/var/lib/recorridas

# 1. Memoria extra (swap) para servidores de 1 GB
if [ "$SIMULAR" != 1 ] && [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 2. Programas necesarios: Node.js 22, Caddy (HTTPS automático), git, sqlite3
apt-get update
apt-get install -y curl ca-certificates gnupg git sqlite3 build-essential python3
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  if curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource.sh && bash /tmp/nodesource.sh; then
    apt-get install -y nodejs
  else
    apt-get install -y nodejs npm   # alternativa: Node.js de Ubuntu
  fi
fi
command -v caddy >/dev/null || apt-get install -y caddy

# 3. Usuario del sistema, código y dependencias
id recorridas >/dev/null 2>&1 || useradd --system --home /opt/recorridas --shell /usr/sbin/nologin recorridas
mkdir -p "$DATA_DIR" /var/backups/recorridas /opt/recorridas

# Ordena el código en carpetas (funciona aunque en GitHub los archivos hayan quedado todos sueltos)
cat > /usr/local/bin/organizar-recorridas <<'ORG'
#!/bin/bash
set -euo pipefail
SRC=/opt/recorridas/repo
DST=/opt/recorridas/app
mkdir -p "$DST/lib" "$DST/public"
buscar() { # busca un archivo en la raíz o en su carpeta
  for c in "$SRC/$2/$1" "$SRC/$1" "$SRC/recorridas/$2/$1" "$SRC/recorridas/$1"; do [ -f "$c" ] && { echo "$c"; return; }; done
  echo "Falta el archivo $1 en el repositorio" >&2; exit 1
}
for f in server.js package.json package-lock.json; do cp "$(buscar $f .)" "$DST/$f"; done
for f in db.js fotos.js geo.js geocode.js time.js excel.js; do cp "$(buscar $f lib)" "$DST/lib/$f"; done
for f in app.html app.js comun.js estilos.css login.html panel.html panel.js icono.svg manifest.webmanifest; do cp "$(buscar $f public)" "$DST/public/$f"; done
ORG
chmod 755 /usr/local/bin/organizar-recorridas

if [ -d "$REPO_DIR/.git" ]; then git -C "$REPO_DIR" pull --ff-only; else rm -rf "$REPO_DIR"; git clone --depth 1 "$REPO" "$REPO_DIR"; fi
/usr/local/bin/organizar-recorridas
cd "$APP_DIR"
npm ci --omit=dev
chown -R recorridas:recorridas /opt/recorridas "$DATA_DIR"

# 4. Configuración (contraseñas iniciales: solo se usan la primera vez)
cat > /etc/recorridas.env <<EOF
NODE_ENV=production
PORT=3000
DATA_DIR=$DATA_DIR
ADMIN_USER=$ADMIN_USER
ADMIN_PASS=$ADMIN_PASS
VENDOR_USER=$VENDOR_USER
VENDOR_PASS=$VENDOR_PASS
EOF
chmod 600 /etc/recorridas.env

# 5. Dirección web con HTTPS: <ip-con-guiones>.sslip.io
IP=$(curl -fsS --max-time 10 https://api.ipify.org || curl -fsS --max-time 10 https://ifconfig.me || curl -fsS --max-time 10 https://icanhazip.com || echo "${IP_PRUEBA:-}")
IP=$(echo "$IP" | tr -d "[:space:]")
[ -n "$IP" ] || { echo "No se pudo averiguar la IP pública"; exit 1; }
DOMINIO="${IP//./-}.sslip.io"
cat > /etc/caddy/Caddyfile <<EOF
$DOMINIO {
	encode gzip
	request_body {
		max_size 25MB
	}
	reverse_proxy 127.0.0.1:3000
}
EOF
echo "https://$DOMINIO" > /root/recorridas-direccion.txt

# 6. Servicio que arranca solo y se reinicia si falla
cat > /etc/systemd/system/recorridas.service <<EOF
[Unit]
Description=Recorridas
After=network-online.target
Wants=network-online.target

[Service]
User=recorridas
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/recorridas.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# 7. Copia de seguridad diaria de la base (se guardan 30 días)
cat > /etc/cron.daily/recorridas-backup <<EOF
#!/bin/sh
sqlite3 $DATA_DIR/recorridas.db ".backup /var/backups/recorridas/recorridas-\$(date +%F).db"
find /var/backups/recorridas -name 'recorridas-*.db' -mtime +30 -delete
EOF
chmod 755 /etc/cron.daily/recorridas-backup

# 8. Comando para actualizar el sistema cuando haya una versión nueva en GitHub
cat > /usr/local/bin/actualizar-recorridas <<EOF
#!/bin/sh
set -e
sudo -u recorridas git -C $REPO_DIR pull --ff-only
/usr/local/bin/organizar-recorridas
cd $APP_DIR && npm ci --omit=dev
chown -R recorridas:recorridas /opt/recorridas
systemctl restart recorridas
echo "Recorridas actualizado."
EOF
chmod 755 /usr/local/bin/actualizar-recorridas
git config --system --add safe.directory "$REPO_DIR"

if [ "$SIMULAR" = 1 ]; then echo "=== Simulación terminada: $DOMINIO ==="; exit 0; fi

# 9. Firewall del servidor: abrir puertos web 80 y 443
iptables -I INPUT -p tcp -m multiport --dports 80,443 -m state --state NEW -j ACCEPT
if command -v netfilter-persistent >/dev/null; then netfilter-persistent save; fi

systemctl daemon-reload
systemctl enable --now recorridas
systemctl restart caddy
echo "=== Instalación terminada: https://$DOMINIO ($(date)) ==="
