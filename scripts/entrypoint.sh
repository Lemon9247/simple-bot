#!/bin/bash
set -e

# ─── LAN Isolation ──────────────────────────────────────────
# Block access to private networks (RFC1918 + link-local) so the
# agent can't reach LAN services.  Requires NET_ADMIN capability
# (dropped after rules are applied).
#
# Set NEST_LAN_ALLOW to a comma-separated list of addresses/CIDRs
# to whitelist specific LAN services before the blanket block.
#   e.g. NEST_LAN_ALLOW="172.30.0.10,192.168.1.50/32"
#
# Set NEST_NO_FIREWALL=1 to skip all iptables rules.

if [ "${NEST_NO_FIREWALL:-}" != "1" ]; then
    # Allow responses to established connections
    iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

    # Allow specific LAN addresses
    if [ -n "${NEST_LAN_ALLOW:-}" ]; then
        IFS=',' read -ra ADDRS <<< "$NEST_LAN_ALLOW"
        for addr in "${ADDRS[@]}"; do
            addr="$(echo "$addr" | xargs)"  # trim whitespace
            [ -n "$addr" ] && iptables -A OUTPUT -d "$addr" -j ACCEPT
        done
    fi

    # Block all private/LAN networks
    iptables -A OUTPUT -d 10.0.0.0/8 -j DROP
    iptables -A OUTPUT -d 172.16.0.0/12 -j DROP
    iptables -A OUTPUT -d 192.168.0.0/16 -j DROP
    iptables -A OUTPUT -d 169.254.0.0/16 -j DROP

    # Disable IPv6 to prevent LAN access via link-local/ULA
    sysctl -w net.ipv6.conf.all.disable_ipv6=1 2>/dev/null || true
fi

# ─── Drop Capabilities ─────────────────────────────────────
# NET_ADMIN was only needed for iptables setup above.
exec setpriv --no-new-privs --bounding-set=-net_admin,-net_raw -- "$@"
