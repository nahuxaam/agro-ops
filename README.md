# agro-OPS — fresh goods sales desk

Sales tracker and day-planner for a fruit & vegetable wholesaler. Built for the
realities of perishables: every batch has an expiry, the sell-first list tells
the sales team what to push today (with suggested markdowns and the customers
who usually buy it), credit limits and receivables are tracked per customer,
and waste is measured so it can be managed.

**Zero dependencies.** Runs on Node 22.5+ using the built-in SQLite — no
`npm install`, ever.

## Run it

```bash
node server.mjs
```

Open http://localhost:4780. First run seeds ~4 weeks of demo data so every
screen has something on it.

**First-run setup:** set `BAAZARU_ADMIN_PASSWORD` to a unique password of at least 12 characters before starting an empty installation. Sign in as `admin`, then add your team under **Users**. No demo login accounts are created. Existing installations retain their users and passwords and do not need this environment variable. Sessions last 30 days per browser. Use HTTPS when exposing the app beyond your trusted network.

**Roles** (segregation of duties — everyone can *view* everything):

| Role | Can do |
|---|---|
| **sales** | orders, payments, customers, price list, follow-ups |
| **operations** | receive stock and write-offs; view-only everywhere else |
| **admin** | everything — including inventory, users, and business details |

If you run a real (no-demo) book, remember to create at least one operations
user — until one exists nobody can receive stock.

| Command | What it does |
|---|---|
| `node server.mjs` | start (seeds demo data on an empty database) |
| `node server.mjs --reset` | wipe the database and reseed the demo book |
| `BAAZARU_NO_DEMO=1 node server.mjs --reset` | start with a **blank** book for real use |
| `node server.mjs --lan` | also listen on your network so the team can open it from other machines |
| `PORT=5000 node server.mjs` | run on a different port |

Data lives in `data/baazaru.db` (SQLite). Back it up by copying that file.

## What's inside

- **Dashboard** — sales today vs yesterday, 14-day trend, top products,
  receivables (with overdue), stock at risk, 30-day waste rate, today's
  deliveries, and follow-ups.
- **Sell first** — lots expiring within 3 days, value at stake, a suggested
  markdown (20% inside 3 days, 40% on the last two), and the customers who
  usually buy that product — one tap logs a follow-up call.
- **Orders** — order builder with live stock and credit-limit checks (the limit
  can be overridden deliberately), delivery + payment tracking, and lot-level
  traceability on every line (stock is consumed first-expiry-first).
  Every step can be undone: delivery reverts to pending (while unpaid),
  payments can be voided, and a cancelled order can be restored — restore
  re-draws the stock and refuses cleanly if the goods were already resold.
  Each action's toast carries an Undo button for quick misclick recovery.
- **Inventory** — receive stock in lots with expiry dates; freshness badges;
  write-offs with reasons feed the waste metric.
- **Customers** — terms, credit limits, balances, open invoices, what each
  customer usually buys.
- **Price list** — tap any cost or price to change it as the market moves;
  stock cover shows what needs reordering.
- **History** — an audit trail of every action: orders created/delivered/
  cancelled/restored, payments and voids, stock received and written off,
  price changes (old → new), sign-ins, user management. Filter by person or
  area. Written server-side, so nothing skips it.
- **Printable documents** — open any order and print the **delivery note**
  (quantities, lot numbers with best-before dates, tick boxes, signature
  block) or, once delivered, the **invoice** (terms, due date, payments,
  balance due, PAID stamp). Set your letterhead under **Business details**
  in the sidebar; add your GST TIN there and invoices show an
  includes-GST line (prices are treated as GST-inclusive).

Money is stored in laari (integer MVR × 100); quantities in the product's unit.

Local operational seed lists are optional JSON arrays in `data/seed/` (farmer-list.json, govan-farmers.json, boat-list.json). This directory and the database are excluded from Git. A fresh clone starts without these private directories; existing database records are preserved.
