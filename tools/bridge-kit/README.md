# A Tor bridge of your own

Debrowser's private windows reach Tor through **bridges** by default, so your
internet provider cannot see that you use Tor by looking at the traffic. The
built-in bridges are published by the Tor Project, though, and a provider
that compares addresses against that list can still tell.

A bridge of your own is on no list. The only people who know its address are
you and whoever you give it to. It is the one setup in which your provider sees
encrypted traffic to an ordinary server and nothing else.

## What you need

- A small Debian or Ubuntu server anywhere: the cheapest tier from any
  provider is plenty. The provider will know its customer runs a Tor bridge.
  It carries only your own traffic, and it is not an exit: nothing leaves the
  Tor network from it.
- Root on that server.

## Set it up

```sh
sudo bash setup-bridge.sh                # obfs4 on port 443
sudo bash setup-bridge.sh --port 8443    # another port, if 443 is taken
sudo bash setup-bridge.sh --hide-timing  # slower, harder to analyse
```

It installs Tor and the obfs4 transport, writes a bridge configuration that is
never published (`BridgeDistribution none`, `PublishServerDescriptor 0`), starts
Tor, and prints one line:

```
obfs4 203.0.113.5:443 9A1B…4567 cert=kR3x…fG6hJ iat-mode=0
```

In Debrowser: **Settings → Private windows**, set *Connect to Tor* to *Through
my own bridges*, and paste the line into *My bridges*. The next private window
connects through it; its connection page says `obfs4` once connected.

Running the script again is safe: it prints the same line.

## `--hide-timing`

obfs4's inter-arrival-time mode varies packet sizes and timing between you and
the bridge, which blurs what traffic analysis can learn from them. It costs
real speed, and it is partial: nothing deployed today fully stops an observer
who studies timing. That is why it is off unless asked for.

## Tested

The script was run end to end on Ubuntu 24.04 without systemd (a container),
which found four problems now fixed: a nickname one character over Tor's
limit, an IPv6 listener on an IPv4-only host, a leftover client SOCKS port, and
Tor's files landing under `~/.tor` without systemd's defaults. Debrowser's own
Tor then completed the obfs4 handshake with the bridge it produced and began
loading the network directory through it.
