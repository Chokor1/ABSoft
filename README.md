# ABSoft POS

*by ABSoft*

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
npm run seed                          # ~10 products, 3 restocks, a month of sales and expenses
npm run demo:products                 # 131 products in 20 categories, with opening stock
npm run demo:products -- --remove     # take those 131 out again
npm run reset                         # wipe all business data, keep users and settings
```

`seed` only does anything on an empty catalogue. `demo:products` can be added to a
database that already has real products: it skips anything already there, and its
barcodes sit in the 200 in-store range, so they never collide with a real item. Removing
them deletes the untouched ones and archives any that were already sold or bought, so no
invoice loses a line.

---

## What each screen does

| Screen | What it is for |
| --- | --- |
| **Dashboard** | Today and this month at a glance: sales, profit, stock value, low-stock warnings, 30-day trend. Each figure says how it compares — ▲ 12% against yesterday, or against the same days of last month — and says nothing when there is no earlier figure to compare with. The chart shows revenue, gross profit and, underneath, each day's expenses, on a round-number axis. |
| **POS** (`F2`) | The till, full screen: the sidebar slides away, and the ABSoft mark at the start of the top bar leads back home (a cashier's leads to Sell); the exchange rate moves into the top bar. Scan or tap products (newest on top), adjust quantity, price or discount right on each line, then **Make payment**. The receipt opens as soon as the sale is saved. |
| **Sell** | Every invoice — those rung up at the POS and those entered here. **New sale** enters a sale as a document, like a purchase: customer, date, lines with price and discount, an invoice discount, and what was paid now (the rest stays owing). Click an invoice to open it: the receipt, its payments, print, take the rest, void. Cost and profit per sale for administrators. |
| **Buy** (`F4`) | Record a supplier purchase. Multiple lines per document; stock goes up and the cost is re-averaged. Administrators can edit a saved purchase; every change is logged. |
| **Stock Count** | Count the shelf — all items, one category or a few — and correct the stock in one go. |
| **Stock Adjustment** | Counts, damage, expiry and write-offs as numbered documents covering many products at once. Scan or search products (or add a whole category), then type what you counted or how much changed. |
| **Expenses** (`F5`) | Rent, salaries, utilities — anything that is not stock. These are what turn gross profit into net profit. |
| **Expense categories** | What expenses are filed under — rent, salaries, utilities — listed beside Expenses in the menu. |
| **Products** (`F3`) | Define what you sell: name, optional description, barcode (and any other barcodes), category, cost, default price, unit, low-stock level. Click a row to open the product's own page (see below). |
| **Product categories**, **Units** | What products are filed under, and what they are counted in (pcs, kg, box). Both sit in the Stock menu, after the stock screens. |
| **Customers** | Who buys from you. Each opens on their own page, with their balance, their statement and what they bought. |
| **Suppliers** | Who you buy from, the same way: balance, statement, purchases and what you bought from them. |
| **Reports** | Profit & loss for any date range, **Sales analysis**, product performance, stock valuation, the movement ledger and per-cashier totals. The report menu, the dates and the buttons share one line, so the report itself gets the screen. |
| **Users** | Add cashiers and administrators. A cashier only gets **POS**, **Sell** (without cost or profit) and their own settings. |
| **Settings** | In sections: Store (logo, name, currency, tax, receipt footer), POS (shifts, scale barcodes, sound, picture cards), Search, Currency, **Payment methods**, Language, Backup & data (including the automatic backups), About. |

**Each list of names sits beside the screen it is used with**, not in a drawer of its own:
customers with selling, suppliers with buying, product categories and units in the Stock menu,
expense categories beside Expenses, payment methods as a section of Settings (whose header stays
the same on every section). A link to the old `#/lists/…` addresses still lands in the right place.

The menu is the **Dashboard** and four sections that all look and fold alike: **Sales** (Sell,
Shifts when they are on, Customers), **Purchases** (Buy, Suppliers), **Stock** (Products, Stock
Count, Stock Adjustment, Product categories, Units) and **Finance** (Expenses, Expense categories,
Reports). Click a section's heading to fold it away. Where the whole menu fits the window, every
section stays as you left it; where it would not — a 1366×720 till, most laptops — one section is
open at a time, the one you are in, so rows keep their size instead of being squeezed or scrolled.
**Users** and **Settings** open from the user menu at the foot of the sidebar, and the gear
beside your name opens Settings. **Products** carries the number of products at or below their
minimum (switch it off under Settings → Store); click it for exactly that list.

Press `/` anywhere to jump to the search box. Every list has an **Export CSV** button.
**Lists come a page at a time.** Products, sales, purchases, stock adjustments, expenses and the
customer/supplier lists ask the server for one page (50 rows by default; 25, 100 or 200 from the
strip under the table), so a shop with years of invoices opens as fast as a new one. Each list has
filters that narrow the page before it loads — products by category, stock (in, low, out, needs
restocking) and archived; sales by payment status and method; adjustments by reason; expenses by category — and
any change of filter goes back to page one. The badges above a list count everything that
matches; the row under the table adds up the page on screen.

Every screen carries its own header — its name, what it is for and its buttons (Export, New
sale…) — as the first row of its filter bar, with the figures for everything that matches at the
end of that bar. The top bar above holds only what belongs to the whole app: **POS**, the
language, full screen and light/dark. A table therefore starts at its column headings.

Tables — lists and reports alike — scroll their rows inside their own section, with the column
headings and the totals row always in view. With only a few rows, the table simply ends at its
totals. The report menu stays pinned under the top bar while a long report scrolls.

Clicking a row opens a **page**, not a pop-up: an invoice, a purchase (with its change history
and Edit) or a stock adjustment, each with Back, Print and its actions at the top.
The ⛶ button in the top bar puts ABSoft POS **full screen** — useful on a till, where the browser
chrome is just clutter. (Your browser's own `F11` works too.)

Product **descriptions** are optional. Fill one in and it appears under the name in the
product list, on the till tile, and in the product's history view — and it is searchable, so
a cashier can find "750ml bottle" without knowing the product name.

---

## Names you reuse — customers, suppliers, categories, units

Type a customer on an invoice, a supplier on a purchase, or a category on a product, and
ABSoft POS **remembers it**. Next time, click the field for a dropdown of the saved names (with
phone numbers where you added them), or type to narrow it down. Nothing changes about
how you work: the field is still an ordinary text box, an unfamiliar name is simply a new one,
and none of it is ever required. A name that is not saved yet appears first as **Use “…”**, so
pressing Enter always keeps exactly what you typed.

Those names live beside the screens that use them, each a row of the menu: **Customers** under
Selling, **Suppliers** under Buying, **Product categories** and **Units** under Stock, **Expense
categories** beside Expenses. Open any entry to add detail — phone, email,
address, tax number, a note — all optional, added whenever you feel like it and never before.
You can also add an entry by hand, so a customer can be suggested before their first sale.

Three behaviours worth knowing:

- **Capitalisation is not a new customer.** Type "ahmad store" when the list already holds
  "Ahmad Store" and the invoice records "Ahmad Store". Without that, one customer quietly
  becomes three spellings and every total that groups by name is wrong.
- **Renaming corrects the past.** Fix a typo and the invoices, purchases or products that
  already carry that name are corrected too — which is what "I spelled it wrong" means.
- **Removing one does not.** Deleting an entry only stops it being suggested. Documents keep
  the name exactly as recorded, because an issued invoice is a historical record.

Cashiers get the suggestions they need to sell and can create names just by using them.
Editing and deleting shared lists is administrator work.

Nothing here changes how data is stored: a sale still holds its customer as plain text, so
reports, exports and old invoices are entirely unaffected. On update, every name already in
your data is collected into these lists automatically.

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
- **Counted things take the right form.** English has "1 product" and "3 products"; Arabic has
  six forms — منتج واحد، منتجان، 3 منتجات، 11 منتجاً، 100 منتج — and every counted string picks
  the one the number calls for, from the browser's own plural rules.
- Product names line up on one edge whichever script they are written in: an Arabic name in
  the English till starts at the left with the English ones, and the other way round.

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

## Customer and supplier pages

In **Customers** or **Suppliers**, click a row (the pencil still edits). Their page has their name
and contact details at the top, where they stand as tiles, and three tabs:

- **Statement** — the balance brought forward, then every invoice and every payment in the order
  they happened, with the balance after each, and the closing balance at the bottom. Any date
  range; **All time** goes back to their first invoice. Click a line to open the invoice.
- **Invoices** — their invoices with paid, balance and status, filterable to unpaid or part paid.
- **Items** — what they bought in the period: quantity, invoices, average price, sales, profit.
  **Sales analysis** in the top bar opens the full report filtered to them.

The tiles show what a customer **still owes** (and on how many invoices), their total sales,
what they have paid and when they last paid, the profit made on them, and their last sale.

A supplier's page works the same way, with their **Purchases** and the **Items** they supplied
(quantity, average and last cost, when last bought). Purchases do not record payments to
suppliers, so a supplier's statement adds up what was bought rather than a balance owed.

From an invoice, the **Customer** button opens that customer's page; from a purchase, the
**Supplier** button opens the supplier's. Names are matched ignoring capitalisation, the same way
the lists do.

---

## How people pay

**Settings → Payment methods** is the shop's own list. **Cash** and **On account** are built in: they
can be switched off, but never renamed or removed, because every past invoice and report carries
them. Everything else is yours to add, rename, switch off or delete — **Whish** and **OMT** come
ready to use, and a card machine or a bank cheque takes a minute to add.

Each method wears an **icon**: pick one of the drawn ones (cash, card, transfer, phone app, bank…)
or **upload the method's own logo** (PNG, JPEG or WebP). The logo is shrunk in the browser and kept
in the database, so a backup carries it. At the till each method shows its
mark or logo with its name beside it, so a cashier picks one out of the row at a glance.

The list is used by the till's payment dialog, the Sell form, expenses and the payment filter on
Sell. Renaming a method corrects the sales, payments and expenses that already carry it — the same
way renaming a customer does.

---

## Sales analysis

**Reports → Sales analysis** is one dynamic report over every invoice line:

- **Filters:** a date range, a **customer** (or *Walk-in* for sales without one), an **item** and a
  **category** (or *No category*). They combine; **Clear filters** lifts them.
- **Show:** *Lines* (every invoice line), *Invoices*, *Items*, *Categories*, *Customers*, *Days*
  or *Months*.
- **Columns:** quantity, price, discount, **sales, cost, profit and margin** — and, for items,
  categories and customers, each row's share of the sales. Click a heading to sort by it.
- **Totals:** the tiles and the totals row cover everything that matches, across all pages.
- **Click a row to look inside it:** a month opens into its days, a day into its lines, a customer
  or category into its items, an item into its invoices; a line or an invoice opens the invoice.

*Sales* here are after discounts and before tax. An invoice-wide discount is shared across that
invoice's lines by value, so the lines add up exactly to the invoice and the report agrees with
the revenue, cost of goods and gross profit in the profit & loss. The screen remembers your
filters while you open an invoice and come back. **Export CSV** downloads every matching row, not
just the page. The report shows costs, so it is for administrators only.

---

## A product's page

Click any product. Its name, stock and price sit at the top with the menu beside them —
**Details, Overview, Stock movements, Sales report, Purchases** — and stay there as you scroll.
**Adjust stock** and delete are in the top bar.

- **Details** (opens first) — the picture, with the product's properties beside and under it:
  everything editable is a field you can change and save in place; stock, value and margin are
  shown read-only.
- **Overview** — stock, price, cost and margin, stock value and the last 30 days' sales as tiles,
  a 30-day chart, and the latest stock movements.
- **Stock movements** — every change with the balance after it.
- **Sales report** — any date range: quantity sold, revenue, cost, profit and margin, and every
  invoice line (click one to open the invoice).
- **Purchases** — each time it was bought, from whom, at what cost.

**More than one barcode.** A product has its main **Barcode** and any number of **Other
barcodes** — the same item in another pack, or from another supplier. Click the box, scan or type
a code and press Enter (a scanner does that for you); each code becomes a chip, and × removes it.
Any of the codes rings the product up at the till, finds it in searches and in stock counts. A code
can only belong to one product: using one that is taken says which product has it. The product
list shows the main barcode with **+2** for the others, and its export lists them all.

**Pictures.** Click *Add picture* and choose a photo. The browser shrinks it (640 px, WebP) before
uploading, so even a phone photo ends up a few tens of kilobytes. It is stored in the database,
so backups carry it. The picture shows on the product page and on the till's product cards;
the product list and search results stay compact and show none. Without a picture, the
product's initials stand in.

---

## Opening stock

What was already on the shelf when a product — or the whole shop — started in ABSoft POS is recorded as
a **stock adjustment of type *Opening stock*** (numbered with the other adjustments, `ADJ-…`), with a
quantity and a cost for each product. There is no separate opening stock document.

- **A new product.** The new-product form has an *Opening stock* field, 0 by default. Put 1 or more
  and saving records an opening stock adjustment for it. The field is not on the product's page
  afterwards: from then on, stock changes through documents.
- **By hand.** **Stock → Stock Adjustment → Opening stock**: scan or search products, type the
  quantity and cost (the product's cost is filled in), save.
- **Importing.** Opening quantities in an imported file all go into **one** adjustment for the file.

Stock Adjustment lists them with an *Opening stock* badge, and its **Type** filter shows only opening
stock or only ordinary adjustments. Shops that recorded the short-lived `OPN-…` documents have them
converted to opening stock adjustments automatically on update, stock unchanged.

Opening stock blends into the average cost like a purchase. Deleting one takes its stock back
out (the average cost stays as it is).

## Importing products

**Products → Import**:

1. **Download the template** — a CSV with the columns `name, description, barcode, category, unit,
   cost, price, min_stock, opening_stock` and two example rows.
2. Fill it in (Excel: *File → Save As → CSV UTF-8*). Semicolon-separated files, comma decimals
   (`1,20`), quoted cells and Arabic names are all read correctly; English or Arabic column headings
   are recognised.
3. Choose the file. Nothing is saved yet: a **preview** checks every row and marks it *Ready*,
   *Skipped* (a product with that barcode already exists — it is never overwritten) or *Error*
   (missing name, a word where a number goes, a barcode repeated in the file), with the reason.
4. Set the date and note for the opening stock, and press **Import**. The ready rows become
   products; every opening quantity in the file goes into one opening stock adjustment, linked from
   the result.

---

## Stock count (جردة)

**Stock** in the menu folds open to show **Products**, **Stock Count** and **Stock Adjustment**. Click
it to fold it away; the choice is remembered, and opening one of its screens unfolds it again.

Open Stock Count — nothing is loaded yet — and choose what to count: **All items**, **By category**, or **Pick items**
(scan a barcode or search). Each row shows what the system holds beside a box for what you
counted; the difference and the new balance appear as you type, the row turns amber when it
differs and green when it matches, and the footer keeps a running tally of how many are counted,
how many differ and what the difference is worth. Enter jumps to the next row, and the filter box
narrows a long sheet without losing anything already typed.

Rows left blank are simply not counted. **Save count** applies what you typed against the balance
at that moment and records it as one stock adjustment document (reason *Stock count*), so the
correction keeps a date, a note and a trail; that document opens straight afterwards. Products
whose count matched change nothing.

---

## Stock adjustments

**Stock Adjustment** (under Buy in the menu) records corrections as documents, `ADJ-000001`
and on, each with a date, a reason (stock count, damaged, expired, lost, returns… or your own)
and an optional note.

1. Scan a barcode or search for a product — it gets a line, and the cursor jumps to **Counted**.
   Press Enter to go back to the search for the next one. **Add a whole category** puts every
   product in that category on the sheet at once, which is how a shelf count starts.
2. On each line type **Counted** (what is physically there) *or* **Change** (+5, −2). Each fills
   in the other, with the new balance and the value of the difference beside it.
3. Save. Lines that do not change anything are left off.

A count is applied against the balance **at the moment you save**, so a sale rung up while
someone was counting is not lost. Adjustments are valued at the product's average cost and do
not change it. Deleting an adjustment reverses its stock. The quick **Adjust stock** button on
a product still works, and now makes a one-line adjustment document too.

---

## Who can do what

| | Administrator | Cashier |
| --- | --- | --- |
| POS, receipts, taking payments on invoices, opening and closing shifts | ✓ | ✓ |
| Sell | ✓ with cost and profit | ✓ without cost and profit |
| Void a sale, remove a payment | ✓ | — |
| Products, purchases, adjustments, expenses, lists, reports, dashboard | ✓ | — |
| Users, store settings, backups | ✓ | — |

This is enforced by the server, not just hidden in the menu: a cashier's session can only call
what the till needs, and product and sale data sent to a cashier leaves out costs and profit.

---

## Correcting a purchase

Got the quantity or cost wrong on a delivery? An administrator can open the purchase and
click **Edit** (or the pencil on its row). Change the supplier, date, note or lines, add an
optional reason, and save. ABSoft POS then:

- takes the old lines back out of stock and out of the average cost, and puts the new ones in;
- leaves sales already made alone — they keep the cost they were sold at, so past profit
  does not shift;
- writes the change to the purchase's **History**: who, when, the reason, and exactly what
  changed (for example *Flour: 100 × $6.00 → 50 × $6.00*, *Total: $600.00 → $480.00*).

Edited purchases carry an **Edited** badge in the list. The log also records when a purchase
was created and deleted, and it is kept even after the purchase itself is gone.

Once some of the goods have been sold, the cost correction is a best estimate — the same
blending the average cost always uses — rather than a replay of every sale since.

---

## At the till

**Picture cards.** Off by default. The picture button beside the search box (or **Settings → POS**)
switches the till to picture cards, remembered per device: the product's picture fills the top of
the card, centred and cropped to cover it, with the name in white over its lower edge and the price
underneath. Products without a picture show a quiet placeholder. Uploaded photos are kept at up to
1024 px, so they stay sharp. No photos yet? `npm run demo:images` draws a picture for every product
that has none — a coloured card with a matching emoji — and `npm run demo:products` gives its demo
catalogue pictures straight away. `npm run demo:images -- --remove` takes the drawn ones out again
and never touches real photos; `-- --refresh` redraws them (after an update changes their look).

The till never loads the whole catalogue, so a shop with thousands of products opens and scans
as fast as a small one. It opens on the **40 best sellers** of the last 30 days, and scrolling to the end of the cards
loads the next batch. From the **first letter** typed it searches every product (name,
any barcode, category or description, every word counting) and shows the first matches, best
matches first, with the cards sliding and fading into place. Enter or a scanner looks the code up
exactly — any of a product's barcodes — so an item that is not on screen still rings up at once;
Enter also adds the product when only one card matches. Escape or **Clear** brings the best
sellers back. A scan works wherever the cursor is: any letter or digit typed on the
till goes into the search box, so a barcode still rings up after tapping a card or closing a
dialog. Typing inside a field, a dialog on top, and Ctrl/Alt/⌘ shortcuts are left alone. Both numbers are set under **Settings → Search**: a shop with a very large catalogue can
start the search at 2 to 5 letters instead, and the batch can be 20 to 200 cards.

The cart is only what is being sold. The newest item goes on top, scanning an item that is
already there adds one to its line, and each line's quantity, unit price and **discount %** are
edited right where they sit (the invoice records the discount as money). With a second currency
on, each line and the total show it too.

A line's chevron **opens it to sell at a price**: type what the line should come to and the
discount is worked out for you and shown in money; above the full price the unit price moves
instead, since there is nothing left to discount.

**Make payment** opens the payment dialog. On one side, the amount due in large type, the amount
handed over (in each currency, when a second one is on) and — as you type — the change to give
back or the amount still owing. On the other, the customer, the payment method as a row of
buttons, an invoice discount in money **or** as a percentage, the totals, and a note. Confirming saves the sale, plays a short chime with a
check mark, and opens the receipt to print or close. The chime can be switched off per device
under **Settings → POS**.

On a phone the search, the cart and the products stack in that order, and a bar at the bottom
keeps the total and **Make payment** in reach while you scroll.

**Hold and resume.** A customer who forgot something should not hold up the queue. **Hold**, in the
cart's header, puts the sale aside — its lines, prices and discounts, and whatever was typed in
the payment dialog — and the till is free for the next customer. A chip beside it counts the held
sales and opens the list: what is in each, what it comes to, who held it and when. **Resume**
brings one back exactly as it was, at this till or another; if a sale is in hand, that one is
held in its place rather than lost or mixed in. A held sale keeps the prices it was quoted at,
moves no stock and appears in no report until it is paid. Whoever held a sale can discard it, and
so can an administrator. Closing a shift warns when held sales are still waiting.

**The whole sale works from the keyboard.** `F2` opens the till with the cursor in the search
box; a scan or a typed name adds a line; **`F9`** — or **`Ctrl+Enter`** — opens Make payment from
anywhere on the till (Tab and Shift+Tab stay inside the dialog, Escape closes it and puts the
cursor back where it was); Enter confirms. On a laptop whose top row sends media keys, the
function keys (`F2`–`F5`, `F9`) need `Fn` held, or Fn Lock switched on (often `Fn+Esc`);
`Ctrl+Enter` needs neither, and pressing it again inside the dialog does not confirm the sale. The receipt then holds the focus itself rather than its Print button, so a
scanner's Enter after the next barcode never prints a second copy. Wherever the keyboard lands
there is a visible ring, and every button that is only an icon has a name a screen reader can say.

### Labels from a weighing scale

Cheese, meat and vegetables are weighed at the counter, and the scale prints a 13-digit barcode:
a two-digit **prefix**, the item's code, the **weight in grams** (or the **price in cents**) and a
check digit. Switch this on under **Settings → POS → Scale barcodes**, say which prefix the scale
uses (21 is usual; 20–29 are reserved for in-store codes), how many digits the item code has, and
whether the label carries the weight or the price. Give each weighed product its scale code as its
barcode — `00123`, or just `123` — and scanning `21 00123 01234 c` rings up product 123 at
1.234 kg; a price label rings up the weight that price buys. Scanning it again adds to the same
line. A label with a wrong check digit is refused, never guessed.

Switching it on is refused while any real 13-digit product barcode starts with that prefix, since
such a product would then ring up as a weight; the message says how many, so you can change either.

### Shifts (opening and closing)

Off by default; switch on under **Settings → POS → Work in shifts**. With shifts on, the till sells
only inside an open shift:

- **Opening.** The till asks for the cash already in the drawer (and in the second currency, when
  one is on) and an optional note. The shift is numbered `SH-000001`, `SH-000002`, …
- **During the shift.** Its number shows at the end of the search bar. Every till sale, and every
  payment taken on an older invoice, belongs to the open shift. Sales entered by hand from **Sell**
  are never blocked.
- **Closing.** Click the shift's number. One table counts every way of paying: the cash drawer
  (opening cash + cash taken), and each other method the shift took (card, Whish, OMT…) against
  what came in. With a second currency on, a method that took both gets a row per currency —
  L.L is counted in L.L, never turned into dollars first — and each currency balances on its own.
  Type what you counted and each line, and the total, shows at once whether it
  balances, is over or is short. Closing keeps those counts for good, then a short animation shows
  the result and asks whether to **print the shift report** (a receipt-style summary). The till
  then asks for the next shift.
- **History.** **Shifts** in the menu (shown only while shifts are on) lists every shift with its
  expected and counted cash; each opens as a document with its figures and its sales.

Cashiers open and close shifts; only an administrator can switch shifts on or off.

---

## Returns and exchanges

Something comes back. There are three ways in: the **Return** button on the invoice's row in
**Sell**; the **Return** button beside the search box at the till, which lists the latest invoices
and finds older ones by number or customer; or typing the invoice's number — `INV-000269` — into
the till's search box. (An opened invoice has **Return items** too.) Say how many of each line are coming back and
whether each goes **back on the shelf** or was **damaged**, choose how the money goes out — cash,
card, Whish, or **on account**, which leaves it owed to the customer — and confirm. The refund is
what the customer paid for those goods: their share of the invoice's discount and tax comes back
with them.

The return is a document of its own, `RET-000001`, `RET-000002`…, linked to its invoice: the
invoice lists its returns, the return leads back to the invoice, both print, and **Sell** shows
returns beside invoices with a filter for either. Underneath, a return is a sale with negative
quantities and money, which is why every figure nets it out without a special case — today's
sales and profit, the 30-day chart, the customer's statement, the product's history, the shift's
drawer (the refund is counted in the shift that gave it). A line that went back on the shelf puts
its stock and its cost back; a damaged one refunds the money and keeps the cost, which is what a
loss is. The movement ledger records it as **Returned**.

An **exchange** is a return followed by a sale: at the till, the dialog's **Refund and start a new
sale** saves the return and leaves a chip on the cart naming it; ring up the new items as usual, and
the drawer moves by the difference.

A cashier can take a return; only an administrator can void one (like any sale), and an invoice
with returns cannot be voided until they are.

---

## A second currency (for example L.L beside $)

Turn it on under **Settings → Second currency**: tick *Use a second currency*, give its symbol
(`L.L`), how many decimals it is counted in (`0`) and the rate — how much of it one unit of the
main currency buys (`89500`). The books stay in the main currency: prices, costs, totals, profit
and every report. The second currency is for showing amounts and taking money.

- **The rate lives in the sidebar.** Everyone sees *1 $ = 89,500 L.L*; an administrator clicks the
  pencil, types the new rate and presses Enter. Every price on screen changes at once, and other
  tills pick the new rate up within a minute. Each change is kept with who made it.
- **Prices in both.** The till's product cards, the cart total, the product list (a *Price in L.L*
  column), the product page, purchases and invoices show the second currency beside the first.
- **Paying in either, or both.** The payment dialog has *Received in $* and *Received in L.L*.
  Type the L.L handed over and the dollar box shows what is left to pay; **All in L.L** puts the
  whole invoice in L.L. Change and anything still owed are shown in both currencies.
- **Taking the rest later**, on the invoice page, lets you choose the currency; switching it
  converts the balance.
- **Rates are remembered.** An invoice keeps the rate of its day, and a payment in L.L keeps what
  was handed over and the rate it was taken at — so changing the rate tomorrow never rewrites
  yesterday. The receipt prints the total and what was paid in L.L.

Switching the second currency off hides it everywhere and keeps the rate for next time.

---

## Payments, in full or in instalments

A sale does not have to be paid all at once. At the till, type any amount into
**Amount received** — less than the total leaves the rest owing on the invoice,
more is simply change. Entering nothing records a sale on account.

Everything owed is then visible where you would look for it:

- **Sell** shows *Paid*, *Balance* and a status of paid / part paid /
  unpaid, with an **Unpaid only** filter and the outstanding total in the header.
- Opening an invoice from Sell lists every instalment taken against it and offers
  **Record payment** — that is for collecting the rest when the customer comes back, so it
  does not appear on the receipt shown the moment a sale is made. Each instalment keeps its own date, method and note, so
  "$50 cash on the 3rd, $30 by card on the 11th" is exactly what you see.
- The dashboard flags the total owed next to recent sales.

Cashiers can take payments; only an administrator can remove one, which puts the
amount back on the invoice as owed and leaves the sale itself untouched.

Two rules the system enforces: you cannot pay more than is owed (the excess is
change at the counter, not money held against the invoice), and **an unpaid sale
still counts as revenue**. That is deliberate — profit is earned when the goods
leave, not when the cash arrives. What has not been collected is a separate
figure, which is why it has its own column rather than being deducted from
profit.

---

## On paper

Give the shop its logo under **Settings → Store**: choose a PNG or JPG and it is shrunk on your
own device before it is saved, so a photo straight from a phone is fine.

Everything printed then comes out on the shop's own stationery:

- **Receipts and shift reports** carry the logo above the shop name, and end with a thin line
  naming the software that made them — `Generated by ABSoft POS v1.24.0` — with its mark.
- **A full page** (an invoice, a purchase, a list, a report) gets a letterhead: the logo and shop
  name on the left, the date printed on the right, and the same software line at the foot of every
  page. The menu, the top bar, filters, pagers and buttons stay on screen.
- Paper is always black on white, even when the screen is in dark mode, and tables keep their
  headings and rules.

---

## Backups

Everything the business owns is in one file: **`data/absoft.db`**. It is copied for you, and there
are three ways to copy it yourself:

| How | What it does |
| --- | --- |
| **Automatic** | One backup a day — at the first start of the day, or within half an hour of midnight on a server left running — and one whenever a shift closes, into `data/backups/`. **Settings → Backup & data** shows when the last one was taken and, should one fail, why. |
| **A second folder** | Name a folder under Settings → Backup & data — a OneDrive or Google Drive folder, a USB stick, anywhere off this disk — and every automatic backup is copied into it too, the first one the moment you save. A folder that has gone missing is made again; one that cannot be written shows up as a failure on that screen, never silently. |
| **Settings → Download backup** | Sends a snapshot to your Downloads folder. Put it on a USB stick or cloud drive. |
| **Settings → Save a copy on this computer** | Writes into `data/backups/`. The 20 most recent are kept. |
| `npm run backup` | The same thing from a terminal. This is what `update.cmd` runs. |

All of them are **safe while the shop is trading** — no need to close ABSoft POS. They use SQLite's
`VACUUM INTO`, which writes a fully consistent copy in one step. That detail matters: ABSoft POS
runs in WAL mode, so hand-copying `absoft.db` while it is open can grab the file *without* its
`-wal` companion and silently lose the most recent sales. Never back up by copying that one
file — use one of the ways above, or copy the whole `data` folder with ABSoft POS closed.

`npm run backup` is strictly read-only — it opens the database directly rather than through the
app, so it never applies a pending migration. That is what makes it trustworthy as the first
step of an update: the snapshot always predates whatever the update is about to change.

Only administrators can take a backup; a cashier cannot walk off with the whole business.

**To restore:** close ABSoft POS, replace `data/absoft.db` with the backup file (rename it to
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
cd ABSoft POS
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

- **Save `package.json` as UTF-8 without a BOM.** ABSoft POS strips one if it finds it, but other
  tools are less forgiving.
- **Keep `.cmd` files pure ASCII.** Batch scripts run in the console's OEM codepage, and a
  stray em-dash in a comment is enough to make `cmd` try to execute part of it.

### Their loop on the till

Close ABSoft POS, double-click **`update.cmd`**, start ABSoft POS again. It:

1. **Backs the database up first**, into `data/backups/`. If the backup fails it stops there
   rather than pressing on.
2. Runs `git pull --ff-only` — fast-forward only, so it will never quietly merge or rewrite.
3. Prints the new version number.

The database upgrades itself the first time the new version starts. Nothing else to do.

**Updated but not restarted?** If the files are newer than the ABSoft POS that is running, the app
says so in a yellow bar — *"ABSoft POS was updated — restart it to finish"* — instead of failing on a
new screen with an unhelpful error. Close ABSoft POS and start it again.

If someone has edited files on the shop's machine, the pull refuses rather than clobbering
them, and the script tells them exactly how to discard those edits (`git reset --hard`) —
noting that neither command touches `data/`.

**No Git on that machine?** Download the ZIP, unzip it over the folder replacing everything,
and **keep the `data` folder exactly as it is**. Run `npm run backup` first.

### Running the tests

```
npm test        server-side suites - no dependencies, works anywhere
npm run test:ui     browser suites - needs Edge and playwright-core
npm run test:all    both
```

Each suite starts its own copy of ABSoft POS on its own port against a throwaway
database under `.test-run/`, so running them never touches `data/`. The browser
suites need one test-only package:

```
npm install --no-save playwright-core
```

`tests/migrate-payments.test.mjs` is the one worth running before you ship: it
builds a database on the previous schema, updates it, and checks that settled
invoices are still settled and stock never moved.

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

Append to the array and you are done — ABSoft POS applies anything outstanding on the next start
and records how far it got in SQLite's own `user_version`. Each migration runs in a
transaction, so a failure rolls back rather than leaving a half-changed database.

Three rules:

- **Append only.** Never reorder, renumber or edit an entry that has already shipped — someone's
  database has already applied it and will not apply it again.
- **Make it safe to run twice.** Use the `hasColumn` / `hasTable` helpers.
- **Never drop or retype a column holding real data.** To replace a field, add the new one,
  backfill it in the same migration, and leave the old one alone.

If a database is somehow *newer* than the code (an older build installed over a newer one),
ABSoft POS refuses to start and says so, rather than guessing and corrupting it.

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
  entities.js       reusable names (customers, suppliers, categories, units)
  backup.js         consistent snapshots via VACUUM INTO
  autobackup.js     the daily and shift-close backups, and the second folder
  auth.js           scrypt password hashing, sessions
  http.js           tiny router, JSON body, static files
  util.js           money/quantity rounding, date ranges, doc numbers
  routes/           products, purchases, sales, expenses, reports, users, system
  tools/            seed.js, backup.js, reset.js
public/
  index.html
  css/app.css       design tokens, light + dark themes, RTL rules
  js/i18n.js        English + Arabic strings, plural forms, direction, error-code lookup
  js/chart-scale.js round-number axes for the charts (tested on its own)
  js/               api.js, ui.js, icons.js, main.js, views/
tests/              npm test - each suite runs its own server on a scratch database
data/absoft.db      your database (created on first run)
data/backups/       local snapshots (kept out of Git)
start.cmd           run ABSoft POS
update.cmd          back up, then pull the latest version from GitHub
```

### Adding another language

Everything user-visible lives in [`public/js/i18n.js`](public/js/i18n.js). Copy the `en` block,
translate the values, and add an entry to `LANGUAGES` with `dir: 'ltr'` or `'rtl'` — the layout
follows automatically, because the stylesheet uses CSS logical properties throughout rather
than hard-coded left/right.

---

Built by **Abbass Chokor**.
