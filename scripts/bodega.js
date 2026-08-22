/**
 * Bodega™ Persistent Shops — Foundry VTT Module v2.3.4
 *
 * Ported from the Bodega™ v2.0.3 / v2.0.3c macros for Foundry VTT 12.
 * Keeps the existing world setting namespace (bodega.db) so configured shops migrate in place.
 */

(() => {
"use strict";

const MODULE_ID = "bodega";
const MODULE_VERSION = "2.3.4";
const SOCKET = `module.${MODULE_ID}`;
let isGM = false;
let sceneId = null;
let calendarHookBound = false;
let calendarProcessing = false;
// ---------- World Script: Bodega Socket Binder (late-load safe) ----------
function bindBodegaBridge() {
  if (game.socket._bodegaBound === MODULE_VERSION) return;

  game.socket.on(SOCKET, async (msg) => {
    if (!msg) return;

    // UI broadcasts are processed by every client.
    if (msg.op === "purse-ui") {
      document.querySelectorAll(`.v-purse[data-shop="${msg.id}"]`).forEach(inp => inp.value = String(msg.purse|0));
      document.querySelectorAll(`.wrap[data-shop="${msg.id}"] .purse-val`).forEach(el => el.textContent = String(msg.purse|0));
      return;
    }
    if (msg.op === "purse-ack") {
      window.__bodegaAck ||= {};
      window.__bodegaAck[msg.id] = Date.now();
      return;
    }
    if (msg.op === "stock-ui") {
      updateOpenShopStock(msg.id, msg.itemKey, msg.stockClass, msg.qty);
      return;
    }
    if (msg.op === "buyback-done" || msg.op === "buyback-failed" || msg.op === "purchase-done" || msg.op === "purchase-failed") return;

    // Only the active GM may persist shop, stock, ledger, purchase, or buyback changes.
    // This prevents duplicate transactions when more than one GM account is connected.
    if (!game.user?.isGM) return;
    if (game.users?.activeGM?.id && game.users.activeGM.id !== game.user.id) return;

    if (msg.op === "stock") {
      const db = await loadAll();
      const v = db.shops?.[msg.id];
      if (v) {
        let target = v.items?.[msg.index] ?? null;
        if (msg.itemKey){
          const byKey = (v.items || []).find(item => dynamicItemKey(item) === msg.itemKey && (!msg.stockClass || item.stockClass === msg.stockClass));
          if (byKey) target = byKey;
        }
        if (target){ target.qty = Math.max(0, Number(msg.qty|0)); await saveAll(db); }
      }
      return;
    }

    if (msg.op === "purse") {
      const db = await loadAll();
      const v = db.shops?.[msg.id];
      if (v) {
        v.purse = Math.max(0, Number(msg.purse|0));
        await saveAll(db);
        game.socket.emit(SOCKET, {op:"purse-ui", id:msg.id, purse:v.purse});
        game.socket.emit(SOCKET, {op:"purse-ack", id:msg.id, purse:v.purse});
      }
      return;
    }

    if (msg.op === "add") {
      const db = await loadAll();
      const shop = db.shops?.[msg.id];
      if (!shop || !msg.item) return;
      const hit = (shop.items || []).find(x => x.name === msg.item.name && (x.price|0) === (msg.item.price|0));
      if (hit) hit.qty = Math.max(0, Number((hit.qty || 0)|0) + (msg.item.qty || 1));
      else {
        shop.items ||= [];
        shop.items.push(msg.item);
      }
      await saveAll(db);
      return;
    }

    if (msg.op === "ledger-wealth") {
      const ledger = await fromUuid(msg.ledgerUuid);
      if (!ledger) return;
      await adjustLedgerWealth(ledger, Number(msg.delta|0), String(msg.reason || "Bodega"));
      const purseNow = Number(ledger.system?.wealth?.value|0);
      game.socket.emit(SOCKET, {op:"purse-ui", id:msg.id, purse:purseNow});
      game.socket.emit(SOCKET, {op:"purse-ack", id:msg.id, purse:purseNow});
      return;
    }

    if (msg.op === "gm-buyback") {
      const nonce = msg.payload?.nonce;
      try {
        const result = await gmProcessBuyback(msg.payload);
        game.socket.emit(SOCKET, {
          op: result?.ok ? "buyback-done" : "buyback-failed",
          id:msg.payload?.shopId,
          nonce,
          message:result?.message || "The buyback could not be completed."
        });
      } catch (error) {
        console.error("Bodega | GM buyback failed", error);
        game.socket.emit(SOCKET, {op:"buyback-failed", id:msg.payload?.shopId, nonce, message:"GM buyback failed — check the console."});
        ui.notifications.error("Bodega GM buyback failed — check the console.");
      }
    }

    if (msg.op === "gm-purchase") {
      const nonce = msg.payload?.nonce;
      try {
        const result = await gmProcessPurchase(msg.payload);
        game.socket.emit(SOCKET, {
          op: result?.ok ? "purchase-done" : "purchase-failed",
          id:msg.payload?.shopId,
          nonce,
          userId:msg.payload?.userId || null,
          message:result?.message || (result?.ok ? "Purchase completed." : "The purchase could not be completed."),
          itemKey:result?.itemKey || msg.payload?.itemKey || "",
          stockClass:result?.stockClass || msg.payload?.stockClass || "",
          qtyRemaining:result?.qtyRemaining,
          qtyPurchased:result?.qtyPurchased,
          total:result?.total,
          purse:result?.purse
        });
      } catch (error) {
        console.error("Bodega | GM purchase failed", error);
        game.socket.emit(SOCKET, {op:"purchase-failed", id:msg.payload?.shopId, nonce, userId:msg.payload?.userId || null, message:"GM purchase failed — check the console."});
        ui.notifications.error("Bodega GM purchase failed — check the console.");
      }
    }
  });

  // Supports fallback approval cards, including existing cards and popped-out chat.
  document.addEventListener("click", async (ev) => {
    const btn = ev.target?.closest?.("[data-bodega-approve]");
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (!game.user?.isGM) return ui.notifications.warn("Only a GM can approve this.");
    try {
      const result = await gmProcessBuyback(a2b(btn.getAttribute("data-bodega-approve")));
      if (result?.ok) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-check"></i> Approved';
      }
    } catch (error) {
      console.error("Bodega | Approval payload failed", error);
      ui.notifications.error("Couldn’t process that approval payload.");
    }
  }, true);

  game.socket._bodegaBound = MODULE_VERSION;
  console.log(`Bodega | Socket bridge bound v${MODULE_VERSION} for ${game.user?.name}`);
}

// -------------------- quantity stack helpers --------------------
function readStackQty(it){
  const s = it.system ?? {};
  return Number(
    s.quantity ?? s.qty ?? s.amount ?? s.count ?? s.value ??
    s.rounds ?? s.bullets ?? s.charges ?? s.uses ?? s.ammo ?? 1
  ) || 1;
}
async function writeStackQty(it, newQty){
  const p = it.system ?? {};
  const v = Math.max(0, Number(newQty|0));
  const field =
    ("quantity" in p) ? "system.quantity" :
    ("qty" in p)      ? "system.qty" :
    ("amount" in p)   ? "system.amount" :
    ("count" in p)    ? "system.count" :
    ("value" in p)    ? "system.value" :
    ("rounds" in p)   ? "system.rounds" :
    ("bullets" in p)  ? "system.bullets" :
    ("charges" in p)  ? "system.charges" :
    ("uses" in p)     ? "system.uses" :
    ("ammo" in p)     ? "system.ammo" : null;
  if (field){ await it.update({[field]: v}); return; }
  if (v<=0) await it.parent?.deleteEmbeddedDocuments("Item", [it.id]);
}

function resolveQtyField(sys={}) {
  if ("quantity" in sys) return "quantity";
  if ("qty"      in sys) return "qty";
  if ("amount"   in sys) return "amount";
  if ("count"    in sys) return "count";
  if ("value"    in sys) return "value";
  if ("rounds"   in sys) return "rounds";
  if ("bullets"  in sys) return "bullets";
  if ("charges"  in sys) return "charges";
  if ("uses"     in sys) return "uses";
  if ("ammo"     in sys) return "ammo";
  return null;
}

/** Number of constituent units sold for one market-price package on a source Item. */
function marketPackageSizeFromData(docOrData){
  const sys = docOrData?.system ?? {};
  const field = resolveQtyField(sys);
  if (!field) return 1;
  return Math.max(1, Number(sys[field] ?? 1) || 1);
}
function bodegaMarketFlags(docOrData){
  return docOrData?.flags?.[MODULE_ID]?.marketPackage || {};
}
function sourceUuidForMarketPackage(doc){
  return doc?._stats?.compendiumSource
    || doc?.flags?.core?.sourceId
    || doc?._stats?.duplicateSource
    || bodegaMarketFlags(doc)?.sourceUuid
    || null;
}
function inferAmmoMarketPackageSize(doc){
  if (String(doc?.type || '').toLowerCase() !== 'ammo') return 1;
  const variety = String(doc?.system?.variety || '').toLowerCase();
  if (variety === 'grenade' || variety === 'rocket') return 1;
  if (variety === 'battery') {
    const html = String(doc?.system?.description?.value || '');
    const match = html.match(/contains\s+(\d+)\s+(?:shots?|rounds?|charges?)/i);
    return Math.max(1, Number(match?.[1] || 8));
  }
  return 10;
}
async function resolveMarketPackageInfo(doc){
  const flags = bodegaMarketFlags(doc);
  const flaggedSize = Number(flags.size || 0) || 0;
  let packageSize = flaggedSize;
  let marketPrice = Math.max(0, Number(flags.price || 0) || 0);
  const sourceUuid = sourceUuidForMarketPackage(doc);
  let verified = flaggedSize > 0;
  let provenance = verified ? "bodega-metadata" : "unknown";

  if (sourceUuid){
    try {
      const source = await fromUuid(sourceUuid);
      if (source){
        packageSize = marketPackageSizeFromData(source);
        marketPrice = getItemMarketValue(source);
        verified = true;
        provenance = "source";
      }
    } catch {}
  }

  if (!packageSize){
    const itemType = String(doc?.type || '').toLowerCase();
    const qtyField = resolveQtyField(doc?.system ?? {});
    if (itemType === 'ammo'){
      // CPR ammo has stable market-package conventions even when imported source metadata is missing.
      packageSize = inferAmmoMarketPackageSize(doc);
      verified = true;
      provenance = "cpr-ammo-fallback";
    } else if (!qtyField){
      // A document with no stack/amount field is inherently one atomic market item.
      packageSize = 1;
      verified = true;
      provenance = "atomic-item";
    } else {
      // Never interpret an Actor's current remaining stack as its original market package.
      // It could be 3 cigarettes left from a 20-pack, 2 doses from a larger drug pack, etc.
      packageSize = 1;
      verified = false;
      provenance = "unverified-stack";
    }
  }

  if (!marketPrice) marketPrice = getItemMarketValue(doc);
  return {
    packageSize:Math.max(1, packageSize|0),
    marketPrice:Math.max(0, marketPrice|0),
    sourceUuid,
    verified:!!verified,
    provenance,
    requiresReview:!verified
  };
}
function proportionalBuybackTotal(marketPrice, percent, quantity, packageSize=1){
  const numerator = Math.max(0, Number(marketPrice || 0)) * Math.max(0, Number(percent || 0)) * Math.max(0, Number(quantity || 0));
  const denominator = 100 * Math.max(1, Number(packageSize || 1));
  return Math.max(0, Math.floor(numerator / denominator));
}
function proportionalUnitRetail(marketPrice, packageSize=1){
  if (Math.max(0, Number(marketPrice || 0)) <= 0) return 0;
  return Math.max(1, Math.floor(Number(marketPrice || 0) / Math.max(1, Number(packageSize || 1))));
}
function stampMarketPackageFlags(data, {size=1, price=0, sourceUuid=null}={}){
  data.flags ||= {};
  data.flags[MODULE_ID] ||= {};
  data.flags[MODULE_ID].marketPackage = {
    size:Math.max(1, Number(size || 1)|0),
    price:Math.max(0, Number(price || 0)|0),
    sourceUuid:sourceUuid || null
  };
  return data;
}

/** Give item from shop with a specific quantity, using stack field when available. */
async function giveFromShopQty(actor, shopItem, qty=1){
  qty = Math.max(1, Number(qty|0));
  let doc = shopItem.uuid ? await byUUID(shopItem.uuid) : null;
  let data;

  if (doc) {
    data = doc.toObject();
  } else if (shopItem.raw) {
    data = foundry.utils.duplicate(shopItem.raw);
  } else {
    ui.notifications.warn("Item no longer exists for sale.");
    return null;
  }

  delete data._id;

  const sys = data.system ?? {};
  const field = resolveQtyField(sys);
  const sourcePackageSize = Math.max(1, Number(shopItem.packageSize || marketPackageSizeFromData(data)) || 1);
  const sourceMarketPrice = Math.max(0, Number(shopItem.marketPackagePrice ?? getItemMarketValue(doc || {system:sys})) || 0);
  stampMarketPackageFlags(data, {size:sourcePackageSize, price:sourceMarketPrice, sourceUuid:shopItem.uuid || doc?.uuid || null});

  if (field) {
    // Bodega QTY is packages/items. A source entry with amount 10 is one 10-round package,
    // so buying 2 must deliver 20 constituent units rather than 11.
    sys[field] = sourcePackageSize * qty;
    // Loose trade-ins can carry a per-unit market price distinct from the original package.
    if ((shopItem.tradeIn || shopItem.stockClass === "tradein") && shopItem.marketPackagePrice != null){
      if (sys.price?.market != null) sys.price.market = Math.max(0, Number(shopItem.marketPackagePrice|0));
      else if (typeof sys.price === "number") sys.price = Math.max(0, Number(shopItem.marketPackagePrice|0));
    }
    data.system = sys;
    return actor.createEmbeddedDocuments("Item", [data]);
  } else {
    // No stackable field → create N copies. Stamp each copy so a later buyback retains source pricing metadata.
    const payload = Array.from({length: qty}, () => stampMarketPackageFlags(foundry.utils.duplicate(data), {size:1, price:sourceMarketPrice, sourceUuid:shopItem.uuid || doc?.uuid || null}));
    return actor.createEmbeddedDocuments("Item", payload);
  }
}

const STORE_NS = "bodega";
const STORE_KEY = "db";
const FLAG_VER  = 5; // v5 adds market-package metadata for safe proportional buybacks

// -------------------- tiny utils --------------------
const esc = (s="") => String(s)
  .replaceAll("&","&amp;").replaceAll("<","&lt;")
  .replaceAll(">","&gt;").replaceAll('"',"&quot;")
  .replaceAll("'","&#039;");

// CSS selectors cannot safely target an unescaped ID that begins with a digit.
// Prefix every dialog body ID so randomID() can never create the old player-only skin failure.
function makeUiId(kind="ui"){
  return `bodega-${kind}-${randomID()}`;
}

// Foundry may keep a closing Dialog in the DOM briefly for its close animation.
// Keep the scoped skin alive through that animation so large source avatars never flash at natural size.
function cleanupDialogVisuals(style, observer=null){
  observer?.disconnect?.();
  window.setTimeout(() => style?.remove?.(), 750);
}

// ---------- Ledger helpers ----------
async function resolveLedger(shop){
  if (!shop?.ledgerUuid) return null;
  try { return await fromUuid(shop.ledgerUuid); } catch { return null; }
}
async function adjustLedgerWealth(ledger, delta, reason, {preventNegative=false}={}){
  if (!ledger) return {ok:false, value:0};
  const before = Number(ledger.system?.wealth?.value ?? 0);
  const change = Number(delta|0);
  if (preventNegative && before + change < 0) {
    return {ok:false, value:before, message:"Vendor is out of cash for that purchase."};
  }
  await adjustWealth(ledger, change, reason);
  return {ok:true, value:Number(ledger.system?.wealth?.value ?? (before + change))};
}
// Merge/push item into ledger inventory
async function addToLedger(ledger, rawOrDoc, qty=1){
  if (!ledger) return;
  let data;
  if (rawOrDoc?.toObject){
    data = rawOrDoc.toObject(); delete data._id;
  } else {
    data = foundry.utils.duplicate(rawOrDoc);
    delete data._id;
  }
  const sys = data.system ?? {};
  const f = resolveQtyField(sys);
  if (f){ sys[f] = Math.max(0, Number(qty|0)); data.system = sys; return ledger.createEmbeddedDocuments("Item", [data]); }
  const payload = Array.from({length: qty}, () => foundry.utils.duplicate(data));
  return ledger.createEmbeddedDocuments("Item", payload);
}

// ---------- chat approval helpers ----------
function bodegaNonce(){ return `${Date.now()}-${randomID()}`; }
function b2a(obj){ return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))); }
function a2b(s){ return JSON.parse(decodeURIComponent(escape(atob(s)))); }
window.__bodegaDone ||= new Set();

/** Serialize all cash/stock transactions per shop so buys and buybacks cannot race each other. */
const bodegaShopQueues = new Map();
async function withBodegaShopQueue(shopId, task){
  const key = String(shopId ?? "__unknown__");
  const previous = bodegaShopQueues.get(key) || Promise.resolve();
  const current = previous.catch(()=>{}).then(task);
  bodegaShopQueues.set(key, current);
  try { return await current; }
  finally { if (bodegaShopQueues.get(key) === current) bodegaShopQueues.delete(key); }
}
async function gmProcessBuyback(payload){
  return withBodegaShopQueue(payload?.shopId, () => gmProcessBuybackUnlocked(payload));
}

const bodegaPurchaseResults = new Map();
function rememberPurchaseResult(nonce, result){
  if (!nonce) return result;
  bodegaPurchaseResults.set(nonce, result);
  if (bodegaPurchaseResults.size > 300){
    const first = bodegaPurchaseResults.keys().next().value;
    if (first) bodegaPurchaseResults.delete(first);
  }
  return result;
}
async function gmProcessPurchase(payload){
  return withBodegaShopQueue(payload?.shopId, () => gmProcessPurchaseUnlocked(payload));
}

/** GM-authoritative purchase. Stock, buyer funds, vendor purse, and item delivery commit in one serialized shop transaction. */
async function gmProcessPurchaseUnlocked(payload){
  const fail = (message) => rememberPurchaseResult(payload?.nonce, {ok:false, message});
  if (!payload?.nonce) return {ok:false, message:"Bodega received an invalid purchase request."};
  if (bodegaPurchaseResults.has(payload.nonce)) return bodegaPurchaseResults.get(payload.nonce);
  if (!game.user?.isGM) return fail("Only a GM can process this Bodega purchase.");

  const db = await loadAll();
  const shop = db.shops?.[payload.shopId];
  if (!shop) return fail("Bodega not found.");
  const buyer = await fromUuid(payload.buyerUuid);
  if (!buyer) return fail("Buyer not found.");

  const wantedKey = String(payload.itemKey || "").toLowerCase();
  const wantedClass = String(payload.stockClass || "");
  const wantedPrice = Math.max(0, Number(payload.price|0));
  const sourceIndex = Number(payload.index);
  let item = Number.isInteger(sourceIndex) ? shop.items?.[sourceIndex] : null;
  const matches = candidate => candidate &&
    (!wantedKey || dynamicItemKey(candidate) === wantedKey) &&
    (!wantedClass || String(candidate.stockClass || (candidate.dynamicManaged ? "dynamic" : "static")) === wantedClass) &&
    (!Number.isFinite(wantedPrice) || Number(candidate.price|0) === wantedPrice);
  if (!matches(item)) item = (shop.items || []).find(matches) || null;
  if (!item) return fail("That item changed or is no longer stocked. Re-open the Bodega and try again.");

  const rank = getFixerRank(buyer);
  const fixer = rank > 0;
  if (item.fixerOnly){
    if (!fixer) return fail(`Only Fixers may purchase ${item.name}.`);
    const minR = (item.fixerMinRank==null || item.fixerMinRank==="") ? null : Number(item.fixerMinRank|0);
    if (minR != null && rank < minR) return fail(`Requires Operator Rank ${minR}+.`);
  }

  const available = item.infinite ? Number.POSITIVE_INFINITY : Math.max(0, Number(item.qty|0));
  if (!item.infinite && available <= 0) return fail(`${item.name} is sold out.`);
  const requested = Math.max(1, Number(payload.qty|0) || 1);
  const qty = item.infinite ? requested : Math.min(requested, available);
  if (qty <= 0) return fail(`${item.name} is sold out.`);

  const discCfg = db.defaults?.fixerDiscounts ?? defaultDB().defaults.fixerDiscounts;
  const each = priceWithFixerBuyDiscount(item.price|0, fixer, rank, discCfg, !!item.fixerOnly);
  const total = Math.max(0, each * qty);
  const funds = Math.max(0, Number(buyer.system?.wealth?.value ?? 0));
  if (total > funds) return fail(`${buyer.name} can’t afford ${item.name} ×${qty} (${total} eb).`);

  const ledger = await resolveLedger(shop);
  const beforeQty = item.infinite ? null : Math.max(0, Number(item.qty|0));
  const beforePurse = Math.max(0, Number(shop.purse|0));
  let buyerDebited = false;
  let ledgerCredited = false;
  let grantedDocs = [];
  try {
    if (total > 0){
      await adjustWealth(buyer, -total, `Bodega: ${item.name} ×${qty}`);
      buyerDebited = true;
    }

    const granted = await giveFromShopQty(buyer, item, qty);
    grantedDocs = Array.isArray(granted) ? granted.filter(Boolean) : (granted ? [granted] : []);
    if (!grantedDocs.length) throw new Error("Item delivery failed.");

    if (!item.infinite) item.qty = Math.max(0, beforeQty - qty);

    if (ledger){
      await adjustLedgerWealth(ledger, +total, `Bodega Sale: ${item.name} ×${qty}`);
      ledgerCredited = total > 0;
    } else {
      shop.purse = Math.max(0, beforePurse + total);
    }

    await saveAll(db);
    const purseNow = ledger ? Math.max(0, Number(ledger.system?.wealth?.value|0)) : Math.max(0, Number(shop.purse|0));
    const stockClass = String(item.stockClass || (item.dynamicManaged ? "dynamic" : "static"));
    const itemKey = dynamicItemKey(item);
    const qtyRemaining = item.infinite ? null : Math.max(0, Number(item.qty|0));

    if (!item.infinite){
      updateOpenShopStock(shop.id, itemKey, stockClass, qtyRemaining);
      game.socket.emit(SOCKET, {op:"stock-ui", id:shop.id, itemKey, stockClass, qty:qtyRemaining});
    }
    document.querySelectorAll(`.wrap[data-shop="${shop.id}"] .purse-val`).forEach(el => el.textContent = String(purseNow));
    game.socket.emit(SOCKET, {op:"purse-ui", id:shop.id, purse:purseNow});
    game.socket.emit(SOCKET, {op:"purse-ack", id:shop.id, purse:purseNow});

    try {
      await ChatMessage.create({
        content:`<b>Bodega</b>: Sold <i>${esc(item.name)}</i> ×${qty} to <b>${esc(buyer.name)}</b> (${total} eb).`,
        speaker:ChatMessage.getSpeaker({alias:"Bodega"})
      });
    } catch (chatError) { console.warn("Bodega | Purchase succeeded but receipt chat failed", chatError); }

    return rememberPurchaseResult(payload.nonce, {ok:true, message:"Purchase completed.", itemName:item.name, itemKey, stockClass, qtyPurchased:qty, qtyRemaining, total, purse:purseNow});
  } catch (error) {
    console.error("Bodega | Purchase transaction failed", error);
    try {
      if (grantedDocs.length) await buyer.deleteEmbeddedDocuments("Item", grantedDocs.map(doc => doc.id).filter(Boolean));
    } catch (rollbackError) { console.error("Bodega | Purchase item rollback failed", rollbackError); }
    try { if (buyerDebited && total > 0) await adjustWealth(buyer, +total, `Bodega Refund: ${item.name} ×${qty}`); }
    catch (rollbackError) { console.error("Bodega | Purchase wealth rollback failed", rollbackError); }
    try { if (ledgerCredited && total > 0) await adjustLedgerWealth(ledger, -total, `Bodega Rollback: ${item.name} ×${qty}`, {preventNegative:true}); }
    catch (rollbackError) { console.error("Bodega | Purchase ledger rollback failed", rollbackError); }
    if (!item.infinite && beforeQty != null) item.qty = beforeQty;
    shop.purse = beforePurse;
    return fail("Purchase failed during the transaction. Nothing should have been charged; check the console if the issue repeats.");
  }
}

/** GM-only: process one sell approval payload inside the per-shop queue. */
async function gmProcessBuybackUnlocked(payload){
  const fail = (message, level="warn") => {
    ui.notifications?.[level]?.(message);
    return {ok:false, message};
  };

  if (!payload?.nonce) return fail("Bodega received an invalid buyback request.", "error");
  if (window.__bodegaDone.has(payload.nonce)) return {ok:true, duplicate:true};
  if (!game.user?.isGM) return fail("Only a GM can approve this buyback.");

  const db = await loadAll();
  const shop = db.shops?.[payload.shopId];
  if (!shop) return fail("Bodega not found.", "error");

  const seller = await fromUuid(payload.sellerUuid);
  if (!seller) return fail("Seller not found.", "error");

  let item = seller.items.get(payload.itemId);
  if (!item && payload.itemName) {
    item = seller.items.find(i => i.name === payload.itemName && getItemMarketValue(i) === (payload.baseVal|0));
  }
  if (!item) return fail("Bodega: item not found on seller.", "error");

  const rank = getFixerRank(seller);
  const kind = getItemKind(item);
  const cfg = db.defaults?.fixerDiscounts ?? defaultDB().defaults.fixerDiscounts;
  const bb = shop.buyback?.[kind] || {on:false, pct:0};
  if (!bb.on) return fail("Vendor is not buying that category right now.");

  const packageInfo = await resolveMarketPackageInfo(item);
  if (!packageInfo.verified) {
    return fail("Bodega cannot verify this stacked item's original market package size. GM review required; handle this buyback manually.");
  }
  const baseValue = packageInfo.marketPrice;
  const packageSize = packageInfo.packageSize;
  const finalPct = applyFixerBonusToSell(bb.pct|0, rank, cfg);
  const have = readStackQty(item);
  const qty = Math.max(1, Math.min(have, Number(payload.qty|0) || 1));
  const total = proportionalBuybackTotal(baseValue, finalPct, qty, packageSize);
  const purse = Math.max(0, Number(shop.purse|0));
  const ledger = await resolveLedger(shop);
  const vendorCash = ledger ? Number(ledger.system?.wealth?.value|0) : purse;

  if (total <= 0) return fail(`No whole-eb offer yet. Sell more of that ${packageSize > 1 ? `package (${packageSize} units)` : 'item'} at once.`);
  if (total > vendorCash) return fail("Vendor is out of cash for that purchase.");

  const raw = item.toObject();
  delete raw._id;

  let ledgerDebited = false;
  let sellerCredited = false;
  let sellerItemChanged = false;
  try {
    // Debit vendor cash first while the per-shop queue is held. This makes the no-negative
    // guarantee real even when several players hit Sell at nearly the same time.
    if (ledger) {
      const debit = await adjustLedgerWealth(ledger, -total, `Bodega Buyback: ${item.name} ×${qty}`, {preventNegative:true});
      if (!debit?.ok) return fail(debit?.message || "Vendor is out of cash for that purchase.");
      ledgerDebited = true;
    } else {
      shop.purse = Math.max(0, purse - total);
    }

    if (have > qty) await writeStackQty(item, have - qty);
    else await seller.deleteEmbeddedDocuments("Item", [item.id]);
    sellerItemChanged = true;

    await adjustWealth(seller, +total, `Bodega Buyback: ${item.name} ×${qty}`);
    sellerCredited = true;

    const packDoc = await findItemAnywhere(item.name);
    const looseUnitPrice = packageSize > 1 ? proportionalUnitRetail(baseValue, packageSize) : Math.max(0, baseValue|0);
    const entry = {
      uuid:packDoc?.uuid || null,
      raw:packDoc ? null : raw,
      name:item.name,
      img:item.img,
      price:looseUnitPrice,
      packageSize:1,
      marketPackagePrice:looseUnitPrice,
      qty,
      infinite:false,
      fixerOnly:false,
      fixerMinRank:null,
      autoFixerLocked:false,
      dynamicManaged:false,
      tradeIn:true,
      stockClass:"tradein"
    };
    syncAutoFixerLock(entry, db.defaults, {newItem:true});
    const hit = (shop.items || []).find(x => (x.tradeIn || x.stockClass === "tradein") && x.name === entry.name && (x.price|0) === (entry.price|0));
    if (hit) hit.qty = (hit.qty|0) + qty;
    else {
      shop.items ||= [];
      shop.items.push(entry);
    }

    if (ledger) await addToLedger(ledger, raw, qty);
    await saveAll(db);
    const purseNow = ledger
      ? Math.max(0, Number(ledger.system?.wealth?.value|0))
      : Math.max(0, Number(shop.purse|0));

    window.__bodegaDone.add(payload.nonce);
    document.querySelectorAll(`.wrap[data-shop="${payload.shopId}"] .purse-val`).forEach(el => el.textContent = String(purseNow));
    game.socket.emit(SOCKET, {op:"purse-ui", id:payload.shopId, purse:purseNow});
    game.socket.emit(SOCKET, {op:"purse-ack", id:payload.shopId, purse:purseNow});

    try {
      await ChatMessage.create({
        content:`<b>Bodega</b>: Bought <i>${esc(item.name)}</i> ×${qty}${packageSize > 1 ? ` unit${qty===1?'':'s'} (${packageSize}/market pack)` : ''} from <b>${esc(seller.name)}</b> for ${total} eb.`,
        speaker:ChatMessage.getSpeaker({alias:"Bodega"})
      });
    } catch (chatError) {
      console.warn("Bodega | Buyback succeeded but receipt chat failed", chatError);
    }
    return {ok:true, total, qty, itemName:item.name, purse:purseNow};
  } catch (error) {
    console.error("Bodega | Buyback transaction failed", error);
    // Best-effort rollback. The ledger refund is itself never a negative operation.
    try { if (sellerCredited) await adjustWealth(seller, -total, `Bodega Rollback: ${item.name} ×${qty}`); } catch (rollbackError) { console.error("Bodega | Seller wealth rollback failed", rollbackError); }
    try {
      if (sellerItemChanged) {
        const stillThere = seller.items.get(payload.itemId) || seller.items.find(i => i.name === payload.itemName && getItemMarketValue(i) === baseValue);
        if (stillThere) await writeStackQty(stillThere, have);
        else await seller.createEmbeddedDocuments("Item", [foundry.utils.duplicate(raw)]);
      }
    } catch (rollbackError) { console.error("Bodega | Seller item rollback failed", rollbackError); }
    try { if (ledgerDebited) await adjustLedgerWealth(ledger, +total, `Bodega Rollback: ${item.name} ×${qty}`); } catch (rollbackError) { console.error("Bodega | Ledger rollback failed", rollbackError); }
    return fail("Bodega buyback failed during the transaction. Check the console.", "error");
  }
}

// -------------------- storage --------------------
function defaultDynamicSettings(){
  return {
    enabled:false,
    stockSource:"table",
    stockTable:"",
    stockPack:"",
    stockPool:[],
    minItems:5,
    maxItems:10,
    qtyMin:1,
    qtyMax:6,
    npcTraffic:true,
    trafficMin:2,
    trafficMax:3,
    restockEnabled:true,
    restockHour:6,
    restockMinute:0,
    restockMode:"rotate",
    initializedAt:0,
    trafficDayKey:"",
    trafficSchedule:[],
    lastTraffic:0,
    lastRestock:0,
    nextRestock:0,
    lastProcessed:0
  };
}
function normalizeDynamicPool(pool){
  return Array.isArray(pool) ? pool.filter(Boolean).map(entry => ({
    uuid:String(entry.uuid || ""),
    name:String(entry.name || "Unknown Item"),
    img:String(entry.img || "icons/svg/item-bag.svg")
  })) : [];
}
function normalizeDynamicSettings(value){
  const base = defaultDynamicSettings();
  const dynamic = foundry.utils.mergeObject(base, value || {}, {inplace:false});
  dynamic.stockPool = normalizeDynamicPool(dynamic.stockPool);
  dynamic.stockSource = ["table","pack","pool"].includes(dynamic.stockSource) ? dynamic.stockSource : "table";
  dynamic.restockMode = ["refill","rotate"].includes(dynamic.restockMode) ? dynamic.restockMode : "rotate";
  dynamic.minItems = Math.max(1, Math.min(50, Number(dynamic.minItems|0) || 5));
  dynamic.maxItems = Math.max(dynamic.minItems, Math.min(50, Number(dynamic.maxItems|0) || dynamic.minItems));
  dynamic.qtyMin = Math.max(0, Math.min(999, Number(dynamic.qtyMin|0)));
  dynamic.qtyMax = Math.max(dynamic.qtyMin, Math.min(999, Number(dynamic.qtyMax|0) || dynamic.qtyMin));
  dynamic.trafficMin = Math.max(0, Math.min(12, Number(dynamic.trafficMin|0)));
  dynamic.trafficMax = Math.max(dynamic.trafficMin, Math.min(12, Number(dynamic.trafficMax|0) || dynamic.trafficMin));
  dynamic.restockHour = Math.max(0, Number(dynamic.restockHour|0));
  dynamic.restockMinute = Math.max(0, Number(dynamic.restockMinute|0));
  dynamic.initializedAt = Number(dynamic.initializedAt || 0);
  dynamic.trafficDayKey = String(dynamic.trafficDayKey || "");
  dynamic.trafficSchedule = Array.isArray(dynamic.trafficSchedule) ? dynamic.trafficSchedule.map(entry => ({ts:Number(entry?.ts || 0), done:!!entry?.done})).filter(entry => entry.ts > 0) : [];
  dynamic.lastTraffic = Number(dynamic.lastTraffic || 0);
  dynamic.lastRestock = Number(dynamic.lastRestock || 0);
  dynamic.nextRestock = Number(dynamic.nextRestock || 0);
  dynamic.lastProcessed = Number(dynamic.lastProcessed || 0);
  return dynamic;
}
function defaultDB(){
  return {
    _ver: FLAG_VER,
    era2045:false,
    defaults:{
      packKey:"",
      rollTable:"",
      fixerDiscounts: { t1:10, t2:15, t3:20 },
      autoFixerLock:{ enabled:false, threshold:500 }
    },
    // items: stockClass is static | dynamic | tradein. dynamicManaged is retained for compatibility.
    // shop:  {id,name,..., faces:[], items:[], dynamic:{...}, purse, buyback:{ [kind]:{on,pct} }, ledgerUuid? }
    shops:{}
  };
}
function ensureSetting(){
  if (!game.settings.settings.get(`${STORE_NS}.${STORE_KEY}`)) {
    game.settings.register(STORE_NS, STORE_KEY, {name:"Bodega DB", scope:"world", config:false, type:Object, default: defaultDB()});
  }
}
async function loadAll(){
  ensureSetting();
  const val = await game.settings.get(STORE_NS, STORE_KEY);
  if (!val || typeof val !== "object") return defaultDB();

  // --- Legacy migration if version is older
  if (!val._ver || val._ver < FLAG_VER){
    for (const v of Object.values(val.shops ?? {})){
      v.items = (v.items ?? []).map(it => ({
        ...it,
        qty: typeof it.qty==="number" ? it.qty : 1,
        infinite: !!it.infinite,
        fixerOnly: !!it.fixerOnly,
        fixerMinRank: (it.fixerMinRank==null || it.fixerMinRank==="")
          ? null
          : Math.max(1, Math.min(10, Number(it.fixerMinRank|0)))
      }));
    }
    val._ver = FLAG_VER;
  }

  // --- ALWAYS normalize shape (covers shops made before buyback/dynamic inventory existed)
  val.defaults ||= {};
  val.defaults.packKey = String(val.defaults.packKey || "");
  val.defaults.rollTable = String(val.defaults.rollTable || "");
  val.defaults.fixerDiscounts = {
    t1:Math.max(0, Math.min(95, Number(val.defaults.fixerDiscounts?.t1 ?? 10)|0)),
    t2:Math.max(0, Math.min(95, Number(val.defaults.fixerDiscounts?.t2 ?? 15)|0)),
    t3:Math.max(0, Math.min(95, Number(val.defaults.fixerDiscounts?.t3 ?? 20)|0))
  };
  val.defaults.autoFixerLock = normalizeAutoFixerLock(val.defaults.autoFixerLock);
  const kinds = ["Ammo","Armor","Clothing","Cyberdeck","Cyberware","Drug","Gear","Upgrade","Vehicle","Weapon"];
  for (const v of Object.values(val.shops ?? {})){
    // faces
    v.faces = Array.isArray(v.faces) ? v.faces : [];

    // purse
    v.purse = Math.max(0, Number.isFinite(v.purse) ? Number(v.purse|0) : 0);

    // Tile bindings. Keep this as an array so one Bodega can appear on multiple scenes.
    v.tileUuids = Array.isArray(v.tileUuids) ? [...new Set(v.tileUuids.filter(Boolean).map(String))] : [];

    // Inventory classes. Existing/manual stock defaults to static.
    v.items = (v.items ?? []).map(it => {
      const dynamicManaged = !!it.dynamicManaged || it.stockClass === "dynamic";
      const tradeIn = !!it.tradeIn || it.stockClass === "tradein";
      return {
        ...it,
        qty: typeof it.qty === "number" ? Math.max(0, Number(it.qty|0)) : 1,
        infinite:!!it.infinite,
        fixerOnly:!!it.fixerOnly,
        fixerMinRank:(it.fixerMinRank==null || it.fixerMinRank==="") ? null : Math.max(1, Math.min(10, Number(it.fixerMinRank|0))),
        autoFixerLocked:!!it.autoFixerLocked,
        packageSize:it.packageSize==null ? null : Math.max(1, Number(it.packageSize || 1)|0),
        marketPackagePrice:it.marketPackagePrice==null ? null : Math.max(0, Number(it.marketPackagePrice|0)),
        dynamicManaged:dynamicManaged && !tradeIn,
        tradeIn,
        stockClass:tradeIn ? "tradein" : (dynamicManaged ? "dynamic" : "static")
      };
    });
    for (const item of v.items) syncAutoFixerLock(item, val.defaults, {newItem:false});
    v.dynamic = normalizeDynamicSettings(v.dynamic);
    if (!v.dynamic.stockTable) v.dynamic.stockTable = v.rollTable || "";
    if (!v.dynamic.stockPack) v.dynamic.stockPack = v.packKey || "";

    // buyback
    if (!v.buyback || typeof v.buyback !== "object") v.buyback = {};
    for (const k of kinds){
      const cur = v.buyback[k] || {};
      v.buyback[k] = {
        on: !!cur.on,
        pct: Math.max(0, Math.min(120, Number(cur.pct|0) || 0))
      };
    }
  }

  return val;
}
async function saveAll(db){ ensureSetting(); return game.settings.set(STORE_NS, STORE_KEY, db); }

// -------------------- theme --------------------
function updateOpenShopStock(shopId, itemKey, stockClass, qty){
  const id = String(shopId || "");
  const key = String(itemKey || "").toLowerCase();
  const klass = String(stockClass || "");
  const remaining = Math.max(0, Number(qty|0));
  for (const wrap of document.querySelectorAll('.wrap[data-shop]')){
    if (String(wrap.dataset.shop || "") !== id) continue;
    for (const row of wrap.querySelectorAll('[data-bodega-item-key]')){
      if (String(row.dataset.bodegaItemKey || "").toLowerCase() !== key) continue;
      if (klass && String(row.dataset.bodegaStockClass || "") !== klass) continue;
      const stock = row.querySelector('.stock-live');
      if (stock) stock.textContent = `${remaining} left`;
      const input = row.querySelector('.qty-buy');
      const button = row.querySelector('.buy');
      if (input){
        input.max = String(Math.max(1, remaining));
        if (remaining <= 0) input.disabled = true;
        else {
          input.disabled = false;
          const current = Math.max(1, Number(input.value|0) || 1);
          input.value = String(Math.min(current, remaining));
        }
      }
      if (button){
        if (remaining <= 0){
          button.disabled = true;
          button.dataset.soldOut = "1";
          button.innerHTML = '<i class="fas fa-ban"></i> Sold out';
        } else {
          button.dataset.soldOut = "";
          if (row.dataset.busy !== "1") button.disabled = false;
          if (row.dataset.busy !== "1") button.innerHTML = '<i class="fas fa-shopping-cart"></i> Buy';
        }
      }
    }
  }
}

function makeAdminCSS(accent="#00FFF7", bodyId){
  const highlight = String(accent).toUpperCase() === "#E64539" ? accent : "#f2d64b";
  return `
.dialog-host-${bodyId}, #${bodyId}{ --accent:${accent}; --yellow:${highlight}; --hover:#fff0a0; --bg:#080c0f; --panel:#10171d; --text:#edfaff; --muted:#8fb8c2; color:var(--text); }
.dialog-host-${bodyId}{ background:var(--bg) !important; }
.dialog-host-${bodyId} .window-header{
  background:#080c0f !important; color:var(--text) !important;
  border:1px solid var(--accent); border-top:3px solid var(--yellow); border-bottom:0;
  border-radius:10px 10px 0 0; box-shadow:0 0 14px rgba(0,0,0,.45);
}
.dialog-host-${bodyId} .window-title,
.dialog-host-${bodyId} .window-header .close,
.dialog-host-${bodyId} .window-header .popout{ color:var(--text) !important; }
.dialog-host-${bodyId} .window-content{
  background-color:#080c0f !important; color:var(--text) !important;
  background-image:radial-gradient(rgba(255,255,255,.045) 1px, transparent 1px),radial-gradient(rgba(255,255,255,.045) 1px, transparent 1px),linear-gradient(#080c0f,#080c0f) !important;
  background-size:24px 24px,24px 24px,auto !important; background-position:0 0,12px 12px,0 0 !important;
  border-left:1px solid var(--accent); border-right:1px solid var(--accent); padding:8px 10px !important;
}
.dialog-host-${bodyId} .dialog-buttons{
  background:#080c0f !important; border:1px solid var(--accent); border-top:1px solid rgba(255,255,255,.08);
  border-radius:0 0 10px 10px; padding:7px 10px !important;
}
.dialog-host-${bodyId} form{ background:transparent !important; }
#${bodyId}{ color:var(--text); }
#${bodyId}, #${bodyId} *{ box-sizing:border-box; }
#${bodyId} .wrap{ background:linear-gradient(180deg,#0d1318 0,#080c0f 100%); border:1px solid var(--accent); border-top:3px solid var(--yellow); border-radius:8px; padding:12px; color:var(--text); min-width:520px; box-shadow:0 0 18px rgba(0,0,0,.5); }
#${bodyId} .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
#${bodyId} .title{font-size:20px;font-weight:900;margin:0 0 4px;color:var(--yellow);letter-spacing:.5px;text-transform:uppercase}
#${bodyId} .muted{font-size:14px;color:var(--muted);opacity:1}
#${bodyId} .stock-badge{display:inline-block;border:1px solid var(--accent);border-radius:999px;padding:1px 7px;font-size:10px;font-weight:900;letter-spacing:.35px;text-transform:uppercase;color:var(--text);background:#071015;margin-left:5px;}
#${bodyId} .stock-badge.dynamic{border-color:var(--yellow);color:var(--yellow);}
#${bodyId} .stock-badge.tradein{border-color:#ff9f43;color:#ffd7a8;}
#${bodyId} label, #${bodyId} fieldset{ color:var(--text); }
#${bodyId} legend{ color:var(--yellow); font-weight:800; }
#${bodyId} code, #${bodyId} .tile-script code{ color:var(--yellow); background:#05080a; border:1px solid rgba(242,214,75,.35); border-radius:4px; padding:2px 5px; user-select:text; }
#${bodyId} .tile-script{ margin-top:8px; padding-top:7px; border-top:1px solid rgba(255,255,255,.08); font-size:12px; color:var(--muted); min-width:0; max-width:100%; overflow-wrap:anywhere; }
#${bodyId} .tile-script code{ display:inline-block; max-width:100%; white-space:normal; word-break:break-all; vertical-align:middle; }
#${bodyId} .manager-toolbar{ display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-bottom:2px; }
#${bodyId} .manager-card-head{ display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px; align-items:start; }
#${bodyId} .manager-summary{ min-width:0; line-height:1.35; }
#${bodyId} .manager-actions{ display:grid; grid-template-columns:repeat(2, minmax(118px, auto)); gap:6px; align-items:start; }
#${bodyId} .manager-actions .btn{ min-width:118px; height:34px; padding:5px 9px; white-space:nowrap; }
@media (max-width:800px){ #${bodyId} .manager-card-head{ grid-template-columns:1fr; } #${bodyId} .manager-actions{ grid-template-columns:repeat(2,minmax(0,1fr)); } }
#${bodyId} .btn{ background:#0b1217; color:var(--text); border:1px solid var(--accent); border-radius:6px; padding:6px 10px; min-height:32px; line-height:1.15; font-weight:800; cursor:pointer; flex:0 0 auto; width:auto; min-width:0; }
#${bodyId} .btn:hover{ color:var(--yellow); border-color:var(--yellow); box-shadow:0 0 10px color-mix(in srgb,var(--accent) 35%,transparent); }
#${bodyId} input, #${bodyId} select, #${bodyId} textarea{ background:#070b0e !important; color:var(--text) !important; border:1px solid var(--accent); border-radius:5px; padding:8px; caret-color:var(--yellow); }
#${bodyId} textarea{ width:100%; min-height:62px; resize:vertical; }
#${bodyId} select{ appearance:auto; height:auto !important; min-height:0 !important; line-height:normal !important; padding:8px !important; text-indent:0 !important; vertical-align:middle; }
#${bodyId} .wrap.edit .dyn-source{ width:220px !important; min-width:220px !important; max-width:220px; }
#${bodyId} .wrap.edit .dyn-restock-mode{ width:220px !important; min-width:220px !important; max-width:220px; }
#${bodyId} .dyn-pool-tools[hidden]{ display:none !important; }
#${bodyId} .dyn-search-wrap{ position:relative; flex:1 1 320px; min-width:240px; }
#${bodyId} .dyn-pool-search{ width:100%; }
#${bodyId} .dyn-search-results{ margin-top:4px; max-height:190px; overflow-y:auto; overflow-x:hidden; border:1px solid var(--accent); border-radius:6px; background:#05090c; padding:4px; scrollbar-width:thin; scrollbar-color:var(--accent) #05090c; }
#${bodyId} .dyn-search-results[hidden]{ display:none !important; }
#${bodyId} .dyn-search-hit{ width:100%; min-height:34px; display:grid; grid-template-columns:28px minmax(0,1fr) auto; align-items:center; gap:8px; padding:4px 7px; margin:0 0 3px; background:#0b1217; color:var(--text); border:1px solid rgba(0,255,247,.22); border-radius:4px; text-align:left; cursor:pointer; }
#${bodyId} .dyn-search-hit:last-child{ margin-bottom:0; }
#${bodyId} .dyn-search-hit:hover{ border-color:var(--yellow); color:var(--yellow); }
#${bodyId} .dyn-search-hit img{ width:26px; height:26px; object-fit:cover; border-radius:3px; }
#${bodyId} .dyn-search-hit .src{ color:var(--muted); font-size:11px; white-space:nowrap; }
#${bodyId} .dyn-pool-tools [data-dyn-pool]{ max-height:150px; overflow-y:auto; overflow-x:hidden; align-content:flex-start; padding-right:3px; scrollbar-width:thin; scrollbar-color:var(--accent) #05090c; }
#${bodyId} option{ background:#070b0e; color:var(--text); }
#${bodyId} input[type="checkbox"]{ accent-color:var(--accent); }
#${bodyId} input[type="number"]{ text-align:right; }
#${bodyId} .list{ display:flex; flex-direction:column; gap:8px; overflow:visible; padding-right:4px; }
#${bodyId} .card{ background:var(--panel); border:1px solid var(--accent); border-left:3px solid var(--yellow); border-radius:6px; padding:10px; color:var(--text); }
#${bodyId} .item-row{ display:flex; align-items:center; justify-content:space-between; gap:10px; }
#${bodyId} .item-left{ display:flex; align-items:center; gap:10px; min-width:0; }
#${bodyId} .thumb{ width:50px; height:50px; border-radius:4px; object-fit:cover; }
#${bodyId} .name{ font-weight:800; color:var(--text) !important; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#${bodyId} .grid2{ display:grid; grid-template-columns:1fr auto; gap:8px; align-items:center; }
#${bodyId} .drop{ padding:12px; border:1px dashed var(--accent); border-radius:6px; text-align:center; color:var(--muted); background:#080d11; }
#${bodyId} .drop.drag{ background:rgba(0,0,0,.6); }
#${bodyId} .faces{ display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
#${bodyId} .face{ width:28px; height:28px; border-radius:50%; border:1px solid var(--accent); object-fit:cover; }
#${bodyId} .face-chip{ display:inline-flex; align-items:center; gap:6px; padding:4px 8px; border:1px solid var(--accent); border-radius:999px; background:rgba(0,0,0,.4); }
#${bodyId} .face-chip .x{ font-weight:800; cursor:pointer; }
#${bodyId} .card .del{
  flex:0 0 auto;
  width:36px; height:36px; padding:0;
  display:inline-flex; align-items:center; justify-content:center;
}
/* Hard stop for horizontal spill */
#${bodyId} .wrap { overflow: hidden; box-sizing: border-box; }
#${bodyId} .list { overflow-x: hidden; }

/* Make rows able to shrink within the card */
#${bodyId} .card { max-width: 100%; }
#${bodyId} .item-row { min-width: 0; }
#${bodyId} .item-left > div{ min-width:0; }
#${bodyId} .name { min-width: 0; }

/* Buy controls */
#${bodyId} .buy-controls .qty-buy{ width:64px; }
#${bodyId} .buy-controls { flex-wrap: nowrap; }

/* Fixer-Only Min clamp */
#${bodyId} .price-line{ display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

/* Player view row alignment */
#${bodyId} .wrap:not(.edit) .item-row{ justify-content:flex-start; }
#${bodyId} .wrap:not(.edit) .item-row .item-left{ flex:1 1 0; min-width:0; }
#${bodyId} .buy-controls{ margin-left:auto; display:flex; align-items:center; gap:8px; flex-wrap:nowrap; flex:0 0 auto; min-width:0; max-width:100%; }
#${bodyId} .wrap:not(.edit) .buy-controls .qty-buy{ width:72px; }

/* Long name knee capper */
#${bodyId} .name { max-width:48vw; overflow:hidden; text-overflow:ellipsis; }

/* Edit tightening */
#${bodyId} .wrap.edit .card{ padding:8px }
#${bodyId} .wrap.edit fieldset{ padding:8px }
#${bodyId} .wrap.edit .row{ gap:6px }
#${bodyId} .wrap.edit .item-row{ gap:8px }
#${bodyId} .wrap.edit .item-left{ gap:8px }
#${bodyId} .wrap.edit .thumb{ width:40px; height:40px }
#${bodyId} .wrap.edit .name{ font-weight:700; }
#${bodyId} .wrap.edit input{ padding:6px }
#${bodyId} .wrap.edit .qty{ width:64px }
#${bodyId} .wrap.edit .price{ width:50px }
#${bodyId} .wrap.edit .fixermin{ width:56px }
#${bodyId} .wrap.edit label{ gap:4px }
#${bodyId} .wrap.edit .card .del{ width:32px; height:32px; }
#${bodyId} .wrap.edit .bb-grid{ gap:8px 10px }
#${bodyId} .wrap.edit .drop{ padding:10px }
#${bodyId} .wrap.edit .item-row{ display:grid !important; grid-template-columns:minmax(0,1fr) auto; align-items:start; gap:10px; }
#${bodyId} .wrap.edit .item-left{ min-width:0; }
#${bodyId} .wrap.edit .name{ white-space:normal; word-break:break-word; line-height:1.15; }
#${bodyId} .wrap.edit .item-controls{ display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; max-width:460px; }
@media (max-width: 820px){
  #${bodyId} .wrap.edit .item-row{ grid-template-columns:1fr; }
  #${bodyId} .wrap.edit .item-controls{ justify-content:flex-start; max-width:none; }
}

/* unify player Buy & Sell button footprints */
#${bodyId} .card .buy, #${bodyId} .card .sell{ min-width:88px; max-width:150px; height:36px; white-space:nowrap; }

#${bodyId} .shop-header{ display:flex; align-items:center; gap:12px; }
#${bodyId} .shop-head-center{ flex:1; text-align:center; }

#${bodyId} .faces-large .face-lg{ width:112px; height:112px; border-radius:50%; border:1px solid var(--accent); object-fit:cover; }
#${bodyId} .face-block{ display:flex; flex-direction:column; align-items:center; gap:4px; min-width:112px; }
#${bodyId} .face-label{ font-size:16px; line-height:1.1; max-width:132px; text-align:center; opacity:.9; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

#${bodyId} .buyer-line{ font-size:24px; font-weight:800; }
#${bodyId} .fixer-tag{ font-size:16px; }

#${bodyId} .price-eb b, #${bodyId} .price-line b{ font-size:16px; font-weight:800; }
#${bodyId} .price-eb .eb, #${bodyId} .price-line .eb{ font-weight:800; }
#${bodyId} .price-line del{ opacity:.6; margin-right:6px; }
#${bodyId} .price-line{ display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:48vw; }

#${bodyId} .bb-grid{ display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:10px 14px; }
`;
}

function makePlayerCSS(accent = "#00FFF7", bodyId){
  const highlight = String(accent).toUpperCase() === "#E64539" ? accent : "#f2d64b";
  const bg     = "#080c0f";       // Choom Trade-style charcoal
  const panel  = "#10171d";       // raised card background
  const text   = "#edfaff";
  const muted  = "#8fb8c2";
  const line   = "rgba(0,0,0,.7)";

  // honeycomb like the reference
  const honeyA = "radial-gradient(rgba(255,255,255,.06) 1px, transparent 1px)";
  const honeyB = "radial-gradient(rgba(255,255,255,.06) 1px, transparent 1px)";

  return `
/* ---------- Bodega skin scope (wins against Foundry theme) ---------- */
.dialog-host-${bodyId} { --accent:${accent}; --yellow:${highlight}; --bg:${bg}; --panel:${panel}; --muted:${muted}; --text:${text}; --line:${line}; }

/* Kill host theme and draw neon chrome */
.dialog-host-${bodyId} .window-header{
  background:${bg} !important;
  color:var(--text) !important;
  border:1px solid var(--accent);
  border-top:3px solid var(--yellow);
  border-bottom:0;
  border-radius:12px 12px 0 0;
  box-shadow:0 0 0 1px ${bg} inset, 0 0 12px rgba(0,0,0,.35);
}
.dialog-host-${bodyId} .window-title{ color:var(--text) !important; font-weight:800; letter-spacing:.2px; }
.dialog-host-${bodyId} .window-content{
  background:${bg} !important;
  border:1px solid var(--accent);
  border-top:0;
  border-radius:0 0 12px 12px;
  padding:8px 10px 10px !important;
  color:var(--text);
  /* honeycomb */
  background-image:${honeyA}, ${honeyB}, linear-gradient(${bg}, ${bg});
  background-size: 24px 24px, 24px 24px, auto;
  background-position: 0 0, 12px 12px, 0 0;
  background-blend-mode: normal;
}

/* Footer buttons zone */
.dialog-host-${bodyId} .dialog-buttons{
  background:${bg} !important;
  border-top:1px solid rgba(255,255,255,.08);
  border-radius:0 0 10px 10px;
  padding:8px 10px;
}

/* ---------- Content layout ---------- */
#${bodyId}, #${bodyId} *{ box-sizing:border-box; }
#${bodyId} .stock-badge{ display:inline-block; border:1px solid var(--accent); border-radius:999px; padding:1px 7px; font-size:10px; font-weight:900; letter-spacing:.35px; text-transform:uppercase; margin-left:4px; color:var(--text); background:#071015; }
#${bodyId} .stock-badge.dynamic{ border-color:var(--yellow); color:var(--yellow); }
#${bodyId} .stock-badge.tradein{ border-color:#ff9f43; color:#ffd7a8; }
#${bodyId} .wrap{ display:flex; flex-direction:column; gap:14px; color:var(--text) !important; }
#${bodyId} .title{ font-weight:900; font-size:20px; color:var(--yellow) !important; letter-spacing:.4px; text-transform:uppercase; }

/* make the window itself wider and stop themes from clamping it */
.dialog-host-${bodyId} {
  width: 820px !important;       /* <- match the JS width above */
  max-width: 92vw;               /* still behave on small screens */
}
.dialog-host-${bodyId} .window-content {
  max-width: none !important;    /* prevent theme max-widths */
}

/* header block */
#${bodyId} .shop-header{ display:flex; align-items:center; gap:18px; padding:10px; background:linear-gradient(90deg,#0f171d,#0a0f13); border:1px solid var(--accent); border-left:4px solid var(--yellow); border-radius:6px; }
#${bodyId} .faces{ display:flex; align-items:center; gap:8px; }
#${bodyId} .face-lg{ width:144px !important; height:144px !important; min-width:144px !important; min-height:144px !important; max-width:144px !important; max-height:144px !important; border-radius:8px; border:2px solid var(--accent); border-top-color:var(--yellow); object-fit:cover !important; display:block; flex:0 0 144px; box-shadow:0 0 14px color-mix(in srgb,var(--accent) 22%,transparent); }
#${bodyId} .face-block{ flex:0 0 144px; min-width:144px; max-width:160px; }
#${bodyId} .face-label{ font-size:13px; margin-top:5px; color:var(--yellow); opacity:1; text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#${bodyId} .shop-head-center{ flex:1; display:flex; flex-direction:column; align-items:center; gap:2px; }
#${bodyId} .buyer-line{ font-size:22px; font-weight:900; color:var(--text) !important; }
#${bodyId} .muted{ color:var(--muted) !important; }
#${bodyId} .eb{ font-weight:800; }

/* list + cards with neon outline */
#${bodyId} .list{ display:flex; flex-direction:column; gap:10px; }
#${bodyId} .card{
  background:var(--panel);
  border:1px solid var(--accent);
  border-left:3px solid var(--yellow);
  border-radius:6px;
  box-shadow:0 6px 18px rgba(0,0,0,.22);
  color:var(--text) !important;
}
#${bodyId} .card .title{ font-size:16px; margin:10px 10px 6px; font-weight:800; color:var(--accent); }
#${bodyId} .item-row{ display:flex; align-items:center; gap:12px; padding:10px; }
#${bodyId} .item-left{ display:flex; align-items:center; gap:10px; flex:1 1 0; min-width:0; }
#${bodyId} .thumb{ width:40px; height:40px; object-fit:cover; border-radius:6px; border:1px solid var(--line); background:#222; }
#${bodyId} .name{ font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#${bodyId} .price-line{ font-size:12px; color:var(--muted); }
#${bodyId} .price-line del{ opacity:.5; margin-right:6px; text-decoration-thickness:2px; }
#${bodyId} .price-line b{ font-size:16px; font-weight:900; color:var(--yellow) !important; }

/* exact pill controls: qty + Buy/Sell */
#${bodyId} .buy-controls{ margin-left:auto; display:flex; align-items:center; gap:10px; }
/* sell rows use the same right-hand control rail as buy */
#${bodyId} .sell-controls{
  margin-left:auto; display:flex; align-items:center; gap:10px;
}
#${bodyId} .empty-note .empty-text{
  text-align:center; font-size:14.5px; padding:10px 12px; color:var(--muted);
}
#${bodyId} .qty-label{ font-size:11px; letter-spacing:.4px; }
#${bodyId} input.qty-buy, #${bodyId} input.qty-sell{
  width:88px; height:36px;
  background:#070b0e !important;
  border:1px solid var(--accent);
  border-radius:5px;
  color:var(--text) !important;
  padding:0 10px;
  text-align:center;
  font-weight:800;
  outline:none;
  box-shadow:0 0 8px rgba(0,0,0,.55) inset;
}
#${bodyId} .btn{
  height:36px; min-width:110px; padding:0 14px;
  background:#0b1217;
  border:1px solid var(--accent);
  border-radius:5px;
  color:var(--text) !important; font-weight:800;
}
#${bodyId} .btn:hover:not([disabled]){
  color:var(--yellow) !important; border-color:var(--yellow); box-shadow:0 0 12px rgba(39,255,215,.25);
}
#${bodyId} .btn[disabled]{ opacity:.6; cursor:not-allowed; }

/* “Fixer” tag strip */
#${bodyId} .fixer-tag{
  margin:0 0 4px; padding:8px 10px;
  border:2px solid var(--accent);
  border-left-width:6px;
  border-radius:10px;
  background:rgba(39,255,215,.06);
  font-size:12px;
}

/* Sell block looks like a framed section */
#${bodyId} [data-sell-list] .item-row{ padding:10px; }
#${bodyId} .card[data-sell]{ padding-top:6px; }

#${bodyId} input, #${bodyId} select, #${bodyId} button{ font-family:inherit; }
#${bodyId} input, #${bodyId} select{ background:#070b0e !important; color:var(--text) !important; border-color:var(--accent) !important; }
#${bodyId} label{ color:var(--muted) !important; }
#${bodyId} .item-row b:not(.price-line b){ color:var(--text) !important; }

/* keep Foundry popout header icons visible */
.dialog-host-${bodyId} .window-header .popout,
.dialog-host-${bodyId} .window-header .close{ color:var(--text) !important; }
`;
}


// Footer buttons themed + fixed height
function forceFooterButtons(app, accent, opts={}){
  const minBtnWidth = Number(opts.minBtnWidth ?? 96);
  const btns = app.querySelectorAll(".dialog-buttons .dialog-button");
  for (const b of btns){
    Object.assign(b.style, {
      background:"rgba(0,0,0,.5)",
      color:accent,
      border:`1px solid ${accent}`,
      borderRadius:"10px",
      padding:"6px 12px",
      fontWeight:"800",
      fontFamily:"inherit",
      fontSize:"14px",
      height:"36px",
      minHeight:"36px",
      width:"auto",
      minWidth:`${minBtnWidth}px`,
      lineHeight:"1.2"
    });
  }
}

// -------------------- autosize --------------------
function autosizeDialog(appEl, bodyId){
  const app = appEl?.[0] ?? appEl; if (!app) return;
  const header  = app.querySelector(".window-header");
  const footer  = app.querySelector(".dialog-buttons");
  const content = app.querySelector(".window-content");
  const wrap    = content?.querySelector(`#${bodyId} .wrap`);
  if (!content || !wrap) return;

  const minW = Number(app.dataset.bodegaMinW || 720);
  const capW = Number(app.dataset.bodegaCapW || 1200);

  const pad = 24;
  const measuredW = Math.ceil(Math.max(wrap.scrollWidth + pad, minW));
  const fixedW = app.dataset.bodegaFixedW || Math.min(measuredW, capW);
  app.dataset.bodegaFixedW = fixedW;
  app.style.width = `${fixedW}px`;

  const hH = header?.offsetHeight ?? 36;
  const fH = footer?.offsetHeight ?? 46;
  const margin = 16;
  const natural = wrap.scrollHeight + hH + fH + margin;
  const capH = Math.max(360, Math.min(window.innerHeight - 24, 900));

  if (natural <= capH){
    app.style.height = "auto";
    content.style.height = "auto";
    content.style.overflowX = "hidden";
    content.style.overflowY = "visible";
  } else {
    const totalH  = Math.min(natural, capH);
    app.style.height = `${totalH}px`;
    const contentH = Math.max(200, totalH - hH - fH);
    content.style.height = `${contentH}px`;
    content.style.overflowX = "hidden";
    content.style.overflowY = "auto";
  }
}
function observeResize(app, bodyId){
  const content= (app?.[0] ?? app)?.querySelector(".window-content");
  if (!content) return;
  let t=null;
  const mo = new MutationObserver(()=>{ clearTimeout(t); t=setTimeout(()=>autosizeDialog(app, bodyId), 30); });
  mo.observe(content, { childList:true, subtree:true, attributes:true });
  return mo;
}

// -------------------- source + Fixer access helpers --------------------
function splitReferenceList(value){
  if (Array.isArray(value)) return value.flatMap(splitReferenceList);
  return String(value ?? "").split(/[\r\n,;]+/g).map(ref => ref.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}
function normalizeAutoFixerLock(value){
  return {
    enabled:!!value?.enabled,
    threshold:Math.max(0, Math.min(999999, Number(value?.threshold ?? 500)|0))
  };
}
function syncAutoFixerLock(item, defaults={}, {newItem=false}={}){
  if (!item) return item;
  const cfg = normalizeAutoFixerLock(defaults?.autoFixerLock);
  const qualifies = cfg.enabled && Number(item.price || 0) >= cfg.threshold;
  if (qualifies){
    // Preserve a GM's existing manual Fixer-only choice. Newly created non-Fixer items
    // are tagged so disabling/changing the global rule can safely undo only our own lock.
    if (!item.fixerOnly || item.autoFixerLocked || newItem){
      if (!item.fixerOnly || item.autoFixerLocked){
        item.fixerOnly = true;
        item.fixerMinRank = null;
        item.autoFixerLocked = true;
      }
    }
  } else if (item.autoFixerLocked){
    item.fixerOnly = false;
    item.fixerMinRank = null;
    item.autoFixerLocked = false;
  }
  return item;
}
function syncAllAutoFixerLocks(db){
  if (!db?.shops) return;
  for (const shop of Object.values(db.shops)) for (const item of (shop.items || [])) syncAutoFixerLock(item, db.defaults, {newItem:false});
}

// -------------------- quick add search helpers --------------------
async function findItemByNameFromPack(packKey, name){
  const pack = game.packs.get(packKey);
  if (!pack || pack.documentName!=="Item") return null;
  const idx = await pack.getIndex({fields:["name","img","system.price","system.price.market"]});
  const hit = idx.find(e=>e.name?.toLowerCase()===name.toLowerCase()) || idx.find(e=>e.name?.toLowerCase().includes(name.toLowerCase()));
  return hit ? await pack.getDocument(hit._id) : null;
}
async function findItemByNameFromPacks(ref, name){
  for (const pack of resolveDynamicItemPacks(ref)){
    const doc = await findItemByNameFromPack(pack.collection, name);
    if (doc) return doc;
  }
  return null;
}
async function findItemAnywhere(name){
  const world = game.items.getName(name) || game.items.find(i=>i.name?.toLowerCase().includes(name.toLowerCase()));
  if (world) return world;
  for (const p of game.packs.filter(x=>x.documentName==="Item")){
    const idx = await p.getIndex({fields:["name"]});
    const hit = idx.find(e=>e.name?.toLowerCase()===name.toLowerCase()) || idx.find(e=>e.name?.toLowerCase().includes(name.toLowerCase()));
    if (hit) return await p.getDocument(hit._id);
  }
  return null;
}


// -------------------- dynamic inventory / Simple Calendar --------------------
const dynamicClampInt = (value, min, max) => Math.min(max, Math.max(min, Number.parseInt(value, 10) || 0));
const dynamicRandomInt = (min, max) => {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (high - low + 1)) + low;
};
const dynamicShuffle = (values) => {
  const copy = [...(values || [])];
  for (let i = copy.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};
function splitDynamicReferences(value){ return splitReferenceList(value); }
function normalizeDynamicPackKey(ref){
  let value = String(ref || "").trim().replace(/^Compendium\./i, "");
  const itemMarker = value.indexOf(".Item.");
  if (itemMarker >= 0) value = value.slice(0, itemMarker);
  return value;
}
function resolveDynamicItemPacks(ref){
  const found = [];
  const seen = new Set();
  for (const raw of splitDynamicReferences(ref)){
    const key = normalizeDynamicPackKey(raw);
    const low = key.toLowerCase();
    const direct = game.packs.get(key);
    const matches = game.packs.filter(pack => {
      if (pack.documentName !== "Item") return false;
      const values = [pack.collection, pack.metadata?.id, pack.metadata?.name, pack.metadata?.label, pack.title, `${pack.metadata?.packageName || ""}.${pack.metadata?.name || ""}`]
        .filter(Boolean).map(value => String(value).toLowerCase());
      return values.includes(low) || values.some(value => value.endsWith(`.${low}`));
    });
    if (direct?.documentName === "Item") matches.unshift(direct);
    for (const pack of matches){
      if (seen.has(pack.collection)) continue;
      seen.add(pack.collection);
      found.push(pack);
    }
  }
  return found;
}
async function findDynamicRollTable(ref){
  const candidate = String(ref || "").trim();
  if (!candidate) return null;
  try{
    const direct = await fromUuid(candidate);
    if (direct?.documentName === "RollTable") return direct;
  }catch{}
  if (candidate.includes("::")){
    const splitAt = candidate.indexOf("::");
    const packKey = candidate.slice(0, splitAt).replace(/^Compendium\./i, "").trim();
    const rest = candidate.slice(splitAt + 2).trim();
    const pack = game.packs.get(packKey);
    if (pack?.documentName === "RollTable"){
      const idx = await pack.getIndex({fields:["name"]});
      const low = rest.toLowerCase();
      const hit = idx.find(entry => entry._id === rest)
        || idx.find(entry => entry.name?.toLowerCase() === low)
        || idx.find(entry => entry.name?.toLowerCase().includes(low));
      if (hit) return pack.getDocument(hit._id);
    }
  }
  const worldById = game.tables.get(candidate);
  if (worldById) return worldById;
  const low = candidate.toLowerCase();
  const worldByName = game.tables.find(table => table.name?.toLowerCase() === low)
    || game.tables.find(table => table.name?.toLowerCase().includes(low));
  if (worldByName) return worldByName;
  for (const pack of game.packs.filter(pack => pack.documentName === "RollTable")){
    try{
      const index = await pack.getIndex({fields:["name"]});
      const hit = index.find(entry => entry._id === candidate)
        || index.find(entry => entry.name?.toLowerCase() === low)
        || index.find(entry => entry.name?.toLowerCase().includes(low));
      if (hit) return pack.getDocument(hit._id);
    }catch{}
  }
  return null;
}
async function findDynamicRollTables(ref){
  const tables = [];
  const seen = new Set();
  for (const candidate of splitDynamicReferences(ref)){
    const table = await findDynamicRollTable(candidate);
    if (!table || seen.has(table.uuid)) continue;
    seen.add(table.uuid);
    tables.push(table);
  }
  return tables;
}
async function resolveDynamicTableResultDocument(result){
  if (!result) return null;
  try{
    let doc = result.document;
    if (doc && typeof doc.then === "function") doc = await doc;
    if (doc) return doc;
  }catch{}
  try{
    if (typeof result.getDocument === "function"){
      const doc = await result.getDocument();
      if (doc) return doc;
    }
  }catch{}
  const collection = String(result.documentCollection || result.collection || "").trim();
  const documentId = String(result.documentId || result.documentID || "").trim();
  if (collection && documentId){
    const normalizedCollection = collection.replace(/^Compendium\./i, "");
    const pack = game.packs.get(normalizedCollection);
    if (pack){ try{ const doc = await pack.getDocument(documentId); if (doc) return doc; }catch{} }
    if (["Item","items"].includes(collection)){
      const doc = game.items.get(documentId);
      if (doc) return doc;
    }
    try{ const doc = await fromUuid(`${collection}.${documentId}`); if (doc) return doc; }catch{}
  }
  const text = String(result.text || "");
  const uuidMatch = text.match(/@UUID\[([^\]]+)\]/i);
  if (uuidMatch){ try{ const doc = await fromUuid(uuidMatch[1]); if (doc) return doc; }catch{} }
  const compendiumMatch = text.match(/@Compendium\[([^\]]+)\]/i);
  if (compendiumMatch){
    const parts = compendiumMatch[1].split(".");
    const documentId = parts.pop();
    const packKey = parts.join(".");
    const pack = game.packs.get(packKey);
    if (pack && documentId){ try{ const doc = await pack.getDocument(documentId); if (doc) return doc; }catch{} }
  }
  return null;
}
async function rollDynamicTable(table){
  let working = table;
  try{
    working = await table.clone({}, {save:false});
    for (const result of working.results || []) result.updateSource({drawn:false});
  }catch{}
  return working.roll({recursive:true});
}
async function drawDynamicItemFromTable(ref, depth=0){
  if (!ref || depth > 4) return null;
  const tables = await findDynamicRollTables(ref);
  for (const table of dynamicShuffle(tables)){
    try{
      const roll = await rollDynamicTable(table);
      for (const result of dynamicShuffle(roll?.results || [])){
        const doc = await resolveDynamicTableResultDocument(result);
        if (doc?.documentName === "Item") return doc;
        if (doc?.documentName === "RollTable"){
          const nested = await drawDynamicItemFromTable(doc.uuid, depth + 1);
          if (nested) return nested;
        }
      }
    }catch(error){ console.warn(`Bodega | Dynamic RollTable failed: ${table.name}`, error); }
  }
  return null;
}
async function drawDynamicItemFromPack(ref){
  const candidates = [];
  for (const pack of resolveDynamicItemPacks(ref)){
    try{
      const index = await pack.getIndex({fields:["name","img"]});
      for (const entry of index) candidates.push([pack, entry]);
    }catch{}
  }
  if (!candidates.length) return null;
  const [pack, entry] = candidates[dynamicRandomInt(0, candidates.length - 1)];
  return pack.getDocument(entry._id);
}
async function dynamicPoolEntryToDocument(entry){
  if (!entry) return null;
  if (entry.uuid){ const doc = await byUUID(entry.uuid); if (doc) return doc; }
  return entry.name ? findItemAnywhere(entry.name) : null;
}
async function chooseDynamicSourceDocument(shop, defaults={}){
  const dynamic = normalizeDynamicSettings(shop.dynamic || (shop.dynamic = defaultDynamicSettings()));
  const mode = dynamic.stockSource;
  if (mode === "pool"){
    for (const entry of dynamicShuffle(dynamic.stockPool)){
      const doc = await dynamicPoolEntryToDocument(entry);
      if (doc) return doc;
    }
    return null;
  }
  if (mode === "pack") return drawDynamicItemFromPack(dynamic.stockPack || shop.packKey || defaults.packKey || "");
  return drawDynamicItemFromTable(dynamic.stockTable || shop.rollTable || defaults.rollTable || "");
}
function getDynamicMarketPrice(doc){
  const raw = doc?.system?.price?.market ?? doc?.system?.price ?? 0;
  return Math.max(0, Number(raw) || 0);
}
function buildDynamicStockItem(doc, dynamic, now=calendarTimestamp(), defaults={}){
  const price = getDynamicMarketPrice(doc);
  const item = {
    uuid:doc.uuid,
    name:doc.name,
    img:doc.img,
    price,
    packageSize:marketPackageSizeFromData(doc),
    marketPackagePrice:price,
    qty:dynamicRandomInt(dynamic.qtyMin, dynamic.qtyMax),
    infinite:false,
    fixerOnly:false,
    fixerMinRank:null,
    dynamicManaged:true,
    tradeIn:false,
    stockClass:"dynamic",
    autoFixerLocked:false,
    generatedAt:Number(now || 0)
  };
  return syncAutoFixerLock(item, defaults, {newItem:true});
}
function dynamicItemKey(itemOrDoc){
  return String(itemOrDoc?.uuid || itemOrDoc?.name || "").toLowerCase();
}
async function fillDynamicStock(shop, {replace=false, defaults={}, now=calendarTimestamp()}={}){
  const dynamic = normalizeDynamicSettings(shop.dynamic || (shop.dynamic = defaultDynamicSettings()));
  shop.dynamic = dynamic;
  shop.items ||= [];
  if (replace) shop.items = shop.items.filter(item => !item.dynamicManaged);
  const target = dynamicRandomInt(dynamic.minItems, dynamic.maxItems);
  let managed = shop.items.filter(item => item.dynamicManaged);
  if (managed.length > target){
    const removable = dynamicShuffle(managed).sort((a,b) => Number(a.qty || 0) - Number(b.qty || 0));
    const removeSet = new Set(removable.slice(0, managed.length - target));
    shop.items = shop.items.filter(item => !removeSet.has(item));
    managed = shop.items.filter(item => item.dynamicManaged);
  }
  const seen = new Set(shop.items.map(dynamicItemKey).filter(Boolean));
  let attempts = 0;
  while (managed.length < target && attempts < 80){
    attempts++;
    const doc = await chooseDynamicSourceDocument(shop, defaults);
    if (!doc || doc.documentName !== "Item") break;
    const key = dynamicItemKey(doc);
    if (!key || seen.has(key)) continue;
    const item = buildDynamicStockItem(doc, dynamic, now, defaults);
    shop.items.push(item);
    managed.push(item);
    seen.add(key);
  }
  return managed.length;
}
async function runNpcTraffic(shop, events=1, now=calendarTimestamp()){
  const dynamic = normalizeDynamicSettings(shop.dynamic || (shop.dynamic = defaultDynamicSettings()));
  if (!dynamic.npcTraffic) return {events:0, units:0};
  const eventCount = dynamicClampInt(events, 0, 24);
  let units = 0;
  for (let eventIndex=0; eventIndex<eventCount; eventIndex++){
    for (const item of shop.items || []){
      if (!item.dynamicManaged || item.infinite) continue;
      const qty = Math.max(0, Number(item.qty || 0));
      if (!qty || Math.random() >= 0.50) continue;
      const cap = Math.min(qty, Math.random() < 0.18 ? 3 : 2);
      const sold = dynamicRandomInt(1, Math.max(1, cap));
      item.qty = Math.max(0, qty - sold);
      units += sold;
    }
  }
  if (eventCount) dynamic.lastTraffic = Number(now || dynamic.lastTraffic || 0);
  shop.dynamic = dynamic;
  return {events:eventCount, units};
}
async function restockDynamicShop(shop, {defaults={}, now=calendarTimestamp()}={}){
  const dynamic = normalizeDynamicSettings(shop.dynamic || (shop.dynamic = defaultDynamicSettings()));
  shop.dynamic = dynamic;
  shop.items ||= [];
  if (dynamic.restockMode === "rotate"){
    const lowThreshold = Math.max(dynamic.qtyMin, Math.ceil(Math.max(1, dynamic.qtyMax) * 0.25));
    shop.items = shop.items.filter(item => {
      if (!item.dynamicManaged) return true;
      const qty = Math.max(0, Number(item.qty || 0));
      if (qty <= 0) return false;
      if (qty <= lowThreshold && Math.random() < 0.55) return false;
      return true;
    });
  }
  for (const item of shop.items){
    if (!item.dynamicManaged || item.infinite) continue;
    item.qty = dynamicRandomInt(dynamic.qtyMin, dynamic.qtyMax);
  }
  await fillDynamicStock(shop, {replace:false, defaults, now});
  dynamic.lastRestock = Number(now || dynamic.lastRestock || 0);
  if (!dynamic.initializedAt) dynamic.initializedAt = Number(now || Date.now());
  return shop;
}
function getSimpleCalendar(){
  return globalThis.SimpleCalendar?.api ? globalThis.SimpleCalendar : null;
}
function calendarTimestamp(){
  const sc = getSimpleCalendar();
  try{ return Number(sc?.api?.timestamp?.() ?? 0); }catch{ return 0; }
}
function calendarDate(){
  const sc = getSimpleCalendar();
  try{ return sc?.api?.currentDateTime?.() ?? null; }catch{ return null; }
}
function calendarDayKey(date=calendarDate()){
  if (!date) return "";
  return `${date.year}:${date.month}:${date.day}`;
}
function calendarTimeConfig(){
  const sc = getSimpleCalendar();
  try{ return sc?.api?.getTimeConfiguration?.() || {hoursInDay:24, minutesInHour:60, secondsInMinute:60}; }
  catch{ return {hoursInDay:24, minutesInHour:60, secondsInMinute:60}; }
}
function calendarDaySeconds(){
  const cfg = calendarTimeConfig();
  return Math.max(1, Number(cfg.hoursInDay || 24) * Number(cfg.minutesInHour || 60) * Number(cfg.secondsInMinute || 60));
}
function calendarDayStart(date=calendarDate()){
  const sc = getSimpleCalendar();
  if (!sc || !date) return 0;
  try{
    return Number(sc.api.dateToTimestamp({year:date.year, month:date.month, day:date.day, hour:0, minute:0, seconds:0}) || 0);
  }catch{ return 0; }
}
function addCalendarDays(timestamp, days){
  const sc = getSimpleCalendar();
  if (!timestamp) return 0;
  try{ return Number(sc?.api?.timestampPlusInterval?.(timestamp, {day:Number(days) || 0}) || 0); }
  catch{ return timestamp + calendarDaySeconds() * (Number(days) || 0); }
}
function calendarTimeOnDay(date, hour, minute){
  const sc = getSimpleCalendar();
  if (!sc || !date) return 0;
  const cfg = calendarTimeConfig();
  const h = dynamicClampInt(hour, 0, Math.max(0, Number(cfg.hoursInDay || 24) - 1));
  const m = dynamicClampInt(minute, 0, Math.max(0, Number(cfg.minutesInHour || 60) - 1));
  try{ return Number(sc.api.dateToTimestamp({year:date.year, month:date.month, day:date.day, hour:h, minute:m, seconds:0}) || 0); }
  catch{ return calendarDayStart(date) + h * Number(cfg.minutesInHour || 60) * Number(cfg.secondsInMinute || 60) + m * Number(cfg.secondsInMinute || 60); }
}
function isCalendarPrimaryGM(){
  if (!game.user?.isGM) return false;
  const sc = getSimpleCalendar();
  try{ if (typeof sc?.api?.isPrimaryGM === "function") return !!sc.api.isPrimaryGM(); }catch{}
  return game.users?.activeGM?.id ? game.users.activeGM.id === game.user.id : true;
}
function scheduleNextRestock(shop, now=calendarTimestamp(), date=calendarDate()){
  const dynamic = normalizeDynamicSettings(shop.dynamic || (shop.dynamic = defaultDynamicSettings()));
  const today = calendarTimeOnDay(date, dynamic.restockHour, dynamic.restockMinute);
  if (!today){ dynamic.nextRestock = 0; return 0; }
  dynamic.nextRestock = today > now ? today : addCalendarDays(today, 1);
  shop.dynamic = dynamic;
  return dynamic.nextRestock;
}
function generateTrafficSchedule(shop, now=calendarTimestamp(), date=calendarDate(), {markPastDone=false}={}){
  const dynamic = normalizeDynamicSettings(shop.dynamic || (shop.dynamic = defaultDynamicSettings()));
  const start = calendarDayStart(date);
  if (!start){ dynamic.trafficSchedule=[]; dynamic.trafficDayKey=""; return []; }
  const cfg = calendarTimeConfig();
  const hourSeconds = Number(cfg.minutesInHour || 60) * Number(cfg.secondsInMinute || 60);
  const minuteSeconds = Number(cfg.secondsInMinute || 60);
  const firstHour = Math.min(8, Math.max(0, Number(cfg.hoursInDay || 24) - 1));
  const lastHour = Math.max(firstHour, Number(cfg.hoursInDay || 24) - 1);
  const count = dynamicRandomInt(dynamic.trafficMin, dynamic.trafficMax);
  const slots = [];
  let attempts = 0;
  while (slots.length < count && attempts < 120){
    attempts++;
    const hour = dynamicRandomInt(firstHour, lastHour);
    const minute = dynamicRandomInt(0, Math.max(0, Number(cfg.minutesInHour || 60) - 1));
    const ts = start + hour * hourSeconds + minute * minuteSeconds;
    if (slots.some(existing => Math.abs(existing - ts) < hourSeconds * 1.5)) continue;
    slots.push(ts);
  }
  dynamic.trafficDayKey = calendarDayKey(date);
  dynamic.trafficSchedule = slots.sort((a,b)=>a-b).map(ts => ({ts, done:markPastDone && ts <= now}));
  shop.dynamic = dynamic;
  return dynamic.trafficSchedule;
}
function advanceDueRestock(shop, now){
  const dynamic = normalizeDynamicSettings(shop.dynamic || (shop.dynamic = defaultDynamicSettings()));
  if (!dynamic.restockEnabled) return {count:0, lastDue:0};
  if (!dynamic.nextRestock) scheduleNextRestock(shop, now);
  let next = Number(dynamic.nextRestock || 0);
  if (!next || next > now) return {count:0, lastDue:0};
  let count = 0;
  let lastDue = 0;
  while (next && next <= now && count < 400){
    lastDue = next;
    count++;
    next = addCalendarDays(next, 1);
  }
  if (next && next <= now){
    const days = Math.floor((now - next) / calendarDaySeconds()) + 1;
    lastDue = next + (days - 1) * calendarDaySeconds();
    count += days;
    next += days * calendarDaySeconds();
  }
  dynamic.nextRestock = next;
  shop.dynamic = dynamic;
  return {count, lastDue};
}
async function initializeDynamicShop(shop, defaults={}, now=calendarTimestamp(), {markPastTraffic=true}={}){
  const dynamic = normalizeDynamicSettings(shop.dynamic || (shop.dynamic = defaultDynamicSettings()));
  shop.dynamic = dynamic;
  if (!(shop.items || []).some(item => item.dynamicManaged)) await fillDynamicStock(shop, {replace:false, defaults, now});
  dynamic.initializedAt = Number(now || Date.now());
  dynamic.lastProcessed = Number(now || 0);
  scheduleNextRestock(shop, now);
  generateTrafficSchedule(shop, now, calendarDate(), {markPastDone:markPastTraffic});
  return shop;
}
function humanizeCalendarDelta(timestamp, now=calendarTimestamp()){
  if (!timestamp || !now) return "not scheduled";
  let delta = Math.max(0, Number(timestamp) - Number(now));
  const cfg = calendarTimeConfig();
  const minute = Number(cfg.secondsInMinute || 60);
  const hour = Number(cfg.minutesInHour || 60) * minute;
  const day = Number(cfg.hoursInDay || 24) * hour;
  const days = Math.floor(delta / day); delta -= days * day;
  const hours = Math.floor(delta / hour); delta -= hours * hour;
  const minutes = Math.floor(delta / minute);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
function nextTrafficTimestamp(shop, now=calendarTimestamp()){
  return (shop?.dynamic?.trafficSchedule || []).filter(entry => !entry.done && Number(entry.ts || 0) > now).map(entry => Number(entry.ts)).sort((a,b)=>a-b)[0] || 0;
}
function dynamicStatusSummary(shop, now=calendarTimestamp()){
  const dynamic = normalizeDynamicSettings(shop?.dynamic);
  if (!dynamic.enabled) return "Static inventory";
  if (!getSimpleCalendar()) return "Dynamic enabled · Simple Calendar unavailable";
  const nextTraffic = nextTrafficTimestamp(shop, now);
  const trafficText = dynamic.npcTraffic ? (nextTraffic ? `customer traffic in ${humanizeCalendarDelta(nextTraffic, now)}` : "customer traffic scheduled next day") : "customer traffic off";
  const restockText = dynamic.restockEnabled ? (dynamic.nextRestock ? `restock in ${humanizeCalendarDelta(dynamic.nextRestock, now)}` : "restock awaiting schedule") : "restock off";
  return `${trafficText} · ${restockText}`;
}
async function processDynamicInventory({forceTraffic=false, forceRestock=false, shopId=null}={}){
  if (calendarProcessing || !isCalendarPrimaryGM()) return false;
  const sc = getSimpleCalendar();
  if (!sc) return false;
  calendarProcessing = true;
  try{
    const now = calendarTimestamp();
    const date = calendarDate();
    if (!now || !date) return false;
    const db = await loadAll();
    let changed = false;
    const shops = shopId ? [db.shops?.[shopId]].filter(Boolean) : Object.values(db.shops || {});
    for (const shop of shops){
      const dynamic = normalizeDynamicSettings(shop.dynamic);
      shop.dynamic = dynamic;
      if (!dynamic.enabled) continue;
      if (!dynamic.initializedAt){
        await initializeDynamicShop(shop, db.defaults, now, {markPastTraffic:true});
        changed = true;
        continue;
      }

      // If a long jump crossed one or many deliveries, resolve only the latest restock.
      // Earlier traffic is irrelevant because the later delivery overwrote that shelf state.
      let restockCutoff = 0;
      const dueRestock = advanceDueRestock(shop, now);
      if (forceRestock){
        await restockDynamicShop(shop, {defaults:db.defaults, now});
        scheduleNextRestock(shop, now);
        restockCutoff = now;
        changed = true;
      } else if (dueRestock.count){
        await restockDynamicShop(shop, {defaults:db.defaults, now:dueRestock.lastDue});
        restockCutoff = dueRestock.lastDue;
        changed = true;

        // If a large jump lands before today's delivery, the latest due delivery was yesterday.
        // Collapse yesterday's post-delivery shoppers into a few aggregate customer events rather
        // than replaying every missed hook. The next daily restock still remains the hard reset.
        const todayStart = calendarDayStart(date);
        if (dynamic.npcTraffic && dueRestock.lastDue < todayStart){
          const activeFraction = Math.max(0, Math.min(1, (todayStart - dueRestock.lastDue) / calendarDaySeconds()));
          const typical = dynamicRandomInt(dynamic.trafficMin, dynamic.trafficMax);
          const catchupEvents = Math.max(0, Math.round(typical * activeFraction));
          if (catchupEvents) await runNpcTraffic(shop, catchupEvents, todayStart - 1);
        }
      }

      // Resolve the still-stored schedule first. Events before a catch-up restock are discarded;
      // events after it reduce the freshly delivered stock.
      const oldDue = (dynamic.trafficSchedule || []).filter(entry => !entry.done && Number(entry.ts || 0) <= now);
      const actionableOld = oldDue.filter(entry => !restockCutoff || Number(entry.ts || 0) > restockCutoff);
      for (const entry of oldDue) entry.done = true;
      if (actionableOld.length && dynamic.npcTraffic){
        await runNpcTraffic(shop, actionableOld.length, now);
        changed = true;
      }

      if (dynamic.trafficDayKey !== calendarDayKey(date)){
        generateTrafficSchedule(shop, now, date, {markPastDone:false});
        changed = true;
      }

      const dueToday = (dynamic.trafficSchedule || []).filter(entry => !entry.done && Number(entry.ts || 0) <= now && (!restockCutoff || Number(entry.ts || 0) > restockCutoff));
      for (const entry of (dynamic.trafficSchedule || [])){
        if (!entry.done && Number(entry.ts || 0) <= now && restockCutoff && Number(entry.ts || 0) <= restockCutoff) entry.done = true;
      }
      if (forceTraffic && dynamic.npcTraffic){
        await runNpcTraffic(shop, 1, now);
        changed = true;
      } else if (dueToday.length && dynamic.npcTraffic){
        for (const entry of dueToday) entry.done = true;
        await runNpcTraffic(shop, dueToday.length, now);
        changed = true;
      }

      dynamic.lastProcessed = now;
    }
    if (changed) await saveAll(db);
    return changed;
  }catch(error){
    console.error("Bodega | Dynamic inventory processing failed", error);
    return false;
  }finally{ calendarProcessing = false; }
}
function bindCalendarHooks(){
  if (calendarHookBound) return;
  const bind = () => {
    const sc = getSimpleCalendar();
    if (!sc) return false;
    const hookName = sc.Hooks?.DateTimeChange || "simple-calendar-date-time-change";
    Hooks.on(hookName, () => processDynamicInventory());
    calendarHookBound = true;
    processDynamicInventory();
    return true;
  };
  if (bind()) return;
  Hooks.on("simple-calendar-ready", bind);
}
async function addDynamicPoolDocument(pool, doc){
  if (!doc || doc.documentName !== "Item") return false;
  if (pool.some(entry => entry.uuid === doc.uuid)) return false;
  pool.push({uuid:doc.uuid, name:doc.name, img:doc.img});
  return true;
}
function renderDynamicPool(pool){
  return (pool || []).map((entry, index) => `<span class="face-chip" data-dyn-pool-i="${index}"><img class="face" src="${esc(entry.img || 'icons/svg/item-bag.svg')}"><b>${esc(entry.name)}</b><span class="x" data-dyn-pool-rem="${index}" title="Remove">✕</span></span>`).join("") || `<span class="muted">No curated dynamic stock items yet.</span>`;
}
function readDynamicEditorForm(root, shop){
  const dynamic = normalizeDynamicSettings(shop.dynamic);
  const q = selector => root.querySelector(selector);
  dynamic.enabled = !!q(".dyn-enabled")?.checked;
  dynamic.stockSource = q(".dyn-source")?.value || dynamic.stockSource;
  dynamic.stockTable = q(".dyn-table")?.value.trim() || "";
  dynamic.stockPack = q(".dyn-pack")?.value.trim() || "";
  dynamic.minItems = dynamicClampInt(q(".dyn-min-items")?.value, 1, 50);
  dynamic.maxItems = dynamicClampInt(q(".dyn-max-items")?.value, dynamic.minItems, 50);
  dynamic.qtyMin = dynamicClampInt(q(".dyn-qty-min")?.value, 0, 999);
  dynamic.qtyMax = dynamicClampInt(q(".dyn-qty-max")?.value, dynamic.qtyMin, 999);
  dynamic.npcTraffic = !!q(".dyn-traffic")?.checked;
  dynamic.trafficMin = dynamicClampInt(q(".dyn-traffic-min")?.value, 0, 12);
  dynamic.trafficMax = dynamicClampInt(q(".dyn-traffic-max")?.value, dynamic.trafficMin, 12);
  dynamic.restockEnabled = !!q(".dyn-restock")?.checked;
  const cfg = calendarTimeConfig();
  dynamic.restockHour = dynamicClampInt(q(".dyn-restock-hour")?.value, 0, Math.max(0, Number(cfg.hoursInDay || 24)-1));
  dynamic.restockMinute = dynamicClampInt(q(".dyn-restock-minute")?.value, 0, Math.max(0, Number(cfg.minutesInHour || 60)-1));
  dynamic.restockMode = q(".dyn-restock-mode")?.value === "refill" ? "refill" : "rotate";
  shop.dynamic = dynamic;
  return dynamic;
}

// -------------------- Fixer detection & discount (SELL ONLY bonus) --------------------
function getFixerRank(actor){
  const items = actor?.items ?? [];
  let rank = 0;
  for (const it of items){
    const n = String(it.name||"").toLowerCase();
    if (n.includes("operator")) {
      const r = Number(it.system?.rank ?? it.system?.level ?? 0);
      if (r>rank) rank=r;
    }
    const roles = it.type?.toLowerCase?.() || "";
    if ((roles.includes("role") || roles.includes("ability")) && n.includes("fixer")){
      const r2 = Number(it.system?.rank ?? it.system?.level ?? 0);
      if (r2>rank) rank=r2;
    }
  }
  rank = Number(actor.getFlag?.("world","fixerRank") ?? rank) || 0;
  return Math.max(0, rank|0);
}
function rankToDiscount(rank, disc){
  if (rank >= 9) return Math.max(0, Number(disc.t3|0));
  if (rank >= 3) return Math.max(0, Number(disc.t2|0));
  if (rank >= 1) return Math.max(0, Number(disc.t1|0));
  return 0;
}
// SELL-side only: boost vendor offer by Operator discount; clamp to 120%
function applyFixerBonusToSell(basePct, rank, discCfg){
  const b = rankToDiscount(rank, discCfg);
  return Math.min(120, Math.max(0, Math.round((basePct|0) * (100 + b) / 100)));
}
function priceWithFixerBuyDiscount(listPrice, isFixer, rank, discCfg, fixerOnlyFlag){
  if (!fixerOnlyFlag || !isFixer) return Number(listPrice|0);
  const off = rankToDiscount(rank, discCfg);
  return Math.max(0, Math.round(Number(listPrice|0) * (100 - off) / 100));
}

// -------------------- Options dialog --------------------
async function openOptions(){
  const bodyId = makeUiId("options");
  const db = await loadAll();
  const accent = db.era2045 ? "#E64539" : "#00FFF7";
  const style = document.createElement("style"); style.textContent = makeAdminCSS(accent, bodyId);

  const d = db.defaults ?? {};
  const content = `
  <div id="${bodyId}">
    <div class="wrap edit">
      <div class="title">Bodega™ Options</div>
      <div class="row" style="flex-direction:column; align-items:stretch">
        <label>Default Compendium Pack Key(s)<br>
          <textarea class="pack" placeholder="package.pack — comma or new line separates multiple">${esc(d.packKey||"")}</textarea>
        </label>
        <label>Default Roll Table(s) (UUID/Name/pack::name)<br>
          <textarea class="table" placeholder="Comma or new line separates multiple RollTables">${esc(d.rollTable||"")}</textarea>
        </label>
        <div class="row"><button class="btn" type="button" data-test-pack-default>Check Pack Defaults</button><button class="btn" type="button" data-test-table-default>Test RollTable Default</button></div>
        <label class="row" style="gap:6px;margin-top:6px">
          <input type="checkbox" class="era" ${db.era2045?"checked":""}>
          Use <b>2045 red</b> theme (#E64539)
        </label>
        <fieldset style="border:1px solid var(--accent);border-radius:8px;padding:8px;margin-top:8px">
          <legend style="padding:0 6px">Fixer Access / Price Gate</legend>
          <div class="row" style="gap:10px">
            <label class="row" style="gap:6px"><input type="checkbox" class="auto-fixer-lock" ${normalizeAutoFixerLock(d.autoFixerLock).enabled?'checked':''}> Automatically make high-price inventory <b>Fixer-only</b></label>
            <label>At or above <input type="number" class="auto-fixer-threshold" min="0" max="999999" step="1" value="${normalizeAutoFixerLock(d.autoFixerLock).threshold}" style="width:100px"> eb</label>
          </div>
          <div class="muted" style="margin-top:6px">Useful for 2045 stock tables. Automatic locks are tracked separately, so disabling this setting does not erase items you marked Fixer-only by hand.</div>
        </fieldset>
        <fieldset style="border:1px solid var(--accent);border-radius:8px;padding:8px;margin-top:8px">
          <legend style="padding:0 6px">Fixer Discounts (Operator Rank)</legend>
          <div class="row" style="gap:12px">
            <label>Rank 1–2: <input type="number" class="d1" min="0" max="95" step="1" value="${Number(d.fixerDiscounts?.t1 ?? 10)|0}" style="width:72px"> %</label>
            <label>Rank 3–8: <input type="number" class="d2" min="0" max="95" step="1" value="${Number(d.fixerDiscounts?.t2 ?? 15)|0}" style="width:72px"> %</label>
            <label>Rank 9–10: <input type="number" class="d3" min="0" max="95" step="1" value="${Number(d.fixerDiscounts?.t3 ?? 20)|0}" style="width:72px"> %</label>
          </div>
          <div class="muted">Operator bonuses are applied only when <b>buying select items or selling to the vendor</b>.</div>
        </fieldset>
      </div>
    </div>
  </div>`;

  const dlg = new Dialog({
    title: "Bodega™ Options",
    content,
    buttons: {
      save: {
        label: "Save",
        callback: async (html) => {
          const root = html[0].querySelector(`#${bodyId}`);
          db.defaults = {
            ...(db.defaults || {}),
            packKey: root.querySelector(".pack").value.trim(),
            rollTable: root.querySelector(".table").value.trim(),
            fixerDiscounts: {
              t1: Number(root.querySelector(".d1").value | 0),
              t2: Number(root.querySelector(".d2").value | 0),
              t3: Number(root.querySelector(".d3").value | 0),
            },
            autoFixerLock:normalizeAutoFixerLock({
              enabled:root.querySelector(".auto-fixer-lock").checked,
              threshold:root.querySelector(".auto-fixer-threshold").value
            })
          };
          db.era2045 = !!root.querySelector(".era").checked;
          syncAllAutoFixerLocks(db);
          await saveAll(db);
        },
      },
      close: { label: "Close" },
    },
    render: (html) => {
      document.head.appendChild(style);
      dlg._style = style;

      const app = html[0].closest(".app");
      app.classList.add(`dialog-host-${bodyId}`);

      forceFooterButtons(app, db.era2045 ? "#E64539" : "#00FFF7");

      autosizeDialog(app, bodyId);
      requestAnimationFrame(() => autosizeDialog(app, bodyId));
      dlg._mo = observeResize(app, bodyId);
      const root = html[0].querySelector(`#${bodyId}`);
      root.querySelector("[data-test-pack-default]")?.addEventListener("click", ()=>{
        const packs = resolveDynamicItemPacks(root.querySelector(".pack").value);
        if (!packs.length) return ui.notifications.warn("No Item compendium matched those pack references.");
        ui.notifications.info(`Matched ${packs.length} Item compendium${packs.length===1?'':'s'}: ${packs.map(pack=>pack.title || pack.collection).join(', ')}`);
      });
      root.querySelector("[data-test-table-default]")?.addEventListener("click", async ()=>{
        const tables = await findDynamicRollTables(root.querySelector(".table").value);
        if (!tables.length) return ui.notifications.warn("No RollTable matched those references.");
        const table = tables[dynamicRandomInt(0, tables.length-1)];
        const roll = await rollDynamicTable(table);
        if (roll?.results?.length && typeof table.toMessage === "function") await table.toMessage(roll.results, {roll:roll.roll});
        ui.notifications.info(`Matched ${tables.length} RollTable${tables.length===1?'':'s'}.`);
      });
    },
    close: (appEl) => {
      cleanupDialogVisuals(dlg._style, dlg._mo);
    },
  }, { resizable: true });

  dlg.render(true);
}

// -------------------- helpers for buyback --------------------
function getItemMarketValue(doc){
  const sys = doc.system || {};
  if (sys.price?.market != null) return Math.max(0, Number(sys.price.market|0));
  if (sys.price != null) return Math.max(0, Number(sys.price|0));
  return 0;
}
function getItemKind(doc){
  const t  = String(doc.type||"").toLowerCase();
  const n  = String(doc.name||"").toLowerCase();
  const cat = String(doc.system?.category||doc.system?.type||"").toLowerCase();
  const hay = `${t} ${cat} ${n}`;
  if (hay.includes("ammo")) return "Ammo";
  if (hay.includes("armor")) return "Armor";
  if (hay.includes("clothing") || hay.includes("clothes") || hay.includes("apparel")) return "Clothing";
  if (hay.includes("cyberdeck")) return "Cyberdeck";
  if (hay.includes("cyberware") || hay.includes("cyber")) return "Cyberware";
  if (hay.includes("drug") || hay.includes("chem") || hay.includes("narc")) return "Drug";
  if (hay.includes("upgrade") || hay.includes("mod")) return "Upgrade";
  if (hay.includes("vehicle") || hay.includes("car") || hay.includes("bike")) return "Vehicle";
  if (hay.includes("weapon") || hay.includes("gun") || hay.includes("melee")) return "Weapon";
  return "Gear";
}

// -------------------- Tile binding --------------------
const TILE_FLAG = "binding";
function getTileDocument(tileLike){
  if (!tileLike) return null;
  if (tileLike.documentName === "Tile") return tileLike;
  if (tileLike.document?.documentName === "Tile") return tileLike.document;
  if (tileLike.object?.documentName === "Tile") return tileLike.object.document;
  return null;
}
function selectedTileDocuments(){
  return (canvas?.tiles?.controlled || []).map(getTileDocument).filter(Boolean);
}
function getTileBinding(tileLike){
  const tile = getTileDocument(tileLike);
  if (!tile) return null;
  return tile.getFlag?.(MODULE_ID, TILE_FLAG) || tile.flags?.[MODULE_ID]?.[TILE_FLAG] || null;
}
function bodegaIdFromTile(tileLike){
  return getTileBinding(tileLike)?.shopId || null;
}
async function resolveTileDocument(value){
  if (!value) return null;
  const direct = getTileDocument(value);
  if (direct) return direct;
  const possibleUuid = typeof value === "string" ? value : value.uuid;
  if (possibleUuid) {
    try { const doc = await fromUuid(possibleUuid); if (doc?.documentName === "Tile") return doc; } catch {}
  }
  const possibleId = typeof value === "string" ? value : (value.id ?? value._id);
  if (possibleId) {
    const local = canvas?.scene?.tiles?.get(possibleId);
    if (local?.documentName === "Tile") return local;
  }
  return null;
}
async function findTriggerTile(input){
  const queue = Array.isArray(input) ? [...input] : [input];
  const seen = new Set();
  const nestedKeys = ["tile","tileDocument","triggeringTile","sourceTile","document","entity","object","origin","context","action","value","args"];
  while (queue.length){
    const candidate = queue.shift();
    if (!candidate) continue;
    if (typeof candidate === "object") {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
    }
    const tile = await resolveTileDocument(candidate);
    if (tile) return tile;
    if (typeof candidate === "object") {
      for (const key of nestedKeys) {
        const value = candidate[key];
        if (value == null) continue;
        if (Array.isArray(value)) queue.push(...value); else queue.push(value);
      }
    }
  }
  return selectedTileDocuments()[0] || null;
}
async function bindShopToTiles(shopOrId, tileDocs=null){
  if (!game.user?.isGM) return ui.notifications.warn("Only the GM can bind Bodega Tiles.");
  const db = await loadAll();
  const shopId = typeof shopOrId === "string" ? shopOrId : shopOrId?.id;
  const shop = db.shops?.[shopId];
  if (!shop) return ui.notifications.warn(`Bodega not found: ${shopId}`);
  const tiles = (tileDocs || selectedTileDocuments()).map(getTileDocument).filter(Boolean);
  if (!tiles.length) return ui.notifications.warn("Select one or more Tiles with Foundry's Tile Controls first.");
  shop.tileUuids ||= [];
  for (const tile of tiles){
    const old = getTileBinding(tile);
    if (old?.shopId && old.shopId !== shop.id) {
      const oldShop = db.shops?.[old.shopId];
      if (oldShop?.tileUuids) oldShop.tileUuids = oldShop.tileUuids.filter(uuid => uuid !== tile.uuid);
    }
    const binding = {shopId:shop.id, shopName:shop.name, sceneId:tile.parent?.id || canvas?.scene?.id || null, boundAt:Date.now(), version:1};
    await tile.setFlag(MODULE_ID, TILE_FLAG, binding);
    if (!shop.tileUuids.includes(tile.uuid)) shop.tileUuids.push(tile.uuid);
  }
  if (shop.sceneOnly && tiles[0]?.parent) {
    shop.sceneId = tiles[0].parent.id;
    shop.sceneName = tiles[0].parent.name || shop.sceneName || "";
  }
  await saveAll(db);
  if (typeof shopOrId === "object" && shopOrId) Object.assign(shopOrId, duplicate(shop));
  ui.notifications.info(`Bound ${tiles.length} Tile${tiles.length === 1 ? "" : "s"} to ${shop.name}.`);
  return tiles.length;
}
async function unbindSelectedTiles(shopOrId){
  if (!game.user?.isGM) return ui.notifications.warn("Only the GM can unbind Bodega Tiles.");
  const db = await loadAll();
  const shopId = typeof shopOrId === "string" ? shopOrId : shopOrId?.id;
  const shop = db.shops?.[shopId];
  if (!shop) return ui.notifications.warn(`Bodega not found: ${shopId}`);
  const tiles = selectedTileDocuments();
  if (!tiles.length) return ui.notifications.warn("Select one or more Tiles with Foundry's Tile Controls first.");
  let count = 0;
  for (const tile of tiles){
    if (getTileBinding(tile)?.shopId !== shop.id) continue;
    await tile.unsetFlag(MODULE_ID, TILE_FLAG);
    shop.tileUuids = (shop.tileUuids || []).filter(uuid => uuid !== tile.uuid);
    count++;
  }
  await saveAll(db);
  if (typeof shopOrId === "object" && shopOrId) Object.assign(shopOrId, duplicate(shop));
  ui.notifications.info(`Removed ${count} Bodega Tile binding${count === 1 ? "" : "s"}.`);
  return count;
}
async function unbindAllShopTiles(shopOrId){
  if (!game.user?.isGM) return 0;
  const db = await loadAll();
  const shopId = typeof shopOrId === "string" ? shopOrId : shopOrId?.id;
  const shop = db.shops?.[shopId] || (typeof shopOrId === "object" ? shopOrId : null);
  if (!shop) return 0;
  let count = 0;
  for (const uuid of [...(shop.tileUuids || [])]){
    const tile = await resolveTileDocument(uuid);
    if (tile && getTileBinding(tile)?.shopId === shop.id) { await tile.unsetFlag(MODULE_ID, TILE_FLAG); count++; }
  }
  if (db.shops?.[shop.id]) { db.shops[shop.id].tileUuids = []; await saveAll(db); }
  shop.tileUuids = [];
  return count;
}
async function refreshShopTileBindings(shop, oldId=null){
  for (const uuid of shop?.tileUuids || []){
    const tile = await resolveTileDocument(uuid);
    const binding = getTileBinding(tile);
    if (!tile || (oldId && binding?.shopId !== oldId && binding?.shopId !== shop.id)) continue;
    await tile.setFlag(MODULE_ID, TILE_FLAG, {shopId:shop.id, shopName:shop.name, sceneId:tile.parent?.id || null, boundAt:binding?.boundAt || Date.now(), version:1});
  }
}
async function openBoundTile(input=null){
  const tile = await findTriggerTile(input);
  if (!tile) return ui.notifications.warn("Bodega could not identify the triggering Tile.");
  const shopId = bodegaIdFromTile(tile);
  if (!shopId) return ui.notifications.warn("This Tile is not bound to a Bodega.");
  return openShop(shopId);
}
async function createTileHelperMacro(){
  if (!game.user?.isGM) return ui.notifications.warn("Only the GM can create the Bodega Tile helper macro.");
  const name = "Bodega™ — Open Bound Tile";
  const command = `return game.bodega.openBoundTile({\n  args: typeof args === "undefined" ? null : args,\n  tile: typeof tile === "undefined" ? null : tile,\n  token: typeof token === "undefined" ? null : token,\n  actor: typeof actor === "undefined" ? null : actor\n});`;
  let macro = game.macros.getName(name);
  if (macro) {
    await macro.update({type:"script", command, img:"modules/bodega/assets/bodega.webp"});
    ui.notifications.info("Updated the Bodega Tile helper macro.");
  } else {
    macro = await Macro.create({name, type:"script", command, img:"modules/bodega/assets/bodega.webp"});
    ui.notifications.info("Created the Bodega Tile helper macro.");
  }
  macro?.sheet?.render(true);
  return macro;
}

// -------------------- Admin UI --------------------
async function openAdmin() {
  const bodyId = makeUiId("manager");
  const db = await loadAll();
  const accent = db.era2045 ? "#E64539" : "#00FFF7";
  const style = document.createElement("style"); style.textContent = makeAdminCSS(accent, bodyId);

  function renderList() {
    const rows = Object.values(db.shops).sort((a,b)=>a.name.localeCompare(b.name)).map(v=>{
      const sc = v.sceneOnly ? (v.sceneName || v.sceneId || "(scene)") : "Any Scene";
      const bound = Array.isArray(v.tileUuids) ? v.tileUuids.length : 0;
      const dyn = normalizeDynamicSettings(v.dynamic);
      const managed = (v.items || []).filter(item => item.dynamicManaged).length;
      const dynBadge = dyn.enabled ? `<span class="stock-badge dynamic">Dynamic · ${managed}</span>` : `<span class="stock-badge">Static</span>`;
      return `<div class="card manager-card" data-id="${v.id}">
        <div class="manager-card-head">
          <div class="manager-summary"><b>${esc(v.name)}</b> ${dynBadge} <span class="muted">#${esc(v.id)}</span><br><span class="muted">${esc(sc)} · ${bound ? `${bound} Tile${bound===1?"":"s"} bound` : "No Tile binding"}</span><br><span class="muted">${esc(dynamicStatusSummary(v))}</span></div>
          <div class="manager-actions">
            <button class="btn" data-bind="${esc(v.id)}"><i class="fas fa-link"></i> Bind Selected</button>
            <button class="btn" data-unbind="${esc(v.id)}"><i class="fas fa-unlink"></i> Unbind Selected</button>
            <button class="btn" data-edit="${esc(v.id)}"><i class="fas fa-edit"></i> Edit</button>
            <button class="btn" data-del="${esc(v.id)}"><i class="fas fa-trash"></i> Delete</button>
          </div>
        </div>
        <div class="tile-script"><span class="muted">Tile script:</span> <code>game.bodega.openShop("${esc(v.id)}")</code></div>
      </div>`;
    }).join("") || `<div class="muted">No Bodegas yet. Click <b>New Bodega</b> to create one.</div>`;
    return rows;
  }

  const content = `
  <div id="${bodyId}">
    <div class="wrap">
      <div class="title">Bodega™ Manager</div>
      <div class="manager-toolbar">
        <button class="btn" data-new><i class="fas fa-plus-circle"></i> New Bodega</button>
        <button class="btn" data-opts><i class="fas fa-sliders-h"></i> Options</button>
        <button class="btn" data-helper><i class="fas fa-code"></i> Create / Update Tile Helper</button>
        <button class="btn" data-process-dynamic><i class="fas fa-people-carry"></i> Process Due Inventory</button>
      </div>
      <div class="list" data-list>${renderList()}</div>
      <div class="muted" style="margin-top:6px">
        Bound Tile helper: use <b>Bodega™ — Open Bound Tile</b> in Monk's Active Tile Triggers. Direct per-shop scripts are shown on every entry above.
      </div>
    </div>
  </div>`;

  const dlg = new Dialog({
    title: "Bodega™ Manager",
    content,
    buttons: { close: { label: "Close" } },
    render: (html)=>{
      document.head.appendChild(style);
      const app = html[0].closest(".app");
      app.classList.add(`dialog-host-${bodyId}`);
      app.dataset.bodegaMinW = "760";
      app.dataset.bodegaCapW = "980";
      forceFooterButtons(app, accent);
      autosizeDialog(app, bodyId);
      requestAnimationFrame(()=> autosizeDialog(app, bodyId));
      dlg._mo = observeResize(app, bodyId);

      const root = html[0].querySelector(`#${bodyId}`);
      const $list = root.querySelector("[data-list]");

      const refresh = ()=>{ $list.innerHTML = renderList(); autosizeDialog(app, bodyId); };

      root.querySelector("[data-new]").addEventListener("click", ()=> editShop());
      root.querySelector("[data-opts]").addEventListener("click", ()=> openOptions());
      root.querySelector("[data-helper]").addEventListener("click", ()=> createTileHelperMacro());
      root.querySelector("[data-process-dynamic]").addEventListener("click", async ()=> {
        if (!getSimpleCalendar()) return ui.notifications.warn("Simple Calendar is not available. Dynamic inventory can still be tested manually in each Bodega editor.");
        await processDynamicInventory();
        Object.assign(db, await loadAll());
        refresh();
        ui.notifications.info("Bodega dynamic inventory processed.");
      });

      $list.addEventListener("click", async (ev)=>{
        const idBind = ev.target.closest("[data-bind]")?.getAttribute("data-bind");
        const idUnbind = ev.target.closest("[data-unbind]")?.getAttribute("data-unbind");
        const idEdit = ev.target.closest("[data-edit]")?.getAttribute("data-edit");
        const idDel  = ev.target.closest("[data-del]")?.getAttribute("data-del");
        if (idBind) { await bindShopToTiles(idBind); Object.assign(db, await loadAll()); refresh(); return; }
        if (idUnbind) { await unbindSelectedTiles(idUnbind); Object.assign(db, await loadAll()); refresh(); return; }
        if (idEdit) return editShop(db.shops[idEdit]);
        if (idDel) {
          const ok = await Dialog.confirm({
            title:"Delete Bodega",
            content:`<p>Delete <b>${esc(db.shops[idDel]?.name ?? idDel)}</b>?</p>`,
            yes: ()=> true, no: ()=> false, defaultYes: false
          });
          if (!ok) return;
          await unbindAllShopTiles(idDel);
          const freshDb = await loadAll();
          Object.assign(db, freshDb);
          delete db.shops[idDel];
          await saveAll(db);
          ui.notifications.info("Bodega deleted.");
          refresh();
        }
      });

      async function editShop(v=null){
        const data = v ? duplicate(v) : {
          id: randomID(), name: "New Bodega", sceneOnly: true,
          sceneId, sceneName: canvas?.scene?.name ?? "",
          packKey: db.defaults?.packKey ?? "",
          rollTable: db.defaults?.rollTable ?? "",
          faces:[],
          items:[],
          tileUuids:[],
          dynamic:defaultDynamicSettings(),
          purse: 0,
          buyback: {
            Ammo:{on:false,pct:50}, Armor:{on:false,pct:50}, Clothing:{on:false,pct:50},
            Cyberdeck:{on:false,pct:40}, Cyberware:{on:false,pct:40}, Drug:{on:false,pct:30},
            Gear:{on:false,pct:50},   Upgrade:{on:false,pct:50}, Vehicle:{on:false,pct:30}, Weapon:{on:false,pct:50}
          }
        };

        db.shops[data.id] = data; await saveAll(db); // ensure exists immediately
        refresh();

        const content = `
        <div id="${bodyId}">
          <div class="wrap">
            <div class="row">
              <label style="flex:1">Name<br><input type="text" class="v-name" value="${esc(data.name)}"></label>
              <label style="width:240px">ID (for triggers)<br><input type="text" class="v-id" value="${esc(data.id)}"></label>
            </div>
            <div class="row">
              <label class="row" style="gap:6px">
                <input type="checkbox" class="v-scene" ${data.sceneOnly?"checked":""}> Only on <b>${esc(canvas?.scene?.name ?? "this scene")}</b>
              </label>
            </div>
            <div class="row" style="flex-direction:column; align-items:stretch">
              <label>Compendium Pack Key(s) (override)<br><input type="text" class="v-pack" value="${esc(data.packKey||"")}" placeholder="package.pack — comma or new line separates multiple"></label>
              <label>Roll Table(s) (UUID/name/pack::name, override)<br>
                <div class="row" style="gap:6px; width:100%">
                  <input style="flex:1" type="text" class="v-table" value="${esc(data.rollTable||"")}" placeholder="Comma or new line separates multiple RollTables">
                  <button class="btn" data-testr>Test Roll</button>
                  <button class="btn" data-preview>Preview</button>
                </div>
              </label>
            </div>

            <!-- Tile Binding -->
            <fieldset style="border:1px solid var(--accent);border-radius:6px;padding:8px;">
              <legend style="padding:0 6px">Monk's Active Tile Binding</legend>
              <div class="row" style="margin-bottom:6px">
                <button type="button" class="btn" data-bind-tile><i class="fas fa-link"></i> Bind Selected Tile(s)</button>
                <button type="button" class="btn" data-unbind-tile><i class="fas fa-unlink"></i> Unbind Selected Tile(s)</button>
                <button type="button" class="btn" data-helper-tile><i class="fas fa-code"></i> Create / Update Helper</button>
              </div>
              <div class="muted" data-tile-status>Bound Tiles: ${(data.tileUuids||[]).length}</div>
              <div class="tile-script">Tile script: <code>game.bodega.openShop("${esc(data.id)}")</code></div>
              <div class="muted" style="margin-top:5px">For a bound Tile, the helper macro needs no Bodega ID argument; the Tile flag resolves it automatically.</div>
            </fieldset>

            <!-- Faces -->
            <fieldset style="border:1px solid var(--accent);border-radius:8px;padding:8px;">
              <legend style="padding:0 6px">Faces (NPC Token/Actor Avatars)</legend>
              <div class="faces" data-faces>
                ${ (data.faces||[]).map((F,i)=>{ const src = typeof F==="string"?F:(F?.img||""); const nm=(typeof F==="object" && F?.name)?` title="${esc(F.name)}"`:""; return `<span class="face-chip" data-i="${i}"><img class="face" src="${esc(src)}"${nm}><span class="x" title="Remove">✕</span></span>`; }).join("") || `<span class="muted">Drag a Token or Actor here…</span>`}
              </div>
              <div class="drop" data-drop-face>Drop Token/Actor here</div>
            </fieldset>

            <!-- Buyback & Purse -->
            <fieldset style="border:1px solid var(--accent);border-radius:8px;padding:8px;">
              <legend style="padding:0 6px">Buyback / Vendor Cash</legend>

              <div class="row" style="gap:12px;margin-bottom:6px">
                <label title="eb available to purchase items from players">
                  Vendor Purse (eb)
                  <input type="number" class="v-purse" data-shop="${esc(data.id)}" min="0" step="1" value="${data.purse|0}" style="width:120px">
                </label>
              </div>

              <div class="bb-grid">
                ${["Ammo","Armor","Clothing","Cyberdeck","Cyberware","Drug","Gear","Upgrade","Vehicle"].map(K=>`
                  <label class="row" style="gap:6px;align-items:center">
                    <input type="checkbox" class="bb-on" data-kind="${K}" ${data.buyback?.[K]?.on?'checked':''}>
                    ${K}
                    <input type="number" class="bb-pct" data-kind="${K}" min="0" max="100" step="1" value="${Number(data.buyback?.[K]?.pct||0)|0}" style="width:72px"> %
                  </label>
                `).join("")}
              </div>
              <div class="row" style="margin-top:10px">
                ${(()=>{ const K="Weapon"; return `
                  <label class="row" style="gap:6px;align-items:center">
                    <input type="checkbox" class="bb-on" data-kind="${K}" ${data.buyback?.[K]?.on?'checked':''}>
                    ${K}
                    <input type="number" class="bb-pct" data-kind="${K}" min="0" max="100" step="1" value="${Number(data.buyback?.[K]?.pct||0)|0}" style="width:72px"> %
                  </label>`;})()}
              </div>
            </fieldset>

            <!-- Ledger -->
            <fieldset style="border:1px solid var(--accent);border-radius:8px;padding:8px;">
              <legend style="padding:0 6px">Ledger (Container/NPC)</legend>
              <div class="row" data-ledger-row>
                ${ data.ledgerUuid 
                  ? `<span class="face-chip" data-ledger-chip><span class="muted">Linked:</span> <b>${esc((await fromUuid(data.ledgerUuid))?.name || data.ledgerUuid)}</b> <span class="x" title="Clear">✕</span></span>`
                  : `<span class="muted">Drop a Container here to use its Wealth as the vendor purse.</span>`}
              </div>
              <div class="drop" data-drop-ledger>Drop Container/NPC here</div>
            </fieldset>

            <!-- Dynamic Inventory -->
            <fieldset style="border:1px solid var(--accent);border-radius:8px;padding:8px;">
              <legend style="padding:0 6px">Dynamic Inventory / Background Customers</legend>
              <label class="row"><input type="checkbox" class="dyn-enabled" ${normalizeDynamicSettings(data.dynamic).enabled?'checked':''}> <b>Enable Dynamic Inventory</b></label>
              <div class="muted" style="margin:4px 0 8px">Static/manual stock and player trade-ins are protected. Only <b>Dynamic</b> rows are consumed or restocked by Simple Calendar.</div>
              <div class="row">
                <label>Stock Source<br><select class="dyn-source" title="Choose how Dynamic inventory is generated">
                  <option value="table" ${normalizeDynamicSettings(data.dynamic).stockSource==='table'?'selected':''}>RollTable</option>
                  <option value="pack" ${normalizeDynamicSettings(data.dynamic).stockSource==='pack'?'selected':''}>Compendium Pack</option>
                  <option value="pool" ${normalizeDynamicSettings(data.dynamic).stockSource==='pool'?'selected':''}>Curated List</option>
                </select></label>
                <label style="flex:1">RollTable(s)<br><input type="text" class="dyn-table" value="${esc(normalizeDynamicSettings(data.dynamic).stockTable || data.rollTable || db.defaults.rollTable || '')}" placeholder="UUID / name / pack::name — comma or new line separates multiple"></label>
              </div>
              <label>Compendium Pack Key(s)<br><input type="text" class="dyn-pack" value="${esc(normalizeDynamicSettings(data.dynamic).stockPack || data.packKey || db.defaults.packKey || '')}" placeholder="package.pack — comma or new line separates multiple"></label>
              <div class="row" style="margin-top:6px">
                <label>Products Min<br><input type="number" class="dyn-min-items" min="1" max="50" value="${normalizeDynamicSettings(data.dynamic).minItems}"></label>
                <label>Products Max<br><input type="number" class="dyn-max-items" min="1" max="50" value="${normalizeDynamicSettings(data.dynamic).maxItems}"></label>
                <label>Qty Min<br><input type="number" class="dyn-qty-min" min="0" max="999" value="${normalizeDynamicSettings(data.dynamic).qtyMin}"></label>
                <label>Qty Max<br><input type="number" class="dyn-qty-max" min="0" max="999" value="${normalizeDynamicSettings(data.dynamic).qtyMax}"></label>
              </div>
              <div class="row" style="margin-top:6px">
                <label class="row"><input type="checkbox" class="dyn-traffic" ${normalizeDynamicSettings(data.dynamic).npcTraffic?'checked':''}> NPC customer traffic</label>
                <label>Cycles / day Min<br><input type="number" class="dyn-traffic-min" min="0" max="12" value="${normalizeDynamicSettings(data.dynamic).trafficMin}"></label>
                <label>Cycles / day Max<br><input type="number" class="dyn-traffic-max" min="0" max="12" value="${normalizeDynamicSettings(data.dynamic).trafficMax}"></label>
              </div>
              <div class="row" style="margin-top:6px">
                <label class="row"><input type="checkbox" class="dyn-restock" ${normalizeDynamicSettings(data.dynamic).restockEnabled?'checked':''}> Daily restock</label>
                <label>Hour<br><input type="number" class="dyn-restock-hour" min="0" max="23" value="${normalizeDynamicSettings(data.dynamic).restockHour}"></label>
                <label>Minute<br><input type="number" class="dyn-restock-minute" min="0" max="59" value="${normalizeDynamicSettings(data.dynamic).restockMinute}"></label>
                <label>Behavior<br><select class="dyn-restock-mode" title="Choose what the daily delivery does"><option value="rotate" ${normalizeDynamicSettings(data.dynamic).restockMode==='rotate'?'selected':''}>Rotate & Refill</option><option value="refill" ${normalizeDynamicSettings(data.dynamic).restockMode==='refill'?'selected':''}>Refill Shelves</option></select></label>
              </div>
              <div class="dyn-pool-tools" data-dyn-pool-tools ${normalizeDynamicSettings(data.dynamic).stockSource==='pool'?'':'hidden'}>
                <label style="display:block;margin-top:8px">Curated Item Search</label>
                <div class="row" style="margin-top:4px"><div class="dyn-search-wrap"><input type="text" class="dyn-pool-search" autocomplete="off" placeholder="Search an Item to add to the curated Dynamic list…"><div class="dyn-search-results" data-dyn-search-results hidden></div></div><button type="button" class="btn" data-dyn-pool-add>Add</button></div>
                <div class="drop" data-dyn-pool-drop>Drag Item documents here for the curated Dynamic stock list</div>
                <div class="faces" data-dyn-pool>${renderDynamicPool(normalizeDynamicSettings(data.dynamic).stockPool)}</div>
              </div>
              <div class="row" style="margin-top:8px">
                <button type="button" class="btn" data-dyn-test><i class="fas fa-vial"></i> Test Source</button>
                <button type="button" class="btn" data-dyn-generate><i class="fas fa-box-open"></i> Generate Stock</button>
                <button type="button" class="btn" data-dyn-traffic-now><i class="fas fa-people-arrows"></i> Run Customer Cycle</button>
                <button type="button" class="btn" data-dyn-restock-now><i class="fas fa-truck-loading"></i> Restock Now</button>
              </div>
              <div class="muted" data-dyn-status style="margin-top:6px">${esc(dynamicStatusSummary(data))}</div>
            </fieldset>

            <!-- Items -->
            <div class="row" style="margin-top:8px">
              <input type="text" class="v-quick" list="bodega-suggest" placeholder="Search items (world + all packs)…">
              <datalist id="bodega-suggest"></datalist>
              <button class="btn" data-qadd>Add</button>
            </div>
            <div class="drop" data-drop>Drag items here to add</div>
            <div class="list" data-items>${renderItems()}</div>
          </div>
        </div>`;

        function renderItems(){
          if (!data.items.length) return `<div class="muted">No items yet.</div>`;
          return data.items.map((it, i)=>`
            <div class="card" data-i="${i}">
              <div class="item-row">
                <div class="item-left">
                  <img class="thumb" src="${it.img || 'icons/svg/box.svg'}">
                  <div>
                    <div class="name" title="${esc(it.name)}">${esc(it.name)}${it.tradeIn || it.stockClass==='tradein' ? '<span class="stock-badge tradein">Trade-In</span>' : (it.dynamicManaged ? '<span class="stock-badge dynamic">Dynamic</span>' : '<span class="stock-badge">Static</span>')}</div>
                    <div class="muted">Price <span class="price-eb"><b>${it.price|0}</b> <span class="eb">eb</span></span></div>
                  </div>
                </div>
                <div class="row item-controls" style="align-items:center">
                  <label>Qty
                    <input type="number" class="qty" min="0" step="1" value="${(it.infinite?0:(it.qty??1))|0}" style="width:72px" ${it.infinite?'disabled':''}>
                  </label>
                  <label class="row" style="gap:4px" title="Infinite stock">
                    <input type="checkbox" class="inf" ${it.infinite?'checked':''}> ∞
                  </label>
                  <label>Price
                    <input type="number" class="price" min="0" max="999999" step="1" value="${it.price|0}" style="width:100px">
                  </label>
                  <label class="row fx-only" style="gap:6px" title="Visible to Fixers only">
                    <input type="checkbox" class="fixeronly" ${it.fixerOnly?'checked':''}>
                    <span class="muted">Fixer-only</span>
                  </label>
                  <label class="row fx-min" style="gap:6px" title="Minimum Operator Rank required (blank = any Fixer)">
                    <span class="muted">Min&nbsp;Rank</span>
                    <input type="number" class="fixermin" min="1" max="10" step="1" value="${it.fixerMinRank ?? ""}" style="width:64px">
                  </label>
                  <button class="btn del" data-rem="${i}" title="Delete" style="margin-left:auto"><i class="fas fa-trash"></i></button>
                </div>
              </div>
            </div>
          `).join("");
        }

        const edDlg = new Dialog({
          title: `Edit Bodega — ${data.name}`,
          content,
          buttons: {
            save: { label:"Save", callback: async (html)=>{
              const rootEd = html[0].querySelector(`#${bodyId}`);
              data.name      = rootEd.querySelector(".v-name").value.trim() || data.name;
              const newId    = rootEd.querySelector(".v-id").value.trim()   || data.id;
              data.sceneOnly = rootEd.querySelector(".v-scene").checked;
              if (data.sceneOnly) { data.sceneId = sceneId; data.sceneName = canvas?.scene?.name ?? ""; }
              data.packKey   = rootEd.querySelector(".v-pack").value.trim();
              data.rollTable = rootEd.querySelector(".v-table").value.trim();
              readDynamicEditorForm(rootEd, data);
              if (data.dynamic.enabled && !data.dynamic.initializedAt && getSimpleCalendar()){
                await initializeDynamicShop(data, db.defaults, calendarTimestamp(), {markPastTraffic:true});
              }

              const oldId = data.id;
              if (newId !== data.id) { delete db.shops[data.id]; data.id = newId; }
              db.shops[data.id] = data; await saveAll(db);
              if (newId !== oldId) await refreshShopTileBindings(data, oldId);
              refresh();
            }},
            close: { label:"Close" }
          },
          render: (html)=>{
            const style2 = document.createElement("style"); style2.textContent = makeAdminCSS(accent, bodyId);
            document.head.appendChild(style2); edDlg._style = style2;

            const app2 = html[0].closest('.app');
            app2.classList.add(`dialog-host-${bodyId}`);
            forceFooterButtons(app2, accent);

            const rootEd = html[0].querySelector(`#${bodyId}`);
            const $items    = rootEd.querySelector("[data-items]");
            const $drop     = rootEd.querySelector("[data-drop]");
            const $dropFace = rootEd.querySelector("[data-drop-face]");
            const $faces    = rootEd.querySelector("[data-faces]");
            const $datalist = rootEd.querySelector("#bodega-suggest");
            const $quick    = rootEd.querySelector(".v-quick");
            const $packIn   = rootEd.querySelector(".v-pack");
            const $tableIn  = rootEd.querySelector(".v-table");
            const $dropLedger = rootEd.querySelector("[data-drop-ledger]");
            const $ledgerRow  = rootEd.querySelector("[data-ledger-row]");
            const $dynPool = rootEd.querySelector("[data-dyn-pool]");
            const $dynDrop = rootEd.querySelector("[data-dyn-pool-drop]");
            const $dynSearch = rootEd.querySelector(".dyn-pool-search");
            const $dynSearchResults = rootEd.querySelector("[data-dyn-search-results]");
            const $dynPoolTools = rootEd.querySelector("[data-dyn-pool-tools]");
            const $dynStatus = rootEd.querySelector("[data-dyn-status]");
            const dynSearchIndex = [];

            rootEd.addEventListener("keydown",(e)=>{ if (e.key==="Enter"){ e.preventDefault(); e.stopPropagation(); }}, true);

            async function buildSuggestions(){
              const seen = new Set(); const options = []; const seenUuid = new Set();
              for (const it of game.items){
                const n=it.name?.trim(); if(!n) continue;
                const k=n.toLowerCase(); if(!seen.has(k)){ seen.add(k); options.push(n); }
                if (it.uuid && !seenUuid.has(it.uuid)){ seenUuid.add(it.uuid); dynSearchIndex.push({uuid:it.uuid,name:n,img:it.img||"icons/svg/item-bag.svg",source:"World"}); }
              }
              for (const p of game.packs.filter(p=>p.documentName==="Item")){
                try{
                  const idx=await p.getIndex({fields:["name","img"]});
                  for (const e of idx){
                    const n=e.name?.trim(); if(!n) continue;
                    const k=n.toLowerCase(); if(!seen.has(k)){ seen.add(k); options.push(n); }
                    const uuid=`Compendium.${p.collection}.Item.${e._id}`;
                    if (!seenUuid.has(uuid)){ seenUuid.add(uuid); dynSearchIndex.push({uuid,name:n,img:e.img||"icons/svg/item-bag.svg",source:p.title||p.collection}); }
                  }
                }catch{}
              }
              $datalist.innerHTML = options.sort((a,b)=>a.localeCompare(b)).map(n=>`<option value="${esc(n)}"></option>`).join("");
              dynSearchIndex.sort((a,b)=>a.name.localeCompare(b.name));
              if ($dynSearch?.value.trim()) renderDynamicSearchResults();
            }
            buildSuggestions();

            function hideDynamicSearchResults(){ if ($dynSearchResults){ $dynSearchResults.hidden = true; $dynSearchResults.innerHTML = ""; } }
            function renderDynamicSearchResults(){
              if (!$dynSearchResults || !$dynSearch) return;
              const query = $dynSearch.value.trim().toLowerCase();
              if (!query){ hideDynamicSearchResults(); return; }
              const hits = dynSearchIndex
                .filter(entry => entry.name.toLowerCase().includes(query))
                .sort((a,b)=>{
                  const aa=a.name.toLowerCase().startsWith(query)?0:1, bb=b.name.toLowerCase().startsWith(query)?0:1;
                  return aa-bb || a.name.localeCompare(b.name);
                })
                .slice(0,80);
              if (!hits.length){ $dynSearchResults.innerHTML = '<div class="muted" style="padding:6px">No matching Items.</div>'; $dynSearchResults.hidden = false; return; }
              $dynSearchResults.innerHTML = hits.map(entry => `<button type="button" class="dyn-search-hit" data-dyn-search-uuid="${esc(entry.uuid)}"><img src="${esc(entry.img)}"><span>${esc(entry.name)}</span><span class="src">${esc(entry.source)}</span></button>`).join("");
              $dynSearchResults.hidden = false;
            }
            $dynSearch?.addEventListener("input", renderDynamicSearchResults);
            $dynSearch?.addEventListener("focus", renderDynamicSearchResults);

            // Ledger drag/drop and clear
            async function onDropLedger(e){
              e.preventDefault(); e.currentTarget.classList.remove("drag");
              const raw = e.dataTransfer.getData("text/plain"); if (!raw) return;
              let d; try{ d=JSON.parse(raw); }catch{}
              if (!d || (d.type!=="Actor" && d.type!=="Token")) return ui.notifications.warn("Drop a Container/NPC Actor.");
              let a=null;
              if (d.type==="Token"){ const tok = await fromUuid(d.uuid || `Scene.${sceneId}.Token.${d.id}`); a = tok?.actor; }
              else { a = await fromUuid(d.uuid || `Actor.${d.id}`); }
              if (!a) return ui.notifications.warn("Could not resolve that Actor.");

              data.ledgerUuid = a.uuid;
              await commit();
              $ledgerRow.innerHTML = `<span class="face-chip" data-ledger-chip><span class="muted">Linked:</span> <b>${esc(a.name)}</b> <span class="x" title="Clear">✕</span></span>`;
              autosizeDialog(app2, bodyId);
            }
            function dragOver2(e){ e.preventDefault(); e.currentTarget.classList.add("drag"); }
            function dragLeave2(e){ e.preventDefault(); e.currentTarget.classList.remove("drag"); }
            $dropLedger?.addEventListener("dragover", dragOver2);
            $dropLedger?.addEventListener("dragleave", dragLeave2);
            $dropLedger?.addEventListener("drop", onDropLedger);
            $ledgerRow?.addEventListener("click", async (ev)=>{
              if (!ev.target.closest(".x")) return;
              data.ledgerUuid = null;
              await commit();
              $ledgerRow.innerHTML = `<span class="muted">Drop a Container/NPC here to use its Wealth as the vendor purse.</span>`;
            });

            async function commit(){ db.shops[data.id]=data; await saveAll(db); refresh(); }
            function refreshDynamicPool(){ if ($dynPool) $dynPool.innerHTML = renderDynamicPool(normalizeDynamicSettings(data.dynamic).stockPool); }
            function refreshDynamicStatus(){ if ($dynStatus) $dynStatus.textContent = dynamicStatusSummary(data); }
            function syncDynamicSourceUI(){ if ($dynPoolTools) $dynPoolTools.hidden = rootEd.querySelector(".dyn-source")?.value !== "pool"; }
            syncDynamicSourceUI();
            async function persistDynamicForm({initialize=false}={}){
              readDynamicEditorForm(rootEd, data);
              if (initialize && data.dynamic.enabled && !data.dynamic.initializedAt && getSimpleCalendar()){
                await initializeDynamicShop(data, db.defaults, calendarTimestamp(), {markPastTraffic:true});
              }
              await commit();
              refreshDynamicStatus();
              syncDynamicSourceUI();
            }
            for (const selector of [".dyn-enabled",".dyn-source",".dyn-table",".dyn-pack",".dyn-min-items",".dyn-max-items",".dyn-qty-min",".dyn-qty-max",".dyn-traffic",".dyn-traffic-min",".dyn-traffic-max",".dyn-restock",".dyn-restock-hour",".dyn-restock-minute",".dyn-restock-mode"]){
              rootEd.querySelector(selector)?.addEventListener("change", async ()=> persistDynamicForm({initialize:true}));
            }

            rootEd.querySelector(".v-purse")?.addEventListener("input", async (e)=>{
              data.purse = Math.max(0, Number(e.target.value|0));
              await commit();
            });

            rootEd.addEventListener("change", async (e)=>{
              if (e.target.classList.contains("bb-on")){
                const k = e.target.getAttribute("data-kind");
                data.buyback ||= {};
                data.buyback[k] = data.buyback[k] || {on:false,pct:0};
                data.buyback[k].on = !!e.target.checked;
                await commit();
              }
            });
            rootEd.addEventListener("input", async (e)=>{
              if (e.target.classList.contains("bb-pct")){
                const k = e.target.getAttribute("data-kind");
                data.buyback ||= {};
                data.buyback[k] = data.buyback[k] || {on:false,pct:0};
                data.buyback[k].pct = Math.max(0, Math.min(120, Number(e.target.value|0)));
                await commit();
              }
            });

            rootEd.addEventListener("input", async (ev)=>{
              const card = ev.target.closest(".card"); const idx = Number(card?.getAttribute("data-i"));
              if (Number.isNaN(idx) || !data.items[idx]) return;
              const it = data.items[idx];
              if (ev.target.classList.contains("price")){ it.price = Math.max(0, Number(ev.target.value|0)); if (it.autoFixerLocked) syncAutoFixerLock(it, db.defaults, {newItem:false}); await commit(); }
              if (ev.target.classList.contains("qty"))  { it.qty   = Math.max(0, Number(ev.target.value|0)); await commit(); }
              if (ev.target.classList.contains("fixermin")){
                const raw = ev.target.value.trim();
                it.fixerMinRank = raw==="" ? null : Math.max(1, Math.min(10, Number(raw|0)));
                await commit();
              }
            });

            rootEd.addEventListener("change", async (ev)=>{
              if (ev.target.classList.contains("inf")){
                const card = ev.target.closest(".card"); const idx = Number(card?.getAttribute("data-i")); if (Number.isNaN(idx)) return;
                const it = data.items[idx]; it.infinite = ev.target.checked;
                const q = card.querySelector(".qty"); if (q){ q.disabled = it.infinite; if (it.infinite) q.value = 0; }
                await commit();
              }
              if (ev.target.classList.contains("fixeronly")){
                const card = ev.target.closest(".card"); const idx = Number(card?.getAttribute("data-i")); if (Number.isNaN(idx)) return;
                data.items[idx].fixerOnly = !!ev.target.checked;
                data.items[idx].autoFixerLocked = false;
                await commit();
              }
            });

            async function doQuickAdd(){
              const name = $quick.value.trim(); if (!name) return;
              const packKey = $packIn.value.trim() || db.defaults.packKey;
              let doc = null; if (packKey) doc = await findItemByNameFromPacks(packKey, name);
              if (!doc) doc = await findItemAnywhere(name);
              if (!doc) return ui.notifications.warn(`Item not found: ${name}`);
              const price = (doc.system?.price?.market != null) ? Number(doc.system.price.market) : (Number(doc.system?.price) || 0);
              const item = { uuid: doc.uuid, name: doc.name, img: doc.img, price: Math.max(0, price|0), packageSize:marketPackageSizeFromData(doc), marketPackagePrice:Math.max(0, price|0), qty: 1, infinite: false, fixerOnly:false, fixerMinRank:null, autoFixerLocked:false, dynamicManaged:false, tradeIn:false, stockClass:"static" };
              data.items.push(syncAutoFixerLock(item, db.defaults, {newItem:true}));
              if ($items) $items.innerHTML = renderItems();
              $quick.value = "";
              await commit(); autosizeDialog(app2, bodyId);
            }

            rootEd.addEventListener("click", async (ev)=>{
              const dynSearchUuid = ev.target.closest("[data-dyn-search-uuid]")?.getAttribute("data-dyn-search-uuid");
              if (dynSearchUuid){
                const doc = await byUUID(dynSearchUuid);
                if (!doc) return ui.notifications.warn("Could not resolve that Item.");
                data.dynamic = normalizeDynamicSettings(data.dynamic);
                await addDynamicPoolDocument(data.dynamic.stockPool, doc);
                if ($dynSearch) $dynSearch.value = "";
                hideDynamicSearchResults();
                await commit(); refreshDynamicPool(); autosizeDialog(app2, bodyId); return;
              }
              const dynRemove = ev.target.closest("[data-dyn-pool-rem]")?.getAttribute("data-dyn-pool-rem");
              if (dynRemove != null){
                data.dynamic = normalizeDynamicSettings(data.dynamic);
                data.dynamic.stockPool.splice(Number(dynRemove), 1);
                await commit(); refreshDynamicPool(); return;
              }
              if (ev.target.closest("[data-dyn-pool-add]")){
                const name = $dynSearch?.value.trim();
                if (!name) return;
                const packRef = rootEd.querySelector(".dyn-pack")?.value.trim() || data.packKey || db.defaults.packKey || "";
                let doc = null;
                for (const pack of resolveDynamicItemPacks(packRef)){ doc = await findItemByNameFromPack(pack.collection, name); if (doc) break; }
                if (!doc) doc = await findItemAnywhere(name);
                if (!doc) return ui.notifications.warn(`Item not found: ${name}`);
                data.dynamic = normalizeDynamicSettings(data.dynamic);
                await addDynamicPoolDocument(data.dynamic.stockPool, doc);
                if ($dynSearch) $dynSearch.value = "";
                hideDynamicSearchResults();
                await commit(); refreshDynamicPool(); autosizeDialog(app2, bodyId); return;
              }
              if (ev.target.closest("[data-dyn-test]")){
                readDynamicEditorForm(rootEd, data);
                const doc = await chooseDynamicSourceDocument(data, db.defaults);
                if (!doc) return ui.notifications.warn("No Item could be resolved from this dynamic source.");
                return ui.notifications.info(`Dynamic source resolved: ${doc.name}`);
              }
              if (ev.target.closest("[data-dyn-generate]")){
                readDynamicEditorForm(rootEd, data);
                data.dynamic.enabled = true;
                await fillDynamicStock(data, {replace:true, defaults:db.defaults, now:calendarTimestamp()});
                if (getSimpleCalendar() && !data.dynamic.initializedAt) await initializeDynamicShop(data, db.defaults, calendarTimestamp(), {markPastTraffic:true});
                await commit(); if ($items) $items.innerHTML = renderItems(); refreshDynamicStatus(); autosizeDialog(app2, bodyId);
                return ui.notifications.info(`Generated ${(data.items||[]).filter(item=>item.dynamicManaged).length} dynamic products for ${data.name}.`);
              }
              if (ev.target.closest("[data-dyn-traffic-now]")){
                readDynamicEditorForm(rootEd, data);
                const result = await runNpcTraffic(data, 1, calendarTimestamp());
                await commit(); if ($items) $items.innerHTML = renderItems(); refreshDynamicStatus();
                return ui.notifications.info(`NPC customer cycle removed ${result.units} unit${result.units===1?'':'s'} from ${data.name}.`);
              }
              if (ev.target.closest("[data-dyn-restock-now]")){
                readDynamicEditorForm(rootEd, data);
                await restockDynamicShop(data, {defaults:db.defaults, now:calendarTimestamp()});
                if (getSimpleCalendar()) scheduleNextRestock(data, calendarTimestamp());
                await commit(); if ($items) $items.innerHTML = renderItems(); refreshDynamicStatus(); autosizeDialog(app2, bodyId);
                return ui.notifications.info(`${data.name} restocked.`);
              }
              if (ev.target.closest("[data-bind-tile]")) {
                await commit();
                await bindShopToTiles(data);
                const fresh = await loadAll(); Object.assign(db, fresh); Object.assign(data, duplicate(fresh.shops?.[data.id] || data));
                const status = rootEd.querySelector("[data-tile-status]"); if (status) status.textContent = `Bound Tiles: ${(data.tileUuids||[]).length}`;
                return;
              }
              if (ev.target.closest("[data-unbind-tile]")) {
                await unbindSelectedTiles(data);
                const fresh = await loadAll(); Object.assign(db, fresh); Object.assign(data, duplicate(fresh.shops?.[data.id] || data));
                const status = rootEd.querySelector("[data-tile-status]"); if (status) status.textContent = `Bound Tiles: ${(data.tileUuids||[]).length}`;
                return;
              }
              if (ev.target.closest("[data-helper-tile]")) return createTileHelperMacro();
              const i = ev.target.closest("[data-rem]")?.getAttribute("data-rem");
              if (i != null) { data.items.splice(Number(i),1); if ($items) $items.innerHTML = renderItems(); await commit(); autosizeDialog(app2, bodyId); }
              if (ev.target.closest("[data-qadd]")) return doQuickAdd();
              if (ev.target.closest("[data-testr]")){
                const ref = $tableIn.value.trim() || db.defaults.rollTable;
                const tables = await findDynamicRollTables(ref);
                if (!tables.length) return ui.notifications.warn("No RollTable matched those references.");
                const t = tables[dynamicRandomInt(0, tables.length-1)];
                const roll = await rollDynamicTable(t);
                if (roll?.results?.length && typeof t.toMessage === "function") await t.toMessage(roll.results, {roll:roll.roll});
                if (tables.length > 1) ui.notifications.info(`Matched ${tables.length} RollTables; rolled ${t.name}.`);
              }
              if (ev.target.closest("[data-preview]")){
                await commit();
                openShop(data.id);
              }
              if (ev.target.closest(".face-chip .x")){
                const chip = ev.target.closest(".face-chip");
                const idx = Number(chip?.getAttribute("data-i"));
                if (!Number.isNaN(idx)) { data.faces.splice(idx,1); await commit(); renderFaces(); }
              }
            });

            function renderFaces(){
              $faces.innerHTML = (data.faces?.length ? data.faces.map((F,i)=> {
                const src = typeof F==="string"?F:(F?.img||"");
                const nm = (typeof F==="object" && F?.name) ? ` title="${esc(F.name)}"` : "";
                return `<span class="face-chip" data-i="${i}"><img class="face" src="${esc(src)}"${nm}><span class="x" title="Remove">✕</span></span>`;
              }).join("") : `<span class="muted">Drag a Token or Actor here…</span>`);
            }

            function dragOver(e){ e.preventDefault(); e.currentTarget.classList.add("drag"); }
            function dragLeave(e){ e.preventDefault(); e.currentTarget.classList.remove("drag"); }
            async function onDropItem(e){
              e.preventDefault(); e.currentTarget.classList.remove("drag");
              const raw = e.dataTransfer.getData("text/plain"); if (!raw) return;
              let d=null; try{ d=JSON.parse(raw);}catch{}
              if (!d || d.type!=="Item") return;
              const uuid = d.uuid || (d.pack ? `${d.pack}.Item.${d.id}` : `Item.${d.id}`);
              const doc  = await fromUuid(uuid); if (!doc) return;
              const price = (doc.system?.price?.market != null) ? Number(doc.system.price.market) : (Number(doc.system?.price) || 0);
              const item = { uuid, name: doc.name, img: doc.img, price: Math.max(0, price|0), packageSize:marketPackageSizeFromData(doc), marketPackagePrice:Math.max(0, price|0), qty: 1, infinite: false, fixerOnly:false, fixerMinRank:null, autoFixerLocked:false, dynamicManaged:false, tradeIn:false, stockClass:"static" };
              data.items.push(syncAutoFixerLock(item, db.defaults, {newItem:true}));
              if ($items) $items.innerHTML = renderItems(); await commit(); autosizeDialog(app2, bodyId);
            }
            $drop.addEventListener("dragover", dragOver);
            $drop.addEventListener("dragleave", dragLeave);
            $drop.addEventListener("drop", onDropItem);

            async function onDropDynamicPool(e){
              e.preventDefault(); e.currentTarget.classList.remove("drag");
              const raw = e.dataTransfer.getData("text/plain"); if (!raw) return;
              let d=null; try{ d=JSON.parse(raw); }catch{}
              if (!d || d.type!=="Item") return ui.notifications.warn("Drop an Item document into the curated dynamic list.");
              const uuid = d.uuid || (d.pack ? `${d.pack}.Item.${d.id}` : `Item.${d.id}`);
              const doc = await fromUuid(uuid);
              if (!doc) return ui.notifications.warn("Could not resolve that Item.");
              data.dynamic = normalizeDynamicSettings(data.dynamic);
              await addDynamicPoolDocument(data.dynamic.stockPool, doc);
              await commit(); refreshDynamicPool(); autosizeDialog(app2, bodyId);
            }
            $dynDrop?.addEventListener("dragover", dragOver);
            $dynDrop?.addEventListener("dragleave", dragLeave);
            $dynDrop?.addEventListener("drop", onDropDynamicPool);

            async function onDropFace(e){
              e.preventDefault(); e.currentTarget.classList.remove("drag");
              const raw = e.dataTransfer.getData("text/plain"); if (!raw) return;
              let d=null; try{ d=JSON.parse(raw);}catch{}
              if (!d) return;
              let img=null, name=null;
              try{
                if (d.type==="Token"){
                  const tok = await fromUuid(d.uuid || `Scene.${sceneId}.Token.${d.id}`);
                  img  = tok?.texture?.src || tok?.document?.texture?.src || tok?.actor?.img || tok?.actor?.prototypeToken?.texture?.src;
                  name = tok?.document?.name || tok?.name || tok?.actor?.name || null;
                } else if (d.type==="Actor"){
                  const a = await fromUuid(d.uuid || `Actor.${d.id}`);
                  img  = a?.img || a?.prototypeToken?.texture?.src;
                  name = a?.name || null;
                }
              }catch{}
              if (!img) return ui.notifications.warn("Drop a Token or Actor.");
              data.faces = data.faces || [];
              data.faces.push({ img, name: name || "" });
              await commit(); renderFaces(); autosizeDialog(app2, bodyId);
            }
            $dropFace.addEventListener("dragover", dragOver);
            $dropFace.addEventListener("dragleave", dragLeave);
            $dropFace.addEventListener("drop", onDropFace);

            renderFaces();
            autosizeDialog(app2, bodyId);
            requestAnimationFrame(()=> autosizeDialog(app2, bodyId));
            edDlg._mo = observeResize(app2, bodyId);
          },
          close: (appEl)=>{
            cleanupDialogVisuals(edDlg._style, edDlg._mo);
            refresh();
          }
        });
        edDlg.render(true);
      }
    },
    close: (appEl)=> {
      cleanupDialogVisuals(style, dlg._mo);
    }
  });

  dlg.render(true);
}

// -------- helper: guess name for legacy string-only faces --------
function guessNameForImage(img){
  const toks = canvas?.tokens?.placeables ?? [];
  const tHit = toks.find(t => (t?.document?.texture?.src || t?.texture?.src) === img);
  if (tHit) return tHit.document?.name || tHit.name || tHit.actor?.name || "";
  const aHit = game.actors?.find(a => a?.img === img || a?.prototypeToken?.texture?.src === img);
  return aHit?.name || "";
}

// -------------------- Player shop --------------------
async function openShop(shopId){
  const bodyId = makeUiId("shop");
  const db = await loadAll();
  const shop = db.shops?.[shopId];
  if(!shop) return ui.notifications.warn(`Bodega not found: ${shopId}`);
  if (shop.sceneOnly && sceneId && shop.sceneId && sceneId !== shop.sceneId && !isGM)
    return ui.notifications.warn("This Bodega is not available on this scene.");

  const items = shop.items||[];
  const buyer = canvas.tokens.controlled[0]?.actor ?? game.user.character;
  if(!buyer) return ui.notifications.warn("Select a token or set a Player Character.");

  const rank = getFixerRank(buyer);
  const discCfg = db.defaults?.fixerDiscounts ?? defaultDB().defaults.fixerDiscounts;
  const isFixer = rank>0;

  const ledger = await resolveLedger(shop);
  const ledgerPurse = ledger ? Number(ledger.system?.wealth?.value|0) : null;
  const purse = ledgerPurse != null ? ledgerPurse : Math.max(0, Number(shop.purse|0));
  const bb = shop.buyback || {};

  const sellableDocs = (buyer.items ?? []).filter(it => {
    const sys = it.system ?? {};
    const equippedState = String(sys.equipped ?? "").toLowerCase();
    const isInstalled   = !!sys.isInstalled;
    const isUpgraded    = !!sys.isUpgraded;
    const allowedEquip =
      equippedState === "" || equippedState === "carried" || equippedState === "owned";
    const kind = getItemKind(it);
    return allowedEquip && !isInstalled && !isUpgraded && bb[kind]?.on && getItemMarketValue(it) > 0;
  });
  const sellables = await Promise.all(sellableDocs.map(async it => {
    const kind     = getItemKind(it);
    const basePct  = (bb[kind]?.on ? (bb[kind]?.pct ?? 0) : 0);
    const finalPct = applyFixerBonusToSell(basePct, rank, discCfg);
    const packageInfo = await resolveMarketPackageInfo(it);
    const baseVal  = packageInfo.marketPrice;
    const packageSize = packageInfo.packageSize;
    const offerPack = packageInfo.verified ? Math.max(0, Math.floor(baseVal * finalPct / 100)) : 0;
    const qtyAvail = readStackQty(it);
    return {
      it, kind, baseVal, basePct, finalPct, offer:offerPack, offerPack, packageSize, qtyAvail,
      packageVerified:!!packageInfo.verified,
      packageProvenance:packageInfo.provenance || "unknown"
    };
  }));

  const accent = db.era2045 ? "#E64539" : "#00FFF7";
  const style = document.createElement("style");
  style.textContent = makePlayerCSS(accent, bodyId);


  const visible = items.filter(it=>{
    if (!it.fixerOnly) return true;
    if (!isFixer) return false;
    const minR = (it.fixerMinRank==null || it.fixerMinRank==="") ? null : Number(it.fixerMinRank|0);
    return (minR==null) ? true : (rank >= minR);
  });

  const headerPurseHTML = `
  <div class="muted" style="font-size:14px;margin-top:2px">
    Vendor Purse: <b class="purse-val">${purse|0}</b> <span class="eb">eb</span>
  </div>`;

  const fixerTag = isFixer
    ? `<div class="fixer-tag"><b>Fixer:</b> You qualify to view Fixer-only items.</div>`
    : "";

// Faces (same as 2.0.3)
const facesHTML = (shop.faces?.length)
  ? `<div class="faces faces-large" title="Shopkeepers">${
      shop.faces.map(F=>{
        const src  = typeof F==="string" ? F : (F?.img||"");
        const name = typeof F==="object" ? (F?.name||"") : guessNameForImage(src);
        const label = name ? `<div class="face-label">${esc(name)}</div>` : "";
        return `<div class="face-block"><img class="face-lg" src="${esc(src)}">${label}</div>`;
      }).join("")
    }</div>`
  : "";

// Items list (player view layout)
const itemsListHTML = visible.length ? visible.map((it,i)=>{
  const soldOut = !it.infinite && (Number(it.qty|0) <= 0);
  const finalPrice = priceWithFixerBuyDiscount(it.price|0, isFixer, rank, discCfg, !!it.fixerOnly);
  const hasDiscount = !!it.fixerOnly && finalPrice < (it.price|0) && isFixer;

  const priceLine =
    `<span class="muted price-line">` +
      (hasDiscount
        ? `<del>${it.price|0} <span class="eb">eb</span></del> <b>${finalPrice}</b> <span class="eb">eb</span>`
        : `<b>${finalPrice}</b> <span class="eb">eb</span>`) +
      ` — ${it.infinite ? '<span class="stock-live">∞ stock</span>' : `<span class="stock-live">${it.qty|0} left</span>`}` +
      (Number(it.packageSize || 1) > 1 ? ` — <i>${Number(it.packageSize|0)} units / purchase</i>` : '') +
      (it.fixerOnly
        ? " — <i>Fixer-only" + (it.fixerMinRank ? ` (Min <b>${it.fixerMinRank}</b>)` : "") + "</i>"
        : "") +
      (it.tradeIn || it.stockClass === "tradein" ? ` — <span class="stock-badge tradein">Trade-In</span>` : (it.dynamicManaged ? ` — <span class="stock-badge dynamic">Dynamic</span>` : "")) +
    `</span>`;

  return `
    <div class="card bodega-stock-row" data-bodega-item-key="${esc(dynamicItemKey(it))}" data-bodega-stock-class="${esc(it.stockClass || (it.dynamicManaged ? 'dynamic' : 'static'))}">
      <div class="item-row">
        <div class="item-left">
          <img class="thumb" src="${it.img || 'icons/svg/box.svg'}">
          <div>
            <div class="name" title="${esc(it.name)}">${esc(it.name)}</div>
            ${priceLine}
          </div>
        </div>
        <div class="buy-controls">
          <label class="qty-label">QTY <input class="qty-buy" type="number" min="1" ${it.infinite ? '' : `max="${Math.max(1, Number(it.qty|0))}"`} value="1" ${soldOut ? 'disabled' : ''}></label>
          <button class="btn buy" data-i="${i}" ${soldOut ? 'disabled' : ''}>
            <i class="fas fa-shopping-cart"></i> ${soldOut ? 'Sold out' : 'Buy'}
          </button>
        </div>
      </div>
    </div>`;
}).join("") : `<div class="muted">This Bodega is empty.</div>`;

// Sell block
const sellBlockHTML = sellables.length ? `
  <div class="card">
    <div class="title">Sell to Vendor</div>
    <div class="muted" style="margin-bottom:6px">
      Vendor Purse: <b class="purse-val">${purse|0}</b> <span class="eb">eb</span>.
      ${isFixer ? `Your Operator rank improves offers.` : `No Operator bonus.`}
    </div>
    <div class="list" data-sell-list>
      ${sellables.map((s,idx)=>`
        <div class="item-row" data-sell-i="${idx}">
          <div class="item-left">
            <img class="thumb" src="${s.it.img || 'icons/svg/box.svg'}">
            <div>
              <div class="name" title="${esc(s.it.name)}">${esc(s.it.name)}</div>
              <div class="muted">
                ${!s.packageVerified
                  ? `<span class="stock-badge tradein">GM REVIEW REQUIRED</span> • Original market package size cannot be verified`
                  : (s.packageSize > 1
                    ? `Market pack <b>${s.packageSize}</b> for <b>${s.baseVal|0}</b> <span class="eb">eb</span> • Offer <b>${s.offerPack|0}</b> <span class="eb">eb</span> per full-pack equivalent (${s.finalPct|0}%)`
                    : `Value <b>${s.baseVal|0}</b> <span class="eb">eb</span> • Offer <b>${s.offerPack|0}</b> <span class="eb">eb</span> (${s.finalPct|0}%)`)} • 
                <i>Have: ${s.qtyAvail}${s.packageVerified && s.packageSize > 1 ? ' individual units' : ''}</i>
              </div>
            </div>
          </div>
          <div class="buy-controls sell-controls">
  <label class="qty-label">QTY
    <input class="qty-sell" type="number" min="1" max="${s.qtyAvail}" value="${Math.min(1, s.qtyAvail)}" ${s.packageVerified ? '' : 'disabled'}>
  </label>
  <button class="btn sell" data-sell ${s.packageVerified ? '' : 'disabled title="Original market package size cannot be verified automatically."'}>${s.packageVerified ? 'Sell' : 'GM Review'}</button>
</div>

        </div>
      `).join("")}
    </div>
  </div>` : `<div class="card empty-note"><div class="empty-text">This vendor isn’t interested in anything you’re carrying.</div></div>`
;

// SINGLE content (keep only this one)
const content = `
<div id="${bodyId}">
  <div class="wrap" data-shop="${esc(shop.id)}">
    <div class="title">${esc(shop.name)}</div>
    <div class="shop-header">
      ${facesHTML}
      <div class="shop-head-center">
        <div class="buyer-line">Buyer: ${esc(buyer.name)}</div>
        ${headerPurseHTML}
      </div>
    </div>
    ${fixerTag}
    <div class="list" data-list>
      ${itemsListHTML}
    </div>
    ${sellBlockHTML}
  </div>
</div>`;


  const dlg = new Dialog({
    title: "Bodega™",
    content,
    buttons: { close: { label:"Close" } },
    width: 820,
    render: (html)=>{
      document.head.appendChild(style);
      const app = html[0].closest(".app");
      app.classList.add(`dialog-host-${bodyId}`);
      forceFooterButtons(app, accent);
      const root = html[0].querySelector(`#${bodyId}`);

      // BUY handler: every purchase is GM-authoritative and serialized per Bodega.
      root.querySelector("[data-list]")?.addEventListener("click", async (ev)=>{
        const buyButton = ev.target.closest(".buy");
        const iStr = buyButton?.getAttribute("data-i");
        if (iStr == null) return;
        const row = buyButton.closest(".bodega-stock-row");
        if (!row || row.dataset.busy === "1" || buyButton.dataset.soldOut === "1") return;

        const visibleNow = (shop.items||[]).filter(it=>{
          if (!it.fixerOnly) return true;
          if (!isFixer) return false;
          const minR = (it.fixerMinRank==null || it.fixerMinRank==="") ? null : Number(it.fixerMinRank|0);
          return (minR==null) ? true : (rank >= minR);
        });
        const visibleIndex = Number(iStr);
        const it = visibleNow[visibleIndex];
        if (!it) return ui.notifications.warn("That item changed. Re-open the Bodega and try again.");
        const sourceIndex = shop.items.indexOf(it);
        if (!it.infinite && Number(it.qty|0) <= 0) return ui.notifications.warn(`${it.name} is sold out.`);

        const qtyInput = row.querySelector(".qty-buy");
        const requested = Math.max(1, Number(qtyInput?.value ?? 1) | 0);
        const available = it.infinite ? Number.POSITIVE_INFINITY : Math.max(0, Number(it.qty|0));
        const qty = it.infinite ? requested : Math.min(requested, available);
        if (!qty) return ui.notifications.warn(`${it.name} is sold out.`);

        const payload = {
          nonce:bodegaNonce(),
          userId:game.user?.id || null,
          shopId:shop.id,
          buyerUuid:buyer.uuid,
          index:sourceIndex,
          itemKey:dynamicItemKey(it),
          stockClass:String(it.stockClass || (it.dynamicManaged ? "dynamic" : "static")),
          price:Math.max(0, Number(it.price|0)),
          qty
        };

        row.dataset.busy = "1";
        buyButton.disabled = true;
        buyButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing';
        if (qtyInput) qtyInput.disabled = true;

        const finish = (result) => {
          row.dataset.busy = "";
          if (Number.isFinite(result?.qtyRemaining)) updateOpenShopStock(shop.id, result.itemKey || payload.itemKey, result.stockClass || payload.stockClass, result.qtyRemaining);
          if (result?.ok){
            if (it.infinite){ buyButton.disabled = false; buyButton.innerHTML = '<i class="fas fa-shopping-cart"></i> Buy'; if (qtyInput) qtyInput.disabled = false; }
            ui.notifications.info(`${it.name} ×${result.qtyPurchased || qty} purchased.`);
          } else {
            if (buyButton.dataset.soldOut !== "1"){ buyButton.disabled = false; buyButton.innerHTML = '<i class="fas fa-shopping-cart"></i> Buy'; if (qtyInput) qtyInput.disabled = false; }
            ui.notifications.warn(result?.message || "Purchase failed.");
          }
        };

        if (game.user?.isGM){
          try { finish(await gmProcessPurchase(payload)); }
          catch(error){ console.error(error); finish({ok:false,message:"Purchase failed — check the console."}); }
          return;
        }

        let acked = false;
        const onAck = (message) => {
          if (message?.nonce !== payload.nonce) return;
          if (message.userId && message.userId !== game.user?.id) return;
          if (message.op !== "purchase-done" && message.op !== "purchase-failed") return;
          acked = true;
          game.socket.off(SOCKET, onAck);
          finish({
            ok:message.op === "purchase-done",
            message:message.message,
            itemKey:message.itemKey, stockClass:message.stockClass,
            qtyRemaining:message.qtyRemaining, qtyPurchased:message.qtyPurchased,
            total:message.total, purse:message.purse
          });
        };
        game.socket.on(SOCKET, onAck);
        game.socket.emit(SOCKET, {op:"gm-purchase", payload});

        setTimeout(() => {
          if (acked) return;
          game.socket.off(SOCKET, onAck);
          finish({ok:false, message:"No active GM acknowledged the purchase. Nothing was changed by this client."});
        }, 4500);
      });

      // SELL handler: execute on the GM, then fall back to a chat approval card if no ACK arrives.
      root.querySelector("[data-sell-list]")?.addEventListener("click", async (ev) => {
        const row = ev.target.closest("[data-sell-i]");
        if (!row || !ev.target.closest(".sell")) return;
        if (row.dataset.busy === "1") return;
        row.dataset.busy = "1";
        row.querySelector(".sell")?.setAttribute("disabled", "true");

        const idx = Number(row.getAttribute("data-sell-i")|0);
        const entry = sellables[idx];
        if (!entry) {
          row.dataset.busy = "";
          row.querySelector(".sell")?.removeAttribute("disabled");
          return;
        }
        if (!entry.packageVerified) {
          ui.notifications.warn("Bodega cannot verify this stacked item's original market package size. GM review required; handle this buyback manually.");
          row.dataset.busy = "";
          return;
        }

        const fresh = buyer.items.get(entry.it.id)
          || buyer.items.find(i => i.name === entry.it.name && getItemMarketValue(i) === entry.baseVal);
        if (!fresh) {
          ui.notifications.warn("That item changed. Re-open Bodega and try again.");
          row.dataset.busy = "";
          row.querySelector(".sell")?.removeAttribute("disabled");
          return;
        }

        const rankNow = getFixerRank(buyer);
        const finalPct = applyFixerBonusToSell(entry.basePct, rankNow, discCfg);
        const packageInfoNow = await resolveMarketPackageInfo(fresh);
        if (!packageInfoNow.verified) {
          ui.notifications.warn("Bodega cannot verify this stacked item's original market package size. GM review required; handle this buyback manually.");
          row.dataset.busy = "";
          row.querySelector(".sell")?.setAttribute("disabled", "true");
          row.querySelector(".qty-sell")?.setAttribute("disabled", "true");
          return;
        }
        const qtyInput = Number(row.querySelector(".qty-sell")?.value ?? 1) | 0;
        const qty = Math.max(1, Math.min(readStackQty(fresh), qtyInput || 1));
        const offerTotal = proportionalBuybackTotal(packageInfoNow.marketPrice, finalPct, qty, packageInfoNow.packageSize);
        if (offerTotal <= 0) {
          ui.notifications.warn(`That quantity is worth less than 1 eb at this vendor's buyback rate. Sell more at once.`);
          row.dataset.busy = "";
          row.querySelector(".sell")?.removeAttribute("disabled");
          return;
        }

        const payload = {
          nonce:bodegaNonce(),
          shopId:shop.id,
          sellerUuid:buyer.uuid,
          itemId:fresh.id,
          itemName:fresh.name,
          baseVal:packageInfoNow.marketPrice,
          packageSize:packageInfoNow.packageSize,
          qty
        };

        if (game.user?.isGM) {
          const result = await gmProcessBuyback(payload);
          if (result?.ok) row.remove();
          else {
            row.dataset.busy = "";
            row.querySelector(".sell")?.removeAttribute("disabled");
          }
          return;
        }

        let acked = false;
        const onAck = (message) => {
          if (message?.nonce !== payload.nonce) return;
          if (message.op !== "buyback-done" && message.op !== "buyback-failed") return;
          acked = true;
          game.socket.off(SOCKET, onAck);
          if (message.op === "buyback-done") {
            row.remove();
            ui.notifications.info("Sell completed by the GM.");
          } else {
            row.dataset.busy = "";
            row.querySelector(".sell")?.removeAttribute("disabled");
            ui.notifications.warn(message.message || "The GM could not complete that buyback.");
          }
        };
        game.socket.on(SOCKET, onAck);
        game.socket.emit(SOCKET, {op:"gm-buyback", payload});
        ui.notifications.info("Sell submitted to the GM.");

        setTimeout(async () => {
          if (acked) return;
          game.socket.off(SOCKET, onAck);
          const link = `<button type="button" class="button" data-bodega-approve="${b2a(payload)}"><i class="fas fa-check"></i> Approve</button>`;
          await ChatMessage.create({
            speaker:ChatMessage.getSpeaker({alias:"Bodega"}),
            content:`<b>Approve Buyback (fallback)</b>: <b>${esc(fresh.name)}</b> ×${qty}${packageInfoNow.packageSize > 1 ? ` individual units (${packageInfoNow.packageSize}/market pack)` : ''} for <b>${offerTotal}</b> eb. ${link}`
          });
          ui.notifications.warn("No GM ACK — sent a fallback approval to chat.");
          row.dataset.busy = "";
          row.querySelector(".sell")?.removeAttribute("disabled");
        }, 1000);
      });
    },
    close: () => {
      cleanupDialogVisuals(style);
    }
  });

  dlg.render(true);
}

// -------------------- item/wealth helpers --------------------
async function adjustWealth(actor, delta, reason="Bodega Transaction"){
  const w = foundry.utils.deepClone(actor.system?.wealth ?? {});
  const before = w.value ?? 0;
  w.value = before + (delta|0);
  w.transactions = (w.transactions ?? []);
  const dir = delta>=0 ? "Increased" : "Decreased";
  w.transactions.push([`${dir} by ${Math.abs(delta|0)} to ${w.value|0}`, reason]);
  await actor.update({"system.wealth": w});
}
async function giveItem(actor, itemDoc){
  const data = itemDoc.toObject(); delete data._id;
  return actor.createEmbeddedDocuments("Item", [data]);
}
async function giveFromShop(actor, shopItem){
  let doc = shopItem.uuid ? await byUUID(shopItem.uuid) : null;
  if (doc) return giveItem(actor, doc);
  if (shopItem.raw){
    const data = foundry.utils.duplicate(shopItem.raw);
    delete data._id;
    return actor.createEmbeddedDocuments("Item", [data]);
  }
  ui.notifications.warn("Item no longer exists for sale.");
  return null;
}
async function byUUID(uuid){ try{ return await fromUuid(uuid); }catch{ return null; } }

// -------------------- RollTable resolver/draw --------------------
async function findRollTable(ref){
  const tables = await findDynamicRollTables(ref);
  return tables[0] || null;
}
async function findRollTables(ref){ return findDynamicRollTables(ref); }
async function drawFromTable(ref){
  const tables = await findDynamicRollTables(ref); if (!tables.length) return null;
  const t = tables[dynamicRandomInt(0, tables.length-1)];
  const roll = await rollDynamicTable(t);
  for (const result of dynamicShuffle(roll?.results || [])){
    const doc = await resolveDynamicTableResultDocument(result);
    if (doc) return doc;
  }
  return null;
}

// -------------------- Module API and lifecycle --------------------
function parseShopId(input) {
  if (input == null) return null;
  if (typeof input === "string") {
    const match = input.match(/id\s*=\s*([^,;]+)$/i);
    return String(match ? match[1] : input).replace(/[<>"'()\[\]\s]/g, "") || null;
  }
  if (Array.isArray(input)) return parseShopId(input[0]?.id ?? input[0]);
  if (typeof input === "object") return parseShopId(input.id);
  return null;
}

async function launch(input = null) {
  const tile = await findTriggerTile(input);
  const boundId = tile ? bodegaIdFromTile(tile) : null;
  if (boundId) return openShop(boundId);
  const shopId = parseShopId(input);
  if (shopId) return openShop(shopId);
  if (!game.user?.isGM) return ui.notifications.warn("This Tile is not bound to a Bodega. Ask the GM to configure it.");
  return openAdmin();
}

function exposeAPI() {
  const api = {
    version:MODULE_VERSION,
    openAdmin,
    openOptions,
    openShop,
    openBoundTile,
    openTile:(tile) => { const id = bodegaIdFromTile(tile); return id ? openShop(id) : ui.notifications.warn("This Tile is not bound to a Bodega."); },
    bindSelectedTiles:bindShopToTiles,
    unbindSelectedTiles,
    createTileHelperMacro,
    launch,
    bind:bindBodegaBridge,
    loadAll,
    saveAll,
    findItemAnywhere,
    findItemByNameFromPacks,
    resolveItemPacks:resolveDynamicItemPacks,
    findRollTable,
    findRollTables,
    drawFromTable,
    adjustWealth,
    readStackQty,
    writeStackQty,
    giveFromShopQty,
    gmProcessBuyback,
    gmProcessPurchase,
    processDynamicInventory,
    generateDynamicStock:async (shopId, replace=false) => {
      const db = await loadAll(); const shop = db.shops?.[shopId]; if (!shop) return null;
      shop.dynamic = normalizeDynamicSettings(shop.dynamic); shop.dynamic.enabled = true;
      await fillDynamicStock(shop, {replace, defaults:db.defaults, now:calendarTimestamp()});
      if (getSimpleCalendar() && !shop.dynamic.initializedAt) await initializeDynamicShop(shop, db.defaults, calendarTimestamp(), {markPastTraffic:true});
      await saveAll(db); return shop;
    },
    runCustomerCycle:async (shopId) => {
      const db = await loadAll(); const shop = db.shops?.[shopId]; if (!shop) return null;
      const result = await runNpcTraffic(shop, 1, calendarTimestamp()); await saveAll(db); return result;
    },
    restockNow:async (shopId) => {
      const db = await loadAll(); const shop = db.shops?.[shopId]; if (!shop) return null;
      await restockDynamicShop(shop, {defaults:db.defaults, now:calendarTimestamp()}); if (getSimpleCalendar()) scheduleNextRestock(shop, calendarTimestamp()); await saveAll(db); return shop;
    }
  };
  game.bodega = api;
  globalThis.Bodega = api;
}

Hooks.once("init", () => {
  ensureSetting();
});

Hooks.once("ready", () => {
  isGM = !!game.user?.isGM;
  sceneId = canvas?.scene?.id ?? null;
  exposeAPI();
  bindBodegaBridge();
  bindCalendarHooks();
  console.log(`Bodega | Ready v${MODULE_VERSION}. Existing bodega.db shop data is available.`);
});

Hooks.on("canvasReady", (canvasInstance) => {
  sceneId = canvasInstance?.scene?.id ?? canvas?.scene?.id ?? null;
});

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;
  const tokenControls = controls.find(control => control.name === "token");
  if (!tokenControls) return;
  tokenControls.tools ||= [];
  if (tokenControls.tools.some(tool => tool.name === "bodega-manager")) return;
  tokenControls.tools.push({
    name:"bodega-manager",
    title:"Bodega™ Manager",
    icon:"fas fa-store",
    button:true,
    visible:true,
    onClick:() => openAdmin()
  });
});

})();
