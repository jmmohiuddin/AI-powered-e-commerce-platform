# `@voltix/noon-mcp` — noon Partner API as MCP tools

An MCP server that lets an AI client (Claude Code, Claude Desktop, Cursor) query
and operate a noon seller account in natural language.

This is the **operator** surface — "what did noon sell today", "is this SKU
live", "mark that order shipped". It is not how the shop stays in sync. That is
[`@voltix/noon`](../noon/README.md), which runs in the worker and needs no
assistant in the loop. The distinction matters: a missed tool call here is an
unanswered question; a missed sync is a listing selling stock that does not
exist.

---

## Tools

| Tool | What it does |
|---|---|
| `noon_get_stock` | Quantities noon holds for given SKUs in one warehouse |
| `noon_update_stock` | Set absolute quantity (not a delta) for up to 500 SKUs |
| `noon_update_price` | Set price and MSRP per marketplace country, in major units |
| `noon_list_orders` | FBPI orders for a warehouse, paginated, optional date range |
| `noon_get_order` | One order by its noon order number |
| `noon_create_shipment` | Confirm items shipped with courier and AWB |
| `noon_list_categories` | Catalogue categories available to this seller |
| `noon_list_category_attributes` | Which attributes a category requires, and their allowed values |
| `noon_list_warehouses` | noon warehouse codes — what every stock and order call is scoped to |

There are deliberately no listing-creation or deletion tools. Catalogue changes
go through the sync engine, which validates against the category schema and
keeps `noon_listings` in step; a listing created out-of-band would be invisible
to the sync and would never receive another stock update.

> **Earlier versions of this package exposed tools that could not work.**
> `noon_list_items`, `noon_get_item`, `noon_cancel_order`, `noon_approve_return`
> and friends were written against an invented API — wrong base URL, wrong auth
> scheme, wrong paths. They have been removed rather than stubbed. A tool an
> assistant can call and that cannot succeed is worse than one that is absent.

---

## Setup

Credentials are shared with `@voltix/noon` — see
[its README](../noon/README.md#credentials). In short: a Partner Portal service
account of type `apijwt` yields a JSON file with `key_id`, `private_key` and
`project_code`. There is no key/secret pair.

```bash
npm install
npm run build --workspace=@voltix/noon-mcp
```

### Claude Code

```bash
claude mcp add noon --env NOON_CREDENTIALS_FILE=/abs/path/to/noon_credentials.json \
  -- node /abs/path/to/packages/noon-mcp/dist/index.js
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "noon": {
      "command": "node",
      "args": ["/abs/path/to/packages/noon-mcp/dist/index.js"],
      "env": {
        "NOON_CREDENTIALS_FILE": "/abs/path/to/noon_credentials_sensitive.json",
        "NOON_API_BASE_URL": "https://sandbox-api-gateway.noon.partners"
      }
    }
  }
}
```

Point at the sandbox until you have watched it behave. On startup the server
logs to stderr whether it is talking to production or sandbox.

### Development, without building

```bash
NOON_CREDENTIALS_FILE=… npx tsx packages/noon-mcp/src/index.ts
```

---

## Example prompts

> "List noon orders for WH-DXB-01 since yesterday"
> "What quantity does noon hold for PHONE-X-256-BLK?"
> "Set stock for PHONE-X-256-BLK to 12 in WH-DXB-01"
> "What attributes does category elec_mobiles require?"
> "Mark order N-889231 shipped — AWB 7788 via Aramex"

---

## Troubleshooting

**`Missing NOON_KEY_ID, NOON_PRIVATE_KEY, NOON_PROJECT_CODE`**
Credentials are not reaching the process. MCP servers do not inherit your shell,
so set them in the `env` block of the client config, not in `.env`.

**`does not look like a PEM private key`**
The `private_key` value lost its newlines. Use `NOON_CREDENTIALS_FILE` instead,
or keep the literal `\n` sequences — the loader restores those.

**`noon login failed with HTTP 401`**
The key is revoked, or `project_code` belongs to a different project.

**`HTTP 403`**
The service account's role is below `Project Owner`.

**`HTTP 404` on `noon_list_warehouses`**
The warehouse service path prefix is the one endpoint inferred rather than
verified. See the table in [`@voltix/noon`](../noon/README.md#what-is-verified-and-what-is-not).

