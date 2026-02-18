#!/bin/bash
set -e

# Block access to private/LAN networks (RFC1918 + link-local).
# Public internet (HTTP/HTTPS, SSH, DNS, etc.) remains fully accessible.
# Add ACCEPT rules above the DROPs to whitelist specific LAN services.
iptables -A OUTPUT -d 10.0.0.0/8 -j DROP
iptables -A OUTPUT -d 172.16.0.0/12 -j DROP
iptables -A OUTPUT -d 192.168.0.0/16 -j DROP
iptables -A OUTPUT -d 169.254.0.0/16 -j DROP

# Disable IPv6 to prevent LAN access via link-local/ULA addresses
sysctl -w net.ipv6.conf.all.disable_ipv6=1 2>/dev/null || true

# Drop NET_ADMIN so the app process can't undo the rules
exec setpriv --no-new-privs --bounding-set=-net_admin,-net_raw -- "$@"
