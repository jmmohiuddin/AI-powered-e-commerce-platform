# Deploying Voltix Commerce to Hostinger

This stack needs Postgres 17 + pgvector, Redis, S3-compatible object storage,
two Next.js servers and a background worker. Hostinger's shared/cloud web
hosting offers a single Node.js process and MySQL only, so the target is a
**Hostinger VPS** running the Docker stack in this directory.

**Sizing:** KVM 2 (2 vCPU / 8 GB RAM / 100 GB disk) is the sensible minimum —
the image build alone wants ~4 GB free RAM. Choose a datacenter close to
customers (for the UAE market: the closest available region, e.g. India or
Europe).

## 1. Get a VPS and API token

- Buy/locate the VPS in [hpanel.hostinger.com](https://hpanel.hostinger.com) → VPS.
  Pick the **Ubuntu 24.04 with Docker** template (or plain Ubuntu — the deploy
  steps install nothing else besides Docker).
- Create an API token: hPanel → Account → API. Export it locally as
  `HOSTINGER_API_TOKEN` to let the API/CLI (or Claude) drive the rest.

## 2. DNS

Create three **A records** pointing at the VPS IP:

| Record | Purpose |
|---|---|
| `example.ae` (and `www`) | storefront |
| `admin.example.ae` | back office |
| `media.example.ae` | product images (MinIO via Caddy) |

If the domain is on Hostinger, hPanel → Domains → DNS. Wait for propagation
before first boot — Caddy needs it to obtain TLS certificates.

## 3. Firewall

Via API (or hPanel → VPS → Firewall): allow TCP **22, 80, 443** from anywhere,
default drop. Remember Hostinger firewalls need an explicit **sync** after rule
changes. Postgres/Redis/MinIO are never published on the host — they exist only
on the internal compose network — so no other ports are needed.

```bash
curl -X POST "https://developers.hostinger.com/api/vps/v1/firewall" \
  -H "Authorization: Bearer $HOSTINGER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{ "name": "voltix-web" }'
# then add rules for 22/80/443, activate on the VM, and sync
```

## 4. Server preparation (once)

```bash
ssh root@<VPS_IP>
# skip if you chose the Docker template
curl -fsSL https://get.docker.com | sh
mkdir -p /opt/voltix
```

Create `/opt/voltix/.env`: start from the repo root `.env.example`, apply the
overrides in `infra/production/.env.production.example`, and fill in real
secrets (passwords, AUTH_SECRET, TRN, payment/email keys).

## 5. Deploy

From your machine, at the repo root:

```bash
./infra/production/deploy.sh root@<VPS_IP>
```

That rsyncs the source, builds the image on the VPS, starts the stack and runs
migrations. Re-run the same command for every subsequent release.

## 6. First boot only — set the app role's real password

The first migration creates the restricted `voltix_app` role with a dev
password. Replace it and mirror the value in `DATABASE_URL` in `/opt/voltix/.env`:

```bash
ssh root@<VPS_IP> "cd /opt/voltix && docker compose -f infra/production/docker-compose.prod.yml exec postgres \
  psql -U voltix -d voltix -c \"ALTER ROLE voltix_app LOGIN PASSWORD '<generated password>';\""
```

Then restart the app containers, seed if desired, and create the first admin
user:

```bash
ssh root@<VPS_IP> "cd /opt/voltix && docker compose -f infra/production/docker-compose.prod.yml --env-file .env up -d --force-recreate storefront admin worker"
ssh root@<VPS_IP> "cd /opt/voltix && docker compose -f infra/production/docker-compose.prod.yml --env-file .env run --rm migrate npm run db:seed"
ssh root@<VPS_IP> "cd /opt/voltix && docker compose -f infra/production/docker-compose.prod.yml --env-file .env run --rm migrate npm run db:create-user -- <email> <password> owner"
```

## 7. Verify

- `https://example.ae` serves the storefront over TLS — and shows **your**
  catalogue, not the demo one (demo data means the app cannot reach Postgres:
  check `DATABASE_URL` and the migrate/seed steps).
- `https://admin.example.ae` shows the login screen.
- A product-image upload in the admin appears on `https://media.example.ae/...`.
- `docker compose ... ps` shows all services healthy;
  `docker compose ... logs -f worker` shows the worker ticking.

## Operations

- **Logs:** `docker compose -f infra/production/docker-compose.prod.yml logs -f <service>`
- **Backups:** Hostinger VPS backups cover the volumes. Additionally
  `pg_dump` on a cron is cheap insurance:
  `docker compose ... exec postgres pg_dump -U voltix voltix | gzip > /root/voltix-$(date +%F).sql.gz`
- **Snapshot before risky changes** (hPanel or API) — note a new snapshot
  overwrites the previous one.
- **Rollback:** re-deploy a previous git checkout with `deploy.sh` (images are
  rebuilt from source), or restore the VPS snapshot.
