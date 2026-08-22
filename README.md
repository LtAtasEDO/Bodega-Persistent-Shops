# Bodega-Persistent-Shops
Persistent Cyberpunk RED bodegas with protected vendor ledgers and serialized purchases and live stock updates with GM-review protection of unverified stock. Fixer pricing and automatic Fixer gating with static+dynamic inventory with RollTable/pack sources, Simple Calendar traffic/restocking, with direct Monk's Active Tile binding.
This module converts the Bodega™ Persistent Shops v2.0.3/v2.0.3c macros and continues as the v2.3.x module line into a world-loaded Foundry module.

Module assisted by AI to help convert macro into module. Legacy macro can be found in Cyberpunk Red Foundry VTT shared content discord channel.

## Install

1. Shut down the Foundry world.
2. Extract the included `bodega` folder into `FoundryVTT/Data/modules/`.
3. Start Foundry and enable **Bodega™ Persistent Shops** in the world.
4. Disable or delete the old Bodega Persistent Shops and Autobind macros after confirming the module works.

The module deliberately keeps the original `bodega.db` world setting, so existing configured shops should appear without rebuilding them.

## Open the manager

As GM, choose the **Bodega™ Manager** storefront icon in the Token scene controls, or run:

```js
game.bodega.openAdmin();
```

## Open a shop

For a macro, Monk's Active Tile/Trigger script, or another module:

```js
return game.bodega.openShop("your-shop-id");
```

Compatibility launcher syntax is also available:

```js
return game.bodega.launch({ id: "your-shop-id" });
```

## Module API

- `game.bodega.openAdmin()` — GM shop manager.
- `game.bodega.openOptions()` — global Bodega options.
- `game.bodega.openShop(id)` — player-facing shop.
- `game.bodega.launch(input)` — compatibility launcher.
- `game.bodega.loadAll()` / `saveAll(db)` — database access.
- `game.bodega.bind()` — manually ensure the socket bridge is bound.

## What changed from the macros

- The GM socket bridge loads automatically; the Autobind macro is no longer required.
- v2.0.3's full manager, ledger integration, Quick Add, and RollTable tools are retained.
- v2.0.3c's repaired player UI and GM buyback ACK/fallback flow are merged in.
- The socket channel is consolidated under the real module namespace, `module.bodega`.
- Each dialog receives its own DOM/CSS scope so multiple shop windows can coexist more safely.

## Tile binding (v2.2.0)

Each Bodega entry now shows its direct tile script and has **Bind Selected** / **Unbind Selected** controls. Select one or more Foundry Tiles as GM, then use the buttons on that Bodega entry.

For bound tiles, create/update the helper macro from the Manager:

```js
return game.bodega.openBoundTile({
  args: typeof args === "undefined" ? null : args,
  tile: typeof tile === "undefined" ? null : tile,
  token: typeof token === "undefined" ? null : token,
  actor: typeof actor === "undefined" ? null : actor
});
```

The direct per-shop script remains supported:

```js
game.bodega.openShop("your-shop-id")
```

## v2.2.0 UI and purse hardening

- Player/admin UI now uses the dark charcoal, cyan, yellow, and high-contrast styling used across the local Night City modules.
- Vendor portraits are intentionally 144px square in player view.
- Dialog body IDs are always CSS-safe, fixing the intermittent player-only giant-avatar/unreadable-text bug caused when `randomID()` began with a digit.
- Scoped dialog CSS is retained through Foundry's close animation, preventing the vendor portrait from flashing at its natural image size after Close.
- Buybacks are serialized per shop and ledger debits refuse to cross below 0 eb.

### v2.2.1 macro icon
The module packages `assets/bodega.webp` and uses it for the `Bodega™ — Open Bound Tile` helper macro. Running **Create / Update Tile Helper** will also replace the old helper icon with the packaged Bodega WEBP.


## Dynamic inventory (v2.3.0)

Each Bodega can now remain fully **Static** or opt into a **Dynamic Inventory** simulation driven by Simple Calendar. The simulation deliberately separates stock into three classes:

- **Static** — existing/manual GM stock. Never changed by background customers or deliveries.
- **Dynamic** — generated stock. NPC customers can reduce it and daily deliveries can replenish/rotate it.
- **Trade-In** — items bought from PCs. Protected from the background simulation.

### Default cadence

A newly enabled Dynamic Bodega defaults to:

- 5–10 generated Dynamic products.
- 1–6 units per generated product.
- 2–3 randomized NPC customer cycles per in-game day.
- One daily restock at 06:00 Simple Calendar time.
- **Rotate & Refill** restocking.

NPC customer traffic only removes stock. Restocking is the only background process that can replenish Dynamic items.

### Dynamic sources

Open a Bodega's editor and choose one of:

- **RollTable** — UUID, world name, or `pack::table name`; multiple references can be separated by commas/new lines. Nested RollTables are supported.
- **Compendium Pack** — one or more Item pack keys.
- **Curated List** — drag Item documents into the curated list or add by name.

The editor includes **Test Source**, **Generate Stock**, **Run Customer Cycle**, and **Restock Now** controls for live validation without advancing the calendar.

### Daily restock behavior

- **Rotate & Refill** removes sold-out Dynamic products, may rotate very low-stock products, refills surviving Dynamic rows, then draws replacements until the configured product target is reached.
- **Refill Shelves** keeps the same Dynamic products, restores their quantities, and only draws more if the shelf is below its target product count.

### Time skips and multiple GMs

Long Simple Calendar jumps do not replay days of events one-by-one. Bodega collapses skipped deliveries to the latest relevant restock and resolves only the customer activity that still matters to the current shelf state. Calendar processing runs only on Simple Calendar's primary GM when available (with Foundry's active GM as the fallback).

### Dynamic API

```js
await game.bodega.generateDynamicStock("your-shop-id", true);
await game.bodega.runCustomerCycle("your-shop-id");
await game.bodega.restockNow("your-shop-id");
await game.bodega.processDynamicInventory();
```

Simple Calendar is recommended for automatic timing; the editor's manual test buttons still work without it.


## v2.3.1 UI / source cleanup

- Static Bodega Compendium and RollTable overrides now accept multiple references separated by commas, semicolons, or new lines.
- Default source fields in Bodega Options also accept multiple Item packs and RollTables.
- Added an optional automatic Fixer-only price gate with a configurable eurobuck threshold (default 500 eb). Automatically applied locks are tracked independently from manual Fixer-only flags.
- Dynamic Stock Source and Daily Restock Behavior selectors have fixed readable widths.
- The Curated List search/drop controls are now labeled and shown only when **Curated List** is the selected Dynamic Stock Source.
- Restyled GM dialogs with a dark Choom Trade/Vendit-inspired Foundry window chrome instead of the grey host background.
- Tightened Bodega Manager toolbar/card actions and moved Tile scripts into a dedicated full-width strip so long IDs cannot bleed into the button area.


## v2.3.2 live transaction notes
Player purchases are processed by the active GM through a per-Bodega serialized transaction queue. Open player shop windows receive committed stock quantities immediately, including Sold Out state. The curated Dynamic Item search now uses a bounded scrollable result panel rather than a static text-only search field.


## Package-aware buybacks
Cyberpunk RED uses stack quantities such as `system.amount: 10` for many market packages. Bodega stores the original market package size on newly stocked/purchased Items and resolves compendium source metadata for existing Actor Items. Buyback offers are prorated by the number of individual units sold, then rounded down once to whole eurobucks. Example: a 10-round 100eb ammunition package at a 50% buyback rate is worth 50eb for all 10 rounds, 25eb for 5 rounds, and 5eb for 1 round. Very cheap partial quantities can be worth less than 1eb; sell more units at once to receive a whole-eb offer.

Bodega quantity on the shop side remains package/item quantity. Buying two 10-round packages delivers 20 rounds to the Actor. Grenades and rockets whose source amount is 1 remain single-unit purchases.

## v2.3.4 unverified package safeguard
Bodega will never use an Actor's **current remaining stack quantity** as proof of the original market package size. For stackable non-ammo Items, automatic buyback is allowed when the package can be verified from Bodega market-package metadata or a resolvable source Item (including compendium/core/duplicate source UUIDs). If a stacked Gear/Drug/etc. has no trustworthy package provenance, the player UI shows **GM REVIEW REQUIRED** and automatic buyback is disabled; the GM-side transaction processor enforces the same rule. This prevents, for example, one remaining cigarette from an unknown 20-pack being valued as an entire market pack.

Atomic Items with no stack field remain ordinary single items. CPR ammo keeps the established conservative fallback rules when source metadata is missing: grenade/rocket 1, battery 8 (or an explicit description count), other standard ammo 10.
