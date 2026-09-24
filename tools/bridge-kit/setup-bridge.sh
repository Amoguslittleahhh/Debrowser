#!/usr/bin/env bash
#
# Turn a fresh Debian or Ubuntu server into a private Tor bridge for Debrowser.
#
#     curl -O .../setup-bridge.sh      # or copy it over
#     sudo bash setup-bridge.sh [--port 443] [--hide-timing]
#
# It prints one line at the end. Paste that line into Debrowser:
# Settings > Private windows > My bridges, and set "Connect to Tor" to
# "Through my own bridges".
#
# Why your own: the built-in bridges are published, so an ISP that compares
# addresses against the list can still tell you are using Tor. This bridge is
# never published anywhere - `BridgeDistribution none` keeps it out of every
# list the Tor Project hands out - so the only people who know its address are
# you and whoever you give the line to.
#
# What it is: an obfs4 bridge. To anyone watching, connections to it look like
# random bytes to an ordinary server. `--hide-timing` turns on obfs4's
# inter-arrival-time mode, which also varies packet timing and sizes to blur
# what traffic analysis can learn - at a real cost in speed, so it is opt-in.
#
# What it costs you: a small server (the cheapest tier anywhere is plenty) and
# its provider knowing that its customer runs a Tor bridge. It does not carry
# anyone else's traffic and it is not an exit: nothing leaves the Tor network
# from here.
#
# Safe to run again: it rewrites the same config and prints the same line.

set -euo pipefail

PORT=443
IAT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --hide-timing) IAT=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo bash $0)." >&2
  exit 1
fi
if ! command -v apt-get >/dev/null; then
  echo "This script is for Debian or Ubuntu." >&2
  exit 1
fi

echo "== Installing Tor and the obfs4 transport"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# lyrebird is the maintained obfs4 implementation; older releases only have obfs4proxy.
if apt-cache show lyrebird >/dev/null 2>&1; then PT=lyrebird; else PT=obfs4proxy; fi
apt-get install -y -qq tor "$PT" >/dev/null
PT_BIN="$(command -v "$PT")"

# The ORPort only has to be reachable by Tor itself; it is not what clients use.
OR_PORT=9001

echo "== Writing /etc/tor/torrc"
cat > /etc/tor/torrc <<TORRC
# Written by Debrowser's setup-bridge.sh. A private obfs4 bridge.
BridgeRelay 1
# IPv4 only: plenty of small servers have no IPv6, and an ORPort that tries to
# listen on both fails outright there. Clients reach the bridge on obfs4 anyway.
ORPort ${OR_PORT} IPv4Only
# A bridge is not a client: no SOCKS port.
SocksPort 0
# Said outright: the package's service sets this for Tor, but run without
# systemd Tor would put everything under ~/.tor and this script would never
# find the bridge line it is waiting for.
DataDirectory /var/lib/tor
ServerTransportPlugin obfs4 exec ${PT_BIN}
ServerTransportListenAddr obfs4 0.0.0.0:${PORT}
ServerTransportOptions obfs4 iat-mode=${IAT}
ExtORPort auto
# Never handed out by the Tor Project: the whole point.
BridgeDistribution none
PublishServerDescriptor 0
# At most 19 characters, letters and digits only - Tor refuses anything longer.
Nickname DbPrivate$((RANDOM % 9000 + 1000))
# No exit traffic, ever. (ExitRelay rather than an ExitPolicy: a bridge with
# an exit policy configured draws a warning, and this says the same thing.)
ExitRelay 0
Log notice syslog
TORRC

# Binding a port under 1024 needs the capability; systemd's unit usually
# grants it, but say so rather than fail silently if it does not.
if [ "$PORT" -lt 1024 ] && command -v setcap >/dev/null; then
  setcap 'cap_net_bind_service=+ep' "$PT_BIN" || true
fi

if command -v ufw >/dev/null && ufw status | grep -q active; then
  echo "== Opening port ${PORT} in ufw"
  ufw allow "${PORT}/tcp" >/dev/null
fi

echo "== Restarting Tor"
if [ -d /run/systemd/system ]; then
  systemctl enable --now tor >/dev/null 2>&1 || true
  systemctl restart tor
else
  # No systemd - a container, or a minimal VPS image. Run Tor as its own
  # unprivileged user, the way the package's service would.
  pkill -x tor 2>/dev/null || true
  # Wait for it to let go of its ports, or the new one cannot bind them.
  for _ in $(seq 1 50); do pgrep -x tor >/dev/null || break; sleep 0.1; done
  install -d -o debian-tor -g debian-tor -m 700 /var/lib/tor
  runuser -u debian-tor -- tor -f /etc/tor/torrc --RunAsDaemon 1 --Log "notice file /var/lib/tor/notices.log"
fi

LINE_FILE=/var/lib/tor/pt_state/obfs4_bridgeline.txt
for _ in $(seq 1 60); do
  [ -s "$LINE_FILE" ] && [ -s /var/lib/tor/fingerprint ] && break
  sleep 1
done
if [ ! -s "$LINE_FILE" ]; then
  echo "Tor did not write its bridge line. Check: journalctl -u tor" >&2
  exit 1
fi

ADDR="$(curl -4 -s --max-time 10 https://icanhazip.com || hostname -I | awk '{print $1}')"
FPR="$(awk '{print $2}' /var/lib/tor/fingerprint)"
CERT="$(grep -o 'cert=[^ ]*' "$LINE_FILE")"
LINE="obfs4 ${ADDR}:${PORT} ${FPR} ${CERT} iat-mode=${IAT}"

echo
echo "Your bridge line - paste it into Debrowser, Settings > Private windows > My bridges:"
echo
echo "  ${LINE}"
echo
if command -v qrencode >/dev/null; then
  qrencode -t ansiutf8 "${LINE}"
else
  echo "(apt-get install qrencode, then run this again, for a QR code of the same line.)"
fi
echo "Keep it to yourself: anyone with this line can use the bridge, and knows it is one."
