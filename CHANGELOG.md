# Bodega™ Changelog

## 2.3.4
- Added defensive package-provenance validation for buybacks of stackable non-ammo Items such as cigarette packs, multi-dose Drugs, and other Gear using `system.amount`/stack fields.
- Bodega-stamped package metadata and resolvable source Items remain authoritative; `_stats.duplicateSource` is also accepted as a traceable source UUID.
- Untraceable stacked non-ammo Actor Items are no longer assumed to be one full-price market item. Player UI marks them **GM REVIEW REQUIRED** and disables automatic sale.
- The GM-authoritative buyback processor independently rejects unverified stacked Items, preventing socket/chat/UI bypass of the safeguard.
- Atomic Items with no stack field remain safe as single items, and the existing CPR ammo fallback rules remain unchanged.

## 2.3.3
- Replaced the clipped Dynamic Stock Source and Daily Restock Behavior select sizing with the same native auto-height approach used by Vendit, preventing selected-value text from being vertically cut off under Cyberpunk RED's Foundry theme.
- Added market-package metadata to stocked Items. A source Item with `system.amount: 10` is treated as one 10-unit market package, while grenades/rockets with `amount: 1` remain single units.
- Fixed multi-package purchases: buying 2 ten-round ammo packages now delivers 20 rounds, not 11.
- Buybacks now prorate the vendor offer by market package size. Selling one round from a 10-round/100eb package is valued as one tenth of the package before applying the configured buyback percentage.
- Cheap fractional buybacks are totaled before rounding to whole eurobucks, so players can sell several low-value rounds together without the old full-pack exploit.
- Bodega-bought stacked Items receive market-package flags, allowing correct resale math even after their live stack quantity changes.
- Existing compendium-sourced Actor Items resolve their original package size from `compendiumSource` / `core.sourceId`; ammo has conservative CPR fallbacks (grenade/rocket 1, battery 8, other ammo 10) when source metadata is unavailable.
- Partial package buybacks become loose Trade-In units priced per constituent unit, preventing a single loose round from re-entering the Bodega as a full-price package.
- Ledger inventory now receives exactly the quantity actually sold instead of accidentally cloning the seller's entire current stack.

## 2.3.2
- Fixed vertically clipped Dynamic Stock Source and Daily Restock Behavior selects in the Edit Bodega window.
- Added an explicit scrollable Curated Item Search result panel populated from world Items and Item compendiums.
- Added live player stock quantity updates after purchases, including Sold Out state and quantity-input clamping.
- Purchases are now GM-authoritative and serialized through the same per-Bodega transaction queue used by buybacks, preventing simultaneous buyers/sellers from racing stale stock or purse values.
- Purchase ACKs include the committed remaining quantity and vendor purse so the player UI refreshes immediately without reopening the Bodega.

## 2.3.1

- Added comma/newline multi-source support to static Compendium Pack and RollTable fields, including defaults and static Test Roll.
- Added optional automatic Fixer-only price gating with a configurable eb threshold.
- Clarified and conditionally displayed the curated Dynamic stock search controls.
- Fixed clipped Dynamic Stock Source and Restock Behavior selectors.
- Refined GM dialog/window styling and removed the grey Foundry host background.
- Compacted Bodega Manager controls and isolated Tile script text from action buttons.

## 2.3.0
- Added per-Bodega **Static / Dynamic / Trade-In** inventory classes. Existing and manually added stock remains Static; player buybacks are explicitly Trade-In; only Dynamic rows are touched by background simulation.
- Added Simple Calendar-driven NPC customer traffic with a default of **2–3 randomized customer cycles per in-game day**. Customer traffic only reduces Dynamic stock and never replenishes it.
- Added **once-daily restocking** with configurable in-game hour/minute. Default restock time is 06:00.
- Added restock behaviors: **Rotate & Refill** (sold-out/low stock may be replaced) and **Refill Shelves** (keep the same dynamic products and replenish them).
- Added Dynamic stock sources from RollTable(s), Item Compendium pack(s), or a curated drag/drop Item list.
- Added editor test controls: **Test Source**, **Generate Stock**, **Run Customer Cycle**, and **Restock Now**.
- Added Manager status for Dynamic/Static shops plus next customer/restock countdowns when Simple Calendar is available.
- Added long-time-jump catch-up behavior that collapses skipped deliveries/customer activity instead of replaying a large queue of events.
- Dynamic calendar processing is restricted to the Simple Calendar primary GM / active GM fallback so multiple GMs do not double-process stock.
- Hardened player stock socket writes by including an item identity key, reducing stale-index problems if background inventory changed while a shop window was open.
- Player trade-ins no longer merge into Dynamic stock, so invisible NPC customers cannot consume a PC-sold item.

## 2.2.1
- Packaged the Bodega helper/binder icon as `assets/bodega.webp`.
- The `Bodega™ — Open Bound Tile` helper macro now uses `modules/bodega/assets/bodega.webp` instead of `icons/svg/anchor.svg`.
- Updating an existing helper macro also refreshes its icon automatically.

## 2.2.0
- Added direct GM Tile binding/unbinding from each Bodega entry.
- Added a generated Monk's Active Tile helper macro and bound-tile resolver.
- Added per-entry direct Tile script display.
- Added multi-Tile binding metadata while preserving existing `bodega.db` shops.
- Restyled manager/player UI with dark charcoal, cyan, yellow, and high-contrast text.
- Increased player-facing vendor portraits to 144px square.
- Fixed intermittent player UI skin failure when random dialog IDs began with a digit.
- Fixed vendor avatar flash during Foundry's dialog close animation.
- Serialized buybacks per shop and prevented linked ledger balances from being debited below 0 eb.


## 2.1.0

- Converted the Bodega™ macros into a Foundry VTT v12 module.
- Preserved the existing `bodega.db` storage namespace.
- Automatically binds the GM socket bridge on world load.
- Merged the complete v2.0.3 manager/ledger features with the v2.0.3c player interface and buyback acknowledgement behavior.
- Added `game.bodega` API and a GM scene-control button.
- Consolidated socket traffic under `module.bodega`.
