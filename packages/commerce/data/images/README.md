# Local product photographs

Files here are named `<SKU>.<ext>` (jpg, jpeg, png, webp or avif) and are used
by `npm run db:import-catalog` **in preference to** the `imageUrl` in
`semul-catalog.json`.

Two reasons a photograph belongs here rather than at a URL:

- **The source host blocks the server.** Several of the catalogue's image hosts
  serve a laptop and return 403 to a datacentre IP. `GNSCCTC60WBL.jpg` is one:
  maliks.com serves it locally and refuses the VPS, so the same import produced
  a photograph in development and none in production.
- **There is no source photograph.** Nine SKUs have none, or only a
  black-variant template shot that would misrepresent the colour actually being
  sold. Drop the real photo in here and re-run with `--backfill-images`.

Files are checked in on purpose: the deploy rsyncs the tree to the server, so a
photograph added here reaches production the same way the code does, and the
import stops depending on a third party still being up.
