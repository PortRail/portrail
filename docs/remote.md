# Remote access

By default Portrail listens on `127.0.0.1` only. To reach it from elsewhere you have three
options, and the right one depends on where the machine is.

## A laptop behind NAT — use a tunnel

Port forwarding is the wrong answer for a laptop: it breaks the moment the machine moves,
sleeps, or gets a new IP, and it opens a hole in your home network. A tunnel makes an
**outbound** connection and hands you a public HTTPS URL.

```sh
portrail start --tunnel cloudflare
```

```
Opening cloudflare tunnel… https://random-words.trycloudflare.com
Waiting for DNS to propagate… reachable.
Portrail 0.1.0 listening on http://127.0.0.1:7431
  public:  https://random-words.trycloudflare.com  (cloudflare tunnel — API keys still required)
```

`cloudflared` is free; `brew install cloudflared`. A named Cloudflare tunnel gives a
permanent hostname instead of a random one. `--tunnel ngrok` and `--tunnel tailscale` work
the same way. `portrail doctor` shows which tools you have.

Keep the laptop awake: `caffeinate -s` while it runs, or turn off sleep on power.

## A VPS — bind an interface behind TLS

```json
// ~/.portrail/config.json
{
  "listen": { "host": "0.0.0.0", "port": 7431 },
  "tls": {
    "cert": "/etc/letsencrypt/live/box.example.com/fullchain.pem",
    "key": "/etc/letsencrypt/live/box.example.com/privkey.pem"
  }
}
```

Or keep Portrail on loopback and put Caddy or nginx in front:

```
# Caddyfile
box.example.com {
  reverse_proxy 127.0.0.1:7431 {
    flush_interval -1      # server-sent events must not be buffered
  }
}
```

Portrail refuses to bind beyond loopback without TLS. `--insecure` overrides that for a
network you trust completely; API keys travel in the clear.

## Keep it running

```sh
portrail service install --tunnel cloudflare   # macOS launchd or Linux systemd (user)
portrail service status
portrail service uninstall
```

On a Linux server, `loginctl enable-linger $USER` keeps user services running after
logout.

## Make.com recipe

1. In Make, add an **HTTP → Make a request** module.
2. URL: `https://your-tunnel-or-host/v1/runs`. Method: `POST`.
3. Headers: `Authorization: Bearer prt_…` and `Content-Type: application/json`.
4. Body type: Raw, JSON:
   ```json
   { "agent": "codex", "workspace": "my-app", "prompt": "{{1.text}}", "wait": 40 }
   ```
   `wait: 40` keeps the response inside Make's request timeout. Most runs take longer
   than that, so:
5. Add a second HTTP module: `GET https://your-host/v1/runs/{{2.id}}` with the same
   `Authorization` header, inside a **Repeater** with a **Sleep** of 15 s, until
   `state` is one of `succeeded`, `failed`, `cancelled`, `outcome_unknown`.
6. Use `{{3.summary}}` downstream.

Portrail Pro removes step 5: pass `"callback": "https://hook.make.com/…"` and the result
is POSTed to you when the run ends. Pro's relay mode also removes the tunnel: the laptop
connects out to a relay on your VPS, and Make talks to the relay. Pro has to be installed
on the laptop for that — the relay is only the public address.

Give Make its own key with only `runs:write` and `runs:read`, and an expiry:

```sh
portrail key create make --scopes runs:write,runs:read --expires 90
```
