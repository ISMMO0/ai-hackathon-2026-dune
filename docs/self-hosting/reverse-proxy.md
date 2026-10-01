# Reverse proxy (TLS)

TLS terminates at a reverse proxy in front of the app — documented, not
bundled. Caddy is the recommended proxy: automatic Let's Encrypt, two lines
of config.

## Caddy

```bash
sudo apt install -y caddy    # or: docker run caddy (see below)
```

`/etc/caddy/Caddyfile`:

```caddyfile
starter.example.com {
    reverse_proxy localhost:3000
}
```

`sudo systemctl reload caddy` — certificates are issued automatically.

Then in the instance's `.env`:

```bash
PUBLIC_BASE_URL=https://starter.example.com   # https ⇒ Secure cookies
TRUST_PROXY=true                               # trust Caddy's x-forwarded-for
```

and `docker compose up -d`.

**The bind address is what keeps port 3000 off the internet, not the
firewall.** The compose file publishes the app on `127.0.0.1` by default
(`APP_BIND`), so on a default or `--domain` install nothing needs closing. If
you installed with `--expose-port`, the app is published on `0.0.0.0`: set
`APP_BIND=127.0.0.1` and `ALLOW_INSECURE_SETUP=false` in `.env` and run
`docker compose up -d`. A ufw rule cannot close a port Docker publishes:
Docker writes its own NAT rules, which are evaluated before ufw's. Removing
the rule afterwards (`sudo ufw delete allow 3000/tcp`) is tidiness only.

Notes:

- **The app sends HSTS itself** whenever `PUBLIC_BASE_URL` is https
  (`HSTS_MAX_AGE`, default 180 days, `0` disables), plus `nosniff`,
  `Referrer-Policy`, and a CSP on HTML. No proxy header block is needed.
- **`TRUST_PROXY=true` only behind a proxy you control.** The app reads the
  **rightmost** `x-forwarded-for` hop — the one your proxy sets. No Caddyfile
  directive is needed: Caddy ≥2.5 discards client-supplied `X-Forwarded-*` by
  default and sets the header to the real peer. Do **not** add a
  `trusted_proxies` range covering untrusted clients, or the client-claimed
  value would be preserved and become the rightmost hop.
- **Chained proxies (CDN → Caddy):** the app reads the hop Caddy appended,
  i.e. the CDN's egress IP. Either accept edge-IP keying or strip/normalize
  `X-Forwarded-For` at the outermost hop so the real client IP lands rightmost.
- WebSockets and streaming (file downloads, MCP) proxy transparently; no
  extra config.

## Caddy in compose (alternative)

Add to `docker-compose.yml` when you prefer everything containerized:

```yaml
caddy:
  image: caddy:2-alpine
  restart: unless-stopped
  ports: ['80:80', '443:443']
  volumes:
    - ./Caddyfile:/etc/caddy/Caddyfile:ro
    - caddy_data:/data
```

with a `Caddyfile` of `starter.example.com { reverse_proxy app:3000 }`. Declare
`caddy_data:` under the file's top-level `volumes:` (Compose refuses an
undeclared named volume), and remove the app's host port mapping.
