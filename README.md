# ABSoft

**Developed by Abbass Chokor**

A small, modern point of sale system: products with barcodes, buying (stock in), selling
(stock out), expenses, live stock balances, full movement history and a from/to date
profit & loss report. Available in **English and Arabic**, with a fully mirrored
right-to-left interface.

Runs entirely on your own machine. **No dependencies to install** — it uses Node's built-in
SQLite and plain browser JavaScript, so there is no `npm install`, no build step and no
internet connection required.

---

## Running it

Double-click **`start.cmd`**, or from a terminal:

```
node server/index.js
```

Then open <http://127.0.0.1:4321>.

First sign-in is **`admin`** / **`admin`** — change it right away from the user menu at the
bottom-left (*Change my password*).

Requires Node.js 22.5 or newer (tested on Node 24).

### Try it with demo data

```
npm run seed     # ~10 products, 3 restocks, a month of sales and expenses
npm run reset    # wipe all business data, keep users and settings
```

`seed` only does anything on an empty catalogue.

---

## What each screen does

| Screen | What it is for |
| --- | --- |
| **Dashboard** | Today and this month at a glance: sales, profit, stock value, low-stock warnings, 30-day trend. |
| **Sell** (`F2`) | The till. Scan a barcode or tap a product, adjust quantities, discount, take payment, print the receipt. |
| **Buy — Stock In** (`F4`) | Record a supplier purchase. Multiple lines per document; stock goes up and the cost is re-averaged. |
| **Expenses** (`F5`) | Rent, salaries, utilities — anything that is not stock. These are what turn gross profit into net profit. |
| **Products** (`F3`) | Define what you sell: name, optional description, barcode, category, cost, default price, unit, low-stock level. Click any row for its full movement history. |
| **Sales History** | Every invoice, with cost and profit per sale. Click one to reprint it. |
| **Reports** | Profit & loss for any date range, plus product performance, stock valuation, the movement ledger and per-cashier totals. |
| **Users** | Add cashiers and administrators. |
| **Settings** | Store name, currency, sales tax rate, receipt footer, language, and database backups. |

Press `/` anywhere to jump to the search box. Every list has an **Export CSV** button.
The ⛶ button in the top bar puts ABSoft **full screen** — useful on a till, where the browser
chrome is just clutter. (Your browser's own `F11` works too.)

Product **descriptions** are optional. Fill one in and it appears under the name in the
product list, on the till tile, and in the product's history view — and it is searchable, so
a cashier can find "750ml bottle" without knowing the product name.

---

## Languages — English / العربية

Switch language from the picker in the top bar, on the sign-in screen, or under **Settings**.
The choice is remembered per browser, so a cashier on the till and the owner on a laptop can
each work in their own language against the same data.

Choosing Arabic does more than swap words:

- The whole interface mirrors to **right-to-left** — sidebar, tables, forms, toasts and modals.
- Dates use Arabic month names while keeping Western digits (`٢٨ يوليو` is written `28 يوليو`),
  which is what business documents normally use.
- Amounts follow Arabic convention, with the currency symbol after the number.
- **Error messages come back translated too.** The server sends an error *code* rather than a
  fixed English sentence, so "this barcode is already used" is Arabic for an Arabic user.
- Charts stay left-to-right, because a time axis reads the same way in every locale.

Two things stay exactly as you typed them, by design: **your data and your money**. Product
names, customers, suppliers, notes, categories and the store name are never translated — you
can enter them in Arabic, English or both, and each line takes its own direction automatically.

---

## How the numbers work

**Stock balance** is never stored as a number that can drift — it is always the sum of the
movement ledger (`stock_moves`). Opening balances, purchases, sales and manual adjustments
all write one signed row each, which is exactly what the history screens show you.

**Cost** uses a weighted average. Receiving 30 units at 6.00 when you already hold 10 at
4.00 gives a new cost of `(10×4 + 30×6) / 40 = 5.50`. That cost is copied onto each sale
line at the moment of sale, so a later price change never rewrites last month's profit.

**Profit & loss** for a date range:

```
  Net revenue      sales total, minus sales tax collected
− Cost of goods    the frozen unit cost × quantity sold
= Gross profit
− Expenses         what you recorded on the Expenses screen
= Net profit
```

Buying stock is deliberately **not** an expense. Money spent on goods sits in inventory
until those goods are sold, at which point it becomes cost of goods sold. The P&L shows the
period's purchase spend separately so you can still see the cash going out.

Selling more than you hold is allowed — counts often lag reality — but the sale is flagged
and the stock goes negative so you can see it needs fixing.

Deleting is protective: a product or user that already appears in history is archived
instead of deleted, so past reports never change. Voiding a sale or deleting a purchase
(administrators only) reverses its stock movements.

---

## Backups

Everything the business owns is in one file: **`data/absoft.db`**. Three ways to copy it:

| How | What it does |
| --- | --- |
| **Settings → Download backup** | Sends a snapshot to your Downloads folder. Put it on a USB stick or cloud drive. |
| **Settings → Save a copy on this computer** | Writes into `data/backups/`. The 20 most recent are kept. |
| `npm run backup` | The same thing from a terminal. This is what `update.cmd` runs. |

All three are **safe while the shop is trading** — no need to close ABSoft. They use SQLite's
`VACUUM INTO`, which writes a fully consistent copy in one step. That detail matters: ABSoft
runs in WAL mode, so hand-copying `absoft.db` while it is open can grab the file *without* its
`-wal` companion and silently lose the most recent sales. Never back up by copying that one
file — use one of the three above, or copy the whole `data` folder with ABSoft closed.

`npm run backup` is strictly read-only — it opens the database directly rather than through the
app, so it never applies a pending migration. That is what makes it trustworthy as the first
step of an update: the snapshot always predates whatever the update is about to change.

Only administrators can take a backup; a cashier cannot walk off with the whole business.

**To restore:** close ABSoft, replace `data/absoft.db` with the backup file (rename it to
`absoft.db`), delete any leftover `absoft.db-wal` / `absoft.db-shm` next to it, and start again.

---

## Where your data lives

`data/absoft.db` plus `data/backups/`. Nothing is ever sent anywhere.

The server listens on `127.0.0.1` only, so it is not reachable from other machines. To use
it from a phone or a second till on the same network:

```
set HOST=0.0.0.0 && set PORT=4321 && node server/index.js
```

Only do that on a network you trust — sign-in is the only barrier, and traffic is plain HTTP.

---

## Shipping updates to a real shop

You develop on your laptop and push to GitHub; someone else is running the till and must not
lose a single sale. The whole arrangement rests on one rule:

> **Code lives in Git. Data does not.**

`data/` is in `.gitignore`, so `git pull` physically cannot touch the shop's database or its
backups. Updating replaces program files only.

### One-time setup on the shop's computer

```
git clone https://github.com/<you>/ABSoft.git
cd ABSoft
start.cmd
```

That is the entire install — there are no dependencies to fetch. If Git is not available there,
download the ZIP from GitHub and unzip it; updates then work the same way but by hand (see below).

### Your loop on the laptop

1. Make the change.
2. **If you changed the database shape** (a new column, table or index), add a migration —
   see the next section. This is the only step that can hurt someone if skipped.
3. Bump `version` in `package.json` so the shop can see what it is running.
4. `git commit` and `git push`.

Two Windows habits worth keeping, both learned the hard way:

- **Save `package.json` as UTF-8 without a BOM.** ABSoft strips one if it finds it, but other
  tools are less forgiving.
- **Keep `.cmd` files pure ASCII.** Batch scripts run in the console's OEM codepage, and a
  stray em-dash in a comment is enough to make `cmd` try to execute part of it.

### Their loop on the till

Close ABSoft, double-click **`update.cmd`**, start ABSoft again. It:

1. **Backs the database up first**, into `data/backups/`. If the backup fails it stops there
   rather than pressing on.
2. Runs `git pull --ff-only` — fast-forward only, so it will never quietly merge or rewrite.
3. Prints the new version number.

The database upgrades itself the first time the new version starts. Nothing else to do.

If someone has edited files on the shop's machine, the pull refuses rather than clobbering
them, and the script tells them exactly how to discard those edits (`git reset --hard`) —
noting that neither command touches `data/`.

**No Git on that machine?** Download the ZIP, unzip it over the folder replacing everything,
and **keep the `data` folder exactly as it is**. Run `npm run backup` first.

### Changing the database shape safely

`server/db.js` creates the schema with `CREATE TABLE IF NOT EXISTS`. That is enough for a new
install and does **nothing** for a database that already holds a year of sales. So every change
made after the first release goes in [`server/migrations.js`](server/migrations.js) instead:

```js
const MIGRATIONS = [
  { name: 'product-description',
    up: (db) => addColumn(db, 'products', 'description', `TEXT NOT NULL DEFAULT ''`) },

  // your next change goes here
];
```

Append to the array and you are done — ABSoft applies anything outstanding on the next start
and records how far it got in SQLite's own `user_version`. Each migration runs in a
transaction, so a failure rolls back rather than leaving a half-changed database.

Three rules:

- **Append only.** Never reorder, renumber or edit an entry that has already shipped — someone's
  database has already applied it and will not apply it again.
- **Make it safe to run twice.** Use the `hasColumn` / `hasTable` helpers.
- **Never drop or retype a column holding real data.** To replace a field, add the new one,
  backfill it in the same migration, and leave the old one alone.

If a database is somehow *newer* than the code (an older build installed over a newer one),
ABSoft refuses to start and says so, rather than guessing and corrupting it.

### Checking what a shop is running

**Settings → About** shows the version, Node version, schema version, database size and record
counts — enough to diagnose a phone call without visiting.

---

## Layout

```
server/
  index.js          HTTP server, routing, session check
  paths.js          where data lives (no side effects)
  version.js        app version, read BOM-tolerantly from package.json
  db.js             base schema, settings, transaction helper
  migrations.js     schema changes made after v1.0.0  ← add yours here
  backup.js         consistent snapshots via VACUUM INTO
  auth.js           scrypt password hashing, sessions
  http.js           tiny router, JSON body, static files
  util.js           money/quantity rounding, date ranges, doc numbers
  routes/           products, purchases, sales, expenses, reports, users, system
  tools/            seed.js, backup.js, reset.js
public/
  index.html
  css/app.css       design tokens, light + dark themes, RTL rules
  js/i18n.js        English + Arabic strings, direction, error-code lookup
  js/               api.js, ui.js, icons.js, main.js, views/
data/absoft.db      your database (created on first run)
data/backups/       local snapshots (kept out of Git)
start.cmd           run ABSoft
update.cmd          back up, then pull the latest version from GitHub
```

### Adding another language

Everything user-visible lives in [`public/js/i18n.js`](public/js/i18n.js). Copy the `en` block,
translate the values, and add an entry to `LANGUAGES` with `dir: 'ltr'` or `'rtl'` — the layout
follows automatically, because the stylesheet uses CSS logical properties throughout rather
than hard-coded left/right.

---

Built by **Abbass Chokor**.
