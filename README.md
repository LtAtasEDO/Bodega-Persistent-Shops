# Bodega-Persistent-Shops
Persistent Cyberpunk RED bodegas with protected vendor ledgers and serialized purchases and live stock updates with GM-review protection of unverified stock. Fixer pricing and automatic Fixer gating with static+dynamic inventory with RollTable/pack sources, Simple Calendar traffic/restocking, with direct Monk's Active Tile binding.

This module was initially assisted by AI to converts the Bodega™ Manager v2.0.3/v2.0.3c macros to continue as the v2.3.x module line into a world-loaded Foundry module. Legacy macros can be found in Cyberpunk Red Foundry VTT shared content discord channel.

[Bodega™ Persistent Shops Wiki](https://github.com/LtAtasEDO/Bodega-Persistent-Shops/wiki)

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

For a macro, Monk's Active Tile/Trigger script:

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
- `game.bodega.openVendorToken(token)` — resolve and open a Bodega from a bound vendor Token.
- `game.bodega.resolveVendorToken(token)` — inspect which Bodega a vendor Token resolves to (specific Token first, then Actor-wide).
- `game.bodega.playerVendorInteractionMode()` — inspect the configured player vendor modifier-click mode.
- `game.bodega.launch(input)` — compatibility launcher.
- `game.bodega.loadAll()` / `saveAll(db)` — database access.
- `game.bodega.bind()` — manually ensure the socket bridge is bound.

## What changed from the macros

- The GM socket bridge loads automatically; the Autobind macro is no longer required.
- v2.0.3's full manager, ledger integration, Quick Add, and RollTable tools are retained.
- Edit Bodega labels the Wealth-linked purse target as **Ledger (Container/Player)**; CPR player Actors and Container Actors are the intended ledger sources.
- v2.0.3c's repaired player UI and GM buyback ACK/fallback flow are merged in.
- The socket channel is consolidated under the real module namespace, `module.bodega`.
- Each dialog receives its own DOM/CSS scope so multiple shop windows can coexist more safely.

## Vendor Token / Actor HUD binding (v2.3.6–v2.3.13)

Bodegas can now be opened directly from an NPC vendor's normal Foundry Token HUD. Open **Edit Bodega → Vendor Token / Actor HUD Binding** and use either binding mode:

- **Actor-wide Vendor** — drop an Actor or Token. Every Token using that Actor resolves to this Bodega. This is useful for a persistent Fixer or shopkeeper who appears on multiple Scenes.
- **Specific Token Override** — drop a Token. Only that exact Token on that Scene resolves to this Bodega. Exact Token bindings take priority over Actor-wide bindings, which is useful for Night Markets and one-off booths.

As of v2.3.13, the Specific Token area also includes **Bind Selected Token**. Foundry v12 can report a Canvas Token drag to an HTML dialog using an Actor-shaped payload, so Bodega now accepts the common Token payload variants and can resolve a matching single controlled Token. If drag/drop is still awkward, select exactly one placed NPC Token on the current Scene and click **Bind Selected Token**; this stores that exact Scene Token, not merely its Actor.

When a bound vendor's Token HUD is rendered, Bodega adds an **Open Bodega** storefront control for the GM. Opening through the vendor HUD uses the same Bodega shop path as Tiles/macros: serialized purchases, live stock, Preferred Customer pricing, Fixer restrictions, buybacks, dynamic stock, vendor purse/ledger, and package-aware transactions are unchanged.

### Player vendor interaction (v2.3.7–v2.3.8)

Players do **not** need ownership of the vendor NPC. Open **Configure Game Settings → Bodega → Player Vendor Token Interaction** to choose the world-wide gesture used to open a bound vendor:

- **Ctrl/Cmd + Left Click (Recommended)** — default as of v2.3.8.
- **Shift + Left Click** — optional, but may conflict with Foundry multi-Token selection.
- **Alt + Left Click** — optional, but may conflict with Token highlighting.
- **Disabled — GM Token HUD only**.

v2.3.12 hardens that player path further: Bodega now listens primarily on the actual Foundry HTML canvas/board in capture phase and uses visible Token renderer bounds for hit-testing, while retaining the PIXI-stage listener as a fallback. This protects unowned-vendor interaction from Token layers or other modules that stop PIXI propagation. Duplicate-event suppression prevents one Ctrl/Cmd-click from opening the shop twice. **Ctrl/Cmd + Left Click** remains the recommended default because live Foundry validation showed Shift and Alt already serve Token-selection/highlight behaviors. Only the configured gesture over an actual Bodega-bound vendor is consumed; ordinary clicks, modifier-clicks on unrelated Tokens, and modifier-clicks on empty canvas space remain Foundry-owned.

The GM Token HUD storefront control is always retained regardless of this setting. The setting changes only the extra player interaction path.

The vendor Token is excluded when Bodega chooses the customer Actor. Bodega prefers another controlled customer Token and otherwise falls back to `game.user.character`, so the shopkeeper is not accidentally treated as the buyer. Scene-only restrictions still apply to players.

API helpers:

```js
await game.bodega.resolveVendorToken(token);
await game.bodega.openVendorToken(token);
```

Tile binding remains fully supported; a world can freely mix Tiles, vendor Tokens, and direct macro/API storefronts.

## Preferred Customer discounts (v2.3.5)

A GM can reward specific characters with a shop-specific purchase discount without changing their Role. Open **Edit Bodega → Buyback / Vendor Cash**, then drag a PC Actor or Token into **Preferred Customer Discounts** and set that character's percentage.

- The discount is stored on that Bodega only.
- It applies to purchases regardless of the character's Role.
- It does **not** grant a non-Fixer access to Fixer-only inventory or bypass an item's minimum Operator Rank.
- If a qualifying Fixer also has a Preferred Customer discount, the better eligible discount wins; the two discounts do not stack.
- Final pricing is recalculated by the GM-authoritative serialized purchase processor, not trusted from the player UI.

The player shop displays a **Preferred Customer** banner and shows the list price crossed out when the relationship discount is active.

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

## v2.3.4–v2.3.11 unverified package safeguard and GM review
Bodega will never use an Actor's **current remaining stack quantity** as proof of the original market package size. For stackable non-ammo Items, automatic buyback is allowed when the package can be verified from Bodega market-package metadata or a resolvable source Item (including compendium/core/duplicate source UUIDs). If a stacked Gear/Drug/etc. has no trustworthy package provenance, the player UI shows **GM REVIEW REQUIRED**. This prevents, for example, one remaining cigarette from an unknown 20-pack being valued as an entire market pack.

As of v2.3.9, **GM Review is actionable** rather than a dead-end safety label. v2.3.10 refines that review window into a wider, resizable two-column layout with a responsive narrow-screen fallback. v2.3.11 makes the approval control explicitly interactive even when required package data is missing: clicking it focuses/highlights the missing field and explains what the GM must enter instead of silently doing nothing. The player selects how many units they want to sell and clicks **GM Review**. The active GM receives a Bodega-styled review dialog and must explicitly enter the original **units per market package** while verifying the package's market price. The dialog previews the exact buyback and refuses approval if it would be worth less than 1eb or exceed the vendor's current cash.

An approved review uses the normal serialized GM-authoritative buyback transaction. By default the reviewed package definition is stamped onto any remaining Actor stack, so later partial sales can be valued automatically. Cancelling or closing the GM review moves no inventory and no eurobucks; an open review stays pending until the GM makes a decision. Players cannot supply or spoof the trusted package override themselves; only the active GM review dialog can create it.

Atomic Items with no stack field remain ordinary single items. CPR ammo keeps the established conservative fallback rules when source metadata is missing: grenade/rocket 1, battery 8 (or an explicit description count), other standard ammo 10.
