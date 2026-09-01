# Bodega™ Changelog
## 2.3.14
- Replaced `assets/bodega.webp` with the new storefront + shopping-cart hybrid icon to better match the Cyberpunk RED core compendium visual language while keeping the established Bodega asset path intact.
- Updated README attribution and asset provenance notes for the packaged Bodega icon.
- The packaged icon is a modified derivative based on the SVG Repo **Store** and **Shopping Cart** CC0 vectors, remixed for Bodega and exported as the module's bundled WEBP asset.

## 2.3.13
- Fixed **Specific Token Override** binding after live Foundry v12 validation showed Canvas Token drags could arrive at the Edit Bodega HTML drop zone using Actor-shaped/non-`Token` drag payloads.
- Specific Token drops now use Foundry's `TextEditor.getDragEventData()` parser first, accept embedded Token UUID / scene+token identifier variants, and safely resolve an Actor-shaped Canvas drag to the exact Token when exactly one matching Token is controlled.
- Added **Bind Selected Token** beside the Specific Token Override drop zone as a deterministic fallback: select exactly one placed NPC Token on the Scene and bind that exact Scene Token without relying on browser drag payload shape.
- Specific Token identity remains Scene+Token specific and continues to override Actor-wide vendor bindings.
- Corrected Edit Bodega ledger wording from **Ledger (Container/NPC)** to **Ledger (Container/Player)**, including drop-zone/help/warning text. Ledger behavior itself is unchanged.

## 2.3.12
- Hardened the live player **Ctrl/Cmd + Left Click** vendor interaction after server validation showed the PIXI-stage listener could disappear or be swallowed even though no v2.3.10/v2.3.11 code changed that feature.
- Player vendor access now binds primarily to the actual Foundry HTML canvas/board pointer event in capture phase and hit-tests visible Token renderer bounds, so unowned vendor NPCs remain reachable even when another module or Token layer stops PIXI propagation.
- The existing PIXI-stage listener is retained as a secondary fallback for renderer/canvas configurations where the HTML board element cannot be resolved.
- Added duplicate-event suppression so the DOM and PIXI paths cannot open the same Bodega twice from one gesture.
- Only the configured modifier-click over a Bodega-bound Token is consumed; Ctrl/Cmd-clicks on unrelated Tokens or empty canvas space continue to pass through untouched.
- Player interaction automatically rebinds when the Bodega interaction setting changes and on every `canvasReady` event.
- Added `game.bodega.rebindVendorInteraction()` as a troubleshooting/helper API without changing GM Token HUD, vendor bindings, shop transactions, or the v2.3.11 GM Buyback Review behavior.

## 2.3.11
- Fixed confusing **GM Buyback Review** approval behavior found in live validation: the Approve button was silently disabled until **Units per market package** was entered, which made the working review handler look broken.
- **Approve Buyback** now always responds. If package size is missing/invalid it warns the GM, focuses and highlights the required field, and leaves the review open.
- Added a visible **Required** marker and clearer examples for market package size (1 single item, 10-round ammo box, 20-count cigarette pack).
- The offer preview and button readiness still update live, but only the short processing window uses the native disabled state.
- Invalid sub-1eb offers and insufficient vendor cash now return explicit GM notifications instead of an inert approval control.
- No transaction math, package provenance, serialized buyback, vendor-purse, or player/GM authority behavior changed.

## 2.3.10
- Refined the **GM Buyback Review** dialog after live validation showed the v2.3.9 form was opening at Foundry's default narrow Dialog width and clipping the package fields.
- Moved Dialog sizing into the proper Foundry v12 application-options argument and set the review window to a resizable 720px default width.
- Rebuilt the review content with a compact two-column summary, two-column market-package form, full-width offer preview, wrapped remember-definition control, and cleaner approval spacing.
- Added responsive one-column fallback styling for narrower displays while preserving the same serialized GM-authoritative review/approval transaction behavior.

## 2.3.9
- Fixed the **GM Review** control for unverified stacked-item buybacks; it was previously rendered as a disabled safety label with no actionable workflow.
- Players can now choose the quantity they want reviewed and click **GM Review**. The request is sent only to the active GM; no item or eurobucks move until GM approval.
- Added a dark Bodega-styled **GM Buyback Review** dialog showing seller, item, current Actor stack, requested quantity, buyback percentage, and available vendor cash.
- The GM must explicitly enter **Units per market package** and can verify/edit the market package price. Bodega never pre-assumes the Actor's current remaining stack is the original package size.
- The review dialog previews the exact whole-eb offer and prevents approval when the offer is below 1eb or exceeds the vendor purse/linked ledger balance.
- Approved reviews run through the same per-Bodega serialized GM-authoritative buyback queue as normal sales, preserving purse, ledger, trade-in, package, and rollback protections.
- By default, a GM-approved package definition is remembered on any remaining Actor stack so future partial buybacks do not require repeated review.
- Review cancellation/closing returns a clean failure to the player and leaves both inventory and money untouched; an open review stays pending until the GM decides.

## 2.3.8
- Fixed player vendor opening for **unowned NPC Tokens**. v2.3.7 wrapped Foundry's Token click handler, but players without ownership can be prevented from reaching that control path at all.
- Player vendor interaction now listens at the **canvas pointer layer** and hit-tests visible Tokens under the cursor, so no Actor/Token ownership is required.
- Changed the default/recommended gesture to **Ctrl/Cmd + Left Click** after live Foundry validation showed Shift-click is already used for multi-Token selection and Alt-click is used for Token highlighting.
- Shift/Alt remain optional compatibility choices with conflict warnings; Disabled still leaves the GM Token HUD storefront path intact.
- Only the configured gesture over an actual Bodega-bound vendor is consumed. Normal clicks, modifier-clicks on unrelated Tokens, and modifier-clicks on empty canvas space pass through untouched.
- Specific Token Night Market overrides still take priority over Actor-wide vendor bindings. GM Token HUD behavior and all shop transaction logic are unchanged.

## 2.3.7
- Added configurable **Player Vendor Token Interaction** under **Configure Game Settings → Bodega** so players can open bound NPC vendors without Actor/Token ownership.
- Default player gesture is **Shift + Left Click**; alternate **Alt + Left Click**, **Ctrl/Cmd + Left Click**, and **Disabled — GM Token HUD only** modes are available.
- Normal unmodified Token clicks are never intercepted, preserving targeting and other Token interactions.
- Player interaction resolves the same specific-Token-first / Actor-wide-second vendor binding used by the GM Token HUD and opens the normal serialized Bodega shop path.
- Player vendor interaction is gated by the existing scene-only availability rules and uses the player's controlled customer Actor or assigned Character; no ownership is granted on the NPC vendor.
- Added a libWrapper-compatible Token click wrapper with a standalone fallback so Bodega does not require libWrapper to provide player vendor access.
- GM Token HUD storefront controls from v2.3.6 remain unchanged and are always available regardless of the player-interaction setting.

## 2.3.6
- Added per-Bodega **Vendor Token / Actor HUD Binding** in Edit Bodega.
- Actor-wide bindings make every placed Token using that Actor resolve to the configured Bodega.
- Specific Token bindings affect only that exact Token on that Scene and take priority over Actor-wide bindings, allowing one NPC appearance to run a different booth/shop.
- Bound vendor Tokens receive an **Open Bodega** storefront button in Foundry's Token HUD when the HUD is rendered.
- Vendor HUD opening excludes the vendor Token from customer selection and falls back to the user's assigned Character, preventing the NPC shopkeeper from accidentally becoming the buyer.
- Scene-only Bodega restrictions remain enforced for players; GMs retain their existing preview/access behavior.
- Binding conflicts are hardened: an Actor-wide vendor can belong to only one Actor-wide Bodega at a time, and an exact Token can belong to only one Token-specific Bodega at a time.
- Added `game.bodega.openVendorToken(token)` and `game.bodega.resolveVendorToken(token)` API helpers.
- Bodega Manager cards now summarize Actor/Token HUD binding counts alongside Tile bindings.
- Scoped Face-chip removal handling so Vendor binding chips cannot accidentally remove a shop portrait when their own remove button is clicked.

## 2.3.5
- Added per-Bodega **Preferred Customer Discounts** for specific Actors/Tokens, intended for relationship/job rewards regardless of Role.
- Preferred customers are configured in **Edit Bodega → Buyback / Vendor Cash** by dropping a PC Actor/Token and setting a 0–100% purchase discount.
- Preferred-customer pricing applies to all normally accessible stock at that Bodega, but never bypasses Fixer-only visibility or minimum Operator Rank requirements.
- If a Fixer also has a preferred-customer discount, Bodega uses the better eligible discount instead of stacking percentages.
- The GM-authoritative serialized purchase path recalculates the preferred-customer discount server-side, so the player UI cannot spoof a discounted price.
- Player shop UI shows a **Preferred Customer** banner and crossed-out list pricing when the relationship discount applies.

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
