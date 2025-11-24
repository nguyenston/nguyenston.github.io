---
title: "Configuring Split Tunneling and Killswitches for Docker with Tailscale Exit Nodes"
published: 2025-07-29
description: How to route specific Docker containers through a VPN killswitch while letting others bypass the Tailscale Exit Node.
tags: [tailscale,linux,networking]
category: Technical
draft: false
---

When using a Tailscale Exit Node, the default behavior routes all traffic from your device—and usually its containers—through the VPN. While great for privacy, this creates a problem in a Docker environment where you often have mixed requirements:

1.  **High-Security Containers** (e.g., torrent clients, privacy tools): Must communicate *only* through the VPN. If the tunnel drops, they must cut connectivity instantly (Killswitch).
2.  **High-Reliability Containers** (e.g., Plex, game servers, banking): Must bypass the VPN entirely. Many services strictly block known VPN IP addresses, and routing high-bandwidth local traffic through a remote exit node is inefficient.

This guide details a bash script that configures `iptables` to enforce these policies based solely on Docker subnet ranges.

## 1. The Network Architecture

We assume two distinct Docker networks. In this example:
* **Killswitch Subnet (`172.18.0.0/16`)**: Traffic is forced through `tailscale0`. If the interface is down, traffic is dropped.
* **Bypass Subnet (`172.19.0.0/16`)**: Traffic is marked to bypass the Tailscale routing table, exiting directly via the default gateway.

## 2. The Script Breakdown

### 2.1. The Bypass Rules (Split Tunneling)
To bypass the VPN, we need to identify traffic from the specific Docker subnet and force it out the physical interface (`eth0`). We achieve this by stamping packets with a specific Firewall Mark (`0x80000`) that triggers a special exception in the Linux kernel routing tables.

**Crucial Step:** We must explicitly **exclude** internal Tailscale traffic from this mark. If we mistakenly bypass traffic destined for Tailscale's CGNAT range (`100.64.0.0/10`), we break MagicDNS and peer-to-peer connectivity.

```bash
# Create a new chain
sudo iptables -t mangle -N DOCKER_BYPASS_EXCLUSIONS

# 1. EXCLUSIONS: PREVENT BYPASS
# RETURN (stop processing) for Tailscale CGNAT.
# This ensures MagicDNS and peer traffic stay in the tunnel.
sudo iptables -t mangle -A DOCKER_BYPASS_EXCLUSIONS -d 100.64.0.0/10 -j RETURN

# RETURN for localhost
sudo iptables -t mangle -A DOCKER_BYPASS_EXCLUSIONS -d 127.0.0.0/8 -j RETURN

# 2. MARKING: THE ESCAPE
# Mark remaining traffic with 0x80000.
# This specific mark tells the kernel to use the main routing table.
sudo iptables -t mangle -A DOCKER_BYPASS_EXCLUSIONS -j MARK --set-mark "0x80000"

# Apply to the Bypass Subnet
sudo iptables -t mangle -I PREROUTING 1 -s "172.19.0.0/16" -j DOCKER_BYPASS_EXCLUSIONS
```

### 2.2. The Killswitch Rules
For the "Secure" subnet, we use the `DOCKER-USER` chain to filter traffic before it leaves the host.

1.  **Masquerade**: We NAT outbound traffic so it appears to come from the Tailscale IP.
2.  **Drop Leakage**: We immediately drop any traffic from this subnet that is *not* destined for the `tailscale0` interface. This effectively kills connectivity if the VPN goes down.

```bash
# Masquerade outbound VPN traffic
sudo iptables -t nat -A POSTROUTING -s "172.18.0.0/16" -o tailscale0 -j MASQUERADE

# Killswitch: Drop if not using the VPN interface
sudo iptables -t filter -I DOCKER-USER -s "172.18.0.0/16" ! -o tailscale0 -j DROP

# Allow intra-subnet communication
sudo iptables -I DOCKER-USER -s "172.18.0.0/16" -d "172.18.0.0/16" -j ACCEPT
```

## 3. Deep Dive into the Bypass Logic

Why does the mark `0x80000` allow traffic to escape the VPN?

We are effectively "hijacking" Tailscale's own loop-avoidance mechanism. When Tailscale encrypts a packet, it needs to send that encrypted packet out the physical internet connection. To prevent the kernel from routing that packet *back* into the VPN tunnel (creating an infinite loop), Tailscale tags its own traffic with `0x80000`.

We can see this mechanism in the Linux routing rules (`ip rule show`):

```bash
$ ip rule show
0:      from all lookup local
5210:   from all fwmark 0x80000/0xff0000 lookup main  <-- 1. THE ESCAPE HATCH
...
5270:   from all lookup 52                            <-- 2. THE TAILSCALE TRAP
```

1.  **The Tailscale Trap (Rule 5270):**
    By default, Tailscale captures all traffic and sends it to **Table 52**. If we inspect this table, we see the "trap" in action:
    ```bash
    $ ip route show table 52
    default dev tailscale0  <-- THE TRAP
    throw 10.0.0.0/24       <-- Exceptions for local LAN
    ...
    ```
    The `default dev tailscale0` line forces any packet hitting this table to go through the VPN.

2.  **The Escape Hatch (Rule 5210):**
    This rule exists to let Tailscale's own traffic out. It says: *"If a packet has mark `0x80000`, look up the **main** table instead."*
    If we inspect the Main table, we see the normal internet path:
    ```bash
    $ ip route show table main
    default via 10.0.0.1 dev eth0  <-- THE ESCAPE
    10.0.0.0/24 dev eth0 ...
    ```

By manually applying this same VIP badge to our Docker packets, we trick the kernel into treating them like Tailscale's internal transport traffic—skipping the VPN queue entirely and exiting via your ISP.

## 4. Full Implementation

Save the following as `route_tailscale-net.sh`. Adjust the `BYPASS_SUBNET` and `KILLSWITCH_SUBNET` variables to match your Docker network configuration.

```bash
#!/bin/bash
set -e

# --- Configuration ---
# Subnet that will bypass the VPN and use the local WAN (High Reliability)
BYPASS_SUBNET="172.19.0.0/16"
# Subnet that forces traffic through the VPN or drops it (High Security)
KILLSWITCH_SUBNET="172.18.0.0/16"

# The specific FWMARK that triggers Tailscale's "Escape Hatch" (Rule 5210).
BYPASS_MARK="0x80000"

# Tailscale's internal IP range (CGNAT). Traffic destined here must NOT
# be bypassed, or internal DNS (MagicDNS) and peer-to-peer traffic will break.
TAILSCALE_CGNAT="100.64.0.0/10"

# --- Functions ---
cleanup() {
    echo "Removing exit node bypass rule for $BYPASS_SUBNET..."
    sudo iptables -t mangle -D PREROUTING -s "$BYPASS_SUBNET" -j DOCKER_BYPASS_EXCLUSIONS
    sudo iptables -t mangle -F DOCKER_BYPASS_EXCLUSIONS
    sudo iptables -t mangle -X DOCKER_BYPASS_EXCLUSIONS
    
    echo "Removing exit node bypass rule for $KILLSWITCH_SUBNET..."
    sudo iptables -t nat -D POSTROUTING -s "$KILLSWITCH_SUBNET" -o tailscale0 -j MASQUERADE
    sudo iptables -t filter -D DOCKER-USER -s "$KILLSWITCH_SUBNET" ! -o tailscale0 -j DROP
    sudo iptables -D DOCKER-USER -s "$KILLSWITCH_SUBNET" -d "$KILLSWITCH_SUBNET" -j ACCEPT
    echo "Cleanup complete."
    exit 0
}

setup() {
    # --- Part 1: Split Tunneling (Bypass) ---
    echo "Setting up exit node bypass for $BYPASS_SUBNET..."
    
    # We create a custom chain to handle the logic for what gets marked.
    sudo iptables -t mangle -N DOCKER_BYPASS_EXCLUSIONS

    # 1. EXCLUSIONS: PREVENT BYPASS FOR INTERNAL TRAFFIC
    # We exclude the entire Tailscale CGNAT range (100.64.0.0/10).
    # This automatically covers MagicDNS, DERP servers, and all other Tailscale peers.
    sudo iptables -t mangle -A DOCKER_BYPASS_EXCLUSIONS -d "$TAILSCALE_CGNAT" -j RETURN
    
    # Local loopback (localhost) must also remain internal.
    sudo iptables -t mangle -A DOCKER_BYPASS_EXCLUSIONS -d 127.0.0.0/8 -j RETURN
    
    # 2. MARKING: TRIGGER THE ESCAPE
    # Any packet that survived the exclusions above is destined for the public internet.
    # We mark it with 0x80000 to hit Linux Rule 5210.
    sudo iptables -t mangle -A DOCKER_BYPASS_EXCLUSIONS -j MARK --set-mark "$BYPASS_MARK"

    # Apply this chain to all traffic originating from the Bypass Subnet
    sudo iptables -t mangle -I PREROUTING 1 -s "$BYPASS_SUBNET" -j DOCKER_BYPASS_EXCLUSIONS
    
    echo "Bypass rule is active."
    
    # --- Part 2: Killswitch (Secure) ---
    echo "Setting up exit node killswitch for $KILLSWITCH_SUBNET..."
    
    # 1. MASQUERADE: ensure outgoing traffic looks like it comes from the VPN IP
    sudo iptables -t nat -A POSTROUTING -s "$KILLSWITCH_SUBNET" -o tailscale0 -j MASQUERADE
    
    # 2. DROP LEAKS: The Killswitch
    # If traffic from this subnet tries to leave via ANY interface that is NOT tailscale0, drop it.
    sudo iptables -t filter -I DOCKER-USER -s "$KILLSWITCH_SUBNET" ! -o tailscale0 -j DROP
    
    # 3. ALLOW LOCAL: Allow containers in the secure subnet to talk to each other
    sudo iptables -I DOCKER-USER -s "$KILLSWITCH_SUBNET" -d "$KILLSWITCH_SUBNET" -j ACCEPT
    
    echo "Killswitch rule is active."
}

# --- Main Logic ---
if [[ "$1" == "cleanup" ]]; then
    cleanup
else
    setup
fi
```

### 4.1. Usage

1.  **Run Setup**: `sudo ./route_tailscale-net.sh`
2.  **Verify**: Check your container's external IP.
    * Containers in the Killswitch subnet should report the Exit Node's IP.
    * Containers in the Bypass subnet should report your ISP's WAN IP.
3.  **Cleanup**: `sudo ./route_tailscale-net.sh cleanup`
