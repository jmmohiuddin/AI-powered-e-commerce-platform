# Production image for the whole monorepo, built from the repository root
# (see docker-compose.prod.yml: context is ../..).
#
# One image serves three roles — storefront, admin, worker — differing only in
# the compose `command`. The workspace packages ship TypeScript source that
# Next transpiles at build time and tsx runs at runtime (worker, migrations),
# so devDependencies stay in the image on purpose: pruning them would strip
# tsx and drizzle-kit and quietly break `db:migrate` and the worker.
FROM node:22-bookworm-slim

WORKDIR /app

# npm ci needs every workspace manifest before it will install; copying the
# whole tree (filtered by .dockerignore) is simpler than enumerating them and
# the layer is invalidated by any source change anyway because the packages
# are consumed as source.
COPY . .

RUN npm ci

# Build the two Next apps only — the worker and migrations run from source via
# tsx, and the root `build --workspaces` also picks up packages (noon-mcp)
# this image does not ship. No secrets are present at build time — pages that
# read the database are dynamic and resolve their data at request time against
# the runtime environment.
ENV NODE_ENV=production
RUN npm run build --workspace=@voltix/storefront --workspace=@voltix/admin

EXPOSE 3000 3001
CMD ["npm", "run", "start", "--workspace=@voltix/storefront"]
