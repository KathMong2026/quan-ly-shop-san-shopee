// KHO SHOPEE (mã nguồn mở, giấy phép MIT) — máy chủ Supabase Edge Function "kho-shopee".
// Deploy:  npx supabase functions deploy kho-shopee --no-verify-jwt --project-ref <MÃ_PROJECT>
// Không có mã bí mật nào trong file: Partner Key / token Shopee lưu ở bảng kho_auth (chỉ máy chủ đọc được).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });

const FN_NAME = "kho-shopee";
const PUBLIC_BASE = `${SB_URL}/functions/v1/${FN_NAME}`;
// Chủ shop = kho_settings.owner_email (tài khoản đăng nhập đầu tiên, xem kho_claim_owner trong install.sql)
const PUSH_TEST_KEYS = [];

const HOSTS = {
  sandbox: "https://openplatform.sandbox.test-stable.shopee.sg",
  live: "https://partner.shopeemobile.com",
};
const ACTIVE = ["READY_TO_SHIP", "PROCESSED", "SHIPPED", "TO_CONFIRM_RECEIVE", "COMPLETED", "IN_CANCEL", "TO_RETURN"];

function nowSec() { return Math.floor(Date.now() / 1000); }
const enc = new TextEncoder();

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function isOwner(req) {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  try {
    const { data, error } = await admin.auth.getUser(m[1]);
    if (error || !data?.user) return false;
    const { data: st } = await admin.from("kho_settings").select("owner_email").eq("id", 1).maybeSingle();
    const owner = String(st?.owner_email ?? "").toLowerCase();
    return !!owner && (data.user.email ?? "").toLowerCase() === owner;
  } catch { return false; }
}

async function isCron(req) {
  const s = req.headers.get("x-cron-secret") ?? "";
  if (!s) return false;
  try {
    const { data } = await admin.from("kho_auth").select("cron_secret").eq("id", 1).single();
    return !!data?.cron_secret && s === data.cron_secret;
  } catch { return false; }
}

async function log(direction, action, status, detail) {
  await admin.from("kho_sync_log").insert({ direction, action, status, detail });
}

async function cfg() {
  const { data: s } = await admin.from("kho_settings").select("*").eq("id", 1).single();
  const { data: a } = await admin.from("kho_auth").select("*").eq("id", 1).single();
  const host = HOSTS[s?.environment ?? "sandbox"] ?? HOSTS.sandbox;
  return { s, a, host, partner_id: Number(s?.partner_id), key: a?.partner_key };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type" } });
}
async function appRedirect(params) {
  const { data } = await admin.from("kho_settings").select("app_url").eq("id", 1).maybeSingle();
  const base = String(data?.app_url ?? "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) return new Response("Ket noi Shopee: " + decodeURIComponent(params) + "\nHay mo lai app quan ly kho.", { headers: { "content-type": "text/plain; charset=utf-8" } });
  return Response.redirect(`${base}/?${params}`, 302);
}

const IMG_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const IMG_MAX_BYTES = 2 * 1024 * 1024;
async function uploadImage(req) {
  const body = await req.json();
  const dataUrl = String(body?.data ?? "");
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error("Thieu du lieu anh hop le (data URL base64)");
  const mime = m[1].toLowerCase();
  if (!IMG_EXT[mime]) throw new Error("Chi nhan anh jpeg/png/webp/gif");
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length > IMG_MAX_BYTES) throw new Error("Anh vuot qua 2MB");
  const path = `products/${crypto.randomUUID()}.${IMG_EXT[mime]}`;
  const { error } = await admin.storage.from("kho-images").upload(path, bytes, { contentType: mime, upsert: false });
  if (error) throw new Error(error.message);
  const { data: pub } = admin.storage.from("kho-images").getPublicUrl(path);
  return { url: pub.publicUrl, path };
}

async function refreshToken() {
  const c = await cfg();
  if (!c.a?.refresh_token || !c.s?.shop_id) throw new Error("Chua cap quyen shop");
  const path = "/api/v2/auth/access_token/get";
  const t = nowSec();
  const sign = await hmac(c.key, `${c.partner_id}${path}${t}`);
  const r = await fetch(`${c.host}${path}?partner_id=${c.partner_id}&timestamp=${t}&sign=${sign}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: c.a.refresh_token, shop_id: Number(c.s.shop_id), partner_id: c.partner_id }),
  });
  const j = await r.json();
  if (j.error) { await log("db_to_shopee", "token_refresh", "error", j); throw new Error(j.message || j.error); }
  await admin.from("kho_auth").update({
    access_token: j.access_token, refresh_token: j.refresh_token,
    token_expire_at: new Date((nowSec() + (j.expire_in ?? 14400)) * 1000).toISOString(), updated_at: new Date().toISOString(),
  }).eq("id", 1);
  await log("db_to_shopee", "token_refresh", "success", { expire_in: j.expire_in });
  return j.access_token;
}

async function getToken() {
  const c = await cfg();
  if (!c.s?.shop_id) throw new Error("Chua cap quyen shop (thieu shop_id)");
  let token = c.a?.access_token;
  const exp = c.a?.token_expire_at ? new Date(c.a.token_expire_at).getTime() : 0;
  if (!token || exp < Date.now() + 60000) token = await refreshToken();
  return { token, shop_id: Number(c.s.shop_id), host: c.host, partner_id: c.partner_id, key: c.key };
}

async function shopUrl(path, extra = {}) {
  const { token, shop_id, host, partner_id, key } = await getToken();
  const t = nowSec();
  const sign = await hmac(key, `${partner_id}${path}${t}${token}${shop_id}`);
  const qs = new URLSearchParams({ partner_id: String(partner_id), timestamp: String(t), sign, access_token: token, shop_id: String(shop_id), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) });
  return `${host}${path}?${qs.toString()}`;
}

async function shopGet(path, extra = {}) {
  const url = await shopUrl(path, extra);
  const r = await fetch(url);
  return await r.json();
}

async function shopPost(path, body, extra = {}) {
  const url = await shopUrl(path, extra);
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return await r.json();
}

// Tim bien the trong app cho 1 dong don Shopee.
// SUA 28/09/2026: truoc day neu khong khop model_id thi lay DAI bien the dau tien cua listing
// (limit 1) -> don cua phan loai moi/chua keo ve bi tru nham vao mau khac (vd Bra21-Den).
// Nay: chi fallback theo item_id khi listing KHONG co phan loai (model_id = 0) hoac chi con dung
// 1 bien the dang song; con lai thu SKU trong cung listing; khong chac chan thi tra null (khong tru).
async function findVariant(item_id, model_id, sku) {
  if (model_id) {
    const { data } = await admin.from("kho_variants").select("id,stock").eq("shopee_model_id", model_id).is("archived_at", null).maybeSingle();
    if (data) return data;
  }
  const { data: p } = await admin.from("kho_products").select("id").eq("shopee_item_id", item_id).maybeSingle();
  if (p) {
    const { data: vs } = await admin.from("kho_variants").select("id,stock,sku,shopee_model_id").eq("product_id", p.id).is("archived_at", null).limit(50);
    const live = vs ?? [];
    // Listing khong phan loai (model_id 0) hoac bien the duy nhat chua gan model -> chac chan la no.
    if (live.length === 1 && (!model_id || !live[0].shopee_model_id)) return live[0];
    if (sku) {
      const hit = live.filter(v => v.sku && normSku(v.sku) === normSku(sku));
      if (hit.length === 1) return hit[0];
    }
    await log("shopee_to_db", "order_item_unmatched", "warn", { item_id, model_id, sku, candidates: live.length });
    return null;
  }
  if (sku) {
    const { data } = await admin.from("kho_variants").select("id,stock").in("sku", [sku, appSku(sku)]).is("archived_at", null).limit(2);
    if ((data ?? []).length === 1) return data[0];
  }
  await log("shopee_to_db", "order_item_unmatched", "warn", { item_id, model_id, sku, candidates: 0 });
  return null;
}

// Chen TAT CA dong hang cua 1 don trong 1 lenh duy nhat (nguyen tu) + khoa UNIQUE(order_id,line_no).
// SUA 28/09/2026 loi nhan doi dong don: webhook va cron cung xu ly 1 don; tien trinh A vua tao don
// va dang chen tung dong, tien trinh B thay don da co nhung dem order_items = 0 (A chua chen xong)
// -> B chen them 1 bo nua -> don co 2 bo dong -> tru kho gap doi. Nay ca 2 cung tinh line_no tu
// vi tri trong item_list; ben den sau bi UNIQUE bo qua (ignoreDuplicates), va vi chen 1 lenh nen
// ben doc khong bao gio thay don "moi chen 1 nua".
async function insertOrderItems(orderId, items) {
  if (!items.length) return 0;
  const rows = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const v = await findVariant(it.item_id, it.model_id, it.model_sku || it.item_sku);
    rows.push({
      order_id: orderId, line_no: i, variant_id: v?.id ?? null, shopee_item_id: it.item_id, shopee_model_id: it.model_id,
      sku: it.model_sku || it.item_sku, item_name: it.item_name, qty: it.model_quantity_purchased ?? 1,
      price: it.model_discounted_price ?? it.model_original_price,
    });
  }
  const { data, error } = await admin.from("kho_order_items")
    .upsert(rows, { onConflict: "order_id,line_no", ignoreDuplicates: true }).select("id");
  if (error) await log("shopee_to_db", "order_items_insert", "error", { order_id: orderId, msg: error.message });
  return (data ?? []).length;
}

function firstPrice(pi) {
  const a = Array.isArray(pi) ? pi[0] : pi;
  return Number(a?.current_price ?? a?.original_price ?? 0) || 0;
}
function firstStock(si) {
  if (si?.summary_info?.total_available_stock != null) return Number(si.summary_info.total_available_stock);
  const a = Array.isArray(si) ? si[0] : si;
  if (a?.current_stock != null) return Number(a.current_stock);
  if (a?.stock != null) return Number(a.stock);
  return null;
}

// Ghi lich su kiem ke khi import_stock ghi de ton tu Shopee (de bao cao Xuat-Nhap-Ton khong bi nhay so)
async function logStocktake(variant_id, oldStock, newStock, note) {
  const diff = Number(newStock) - Number(oldStock ?? 0);
  if (!diff) return 0;
  await admin.from("kho_stock_movements").insert({
    variant_id,
    change: diff,
    reason: diff > 0 ? "kiem_ke_tang" : "kiem_ke_giam",
    direction: "none",
    synced: true,
    synced_at: new Date().toISOString(),
    note: note ?? `Kiem ke: lay ton Shopee lam goc (${oldStock ?? 0} -> ${newStock})`,
  });
  return 1;
}

// ===== NHAN DIEN LAI BIEN THE BI XOA ROI TAO LAI TREN SHOPEE =====
// Shopee bat buoc xoa phan loai trong nhieu tinh huong -> phan loai moi co model_id MOI.
// Neu khong nhan ra "day van la mon cu", app se tao ban moi trang tron: mat gia von, mat lich su kho,
// mat lien ket dung chung ton. Hai ham duoi chuan hoa SKU va TEN de van khop duoc.
function normSku(s) {
  // Bo hau to "app" (SP do app tu tao khi dong bo tu Shopee, 29/09/2026) de SO926-app == SO926
  return String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d").replace(/[^a-z0-9]/gi, "").toUpperCase().replace(/APP$/, "");
}
// ---- Hau to "app" cho SKU san pham/bien the do app tu tao khi dong bo tu Shopee (29/09/2026) ----
const APP_SUFFIX = "-app";   // khop quy uoc ma hang kho hien co (vd Bra50-Den-M-app)
function appSku(s) { return s ? String(s) + APP_SUFFIX : null; }
function hasApp(s) { return !!s && /app$/i.test(String(s)); }
// Giu hau to "app" neu SKU hien tai trong app dang co; nguoc lai lay dung SKU Shopee
function syncSku(cur, shop) { if (!shop) return cur ?? null; return hasApp(cur) ? appSku(shop) : shop; }
// "One Size / Trang" va "Trang / One Size" la MOT (nhan vien chi doi thu tu thuoc tinh)
function normName(s) {
  return String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d").toLowerCase().split("/")
    .map(x => x.replace(/[^a-z0-9]/g, "")).filter(Boolean).sort().join("|");
}

// Bien the "ma": ton tai trong app nhung model_id da bien mat tren Shopee (nhan vien sua/xoa lai
// phan loai -> Shopee cap model_id MOI, ban cu tro thanh rac lam sai tong ton va co the bi day nham).
// Chua tung phat sinh gi -> xoa han. Da co lich su ban/kho -> luu kho (archived_at) de bao cao con dung,
// bo shopee_model_id + tat co day de khong bao gio ghi nham len san nua.
async function cleanupGhostVariants(productId, liveModelIds) {
  if (!liveModelIds.length) return { deleted: 0, archived: 0 };
  const live = new Set(liveModelIds.map(x => String(x)));
  const { data: vs } = await admin.from("kho_variants")
    .select("id,variant_name,sku,shopee_model_id,stock")
    .eq("product_id", productId).not("shopee_model_id", "is", null).is("archived_at", null);
  let deleted = 0, archived = 0;
  for (const v of vs ?? []) {
    if (live.has(String(v.shopee_model_id))) continue;
    const { count: mc } = await admin.from("kho_stock_movements").select("id", { count: "exact", head: true }).eq("variant_id", v.id);
    const { count: oc } = await admin.from("kho_order_items").select("id", { count: "exact", head: true }).eq("variant_id", v.id);
    const { count: rc } = await admin.from("kho_variants").select("id", { count: "exact", head: true }).eq("mirrors_variant_id", v.id);
    if (!mc && !oc && !rc) {
      await admin.from("kho_variants").delete().eq("id", v.id);
      deleted++;
      await log("shopee_to_db", "cleanup_variant", "success", { action: "deleted", name: v.variant_name, sku: v.sku, model_id: v.shopee_model_id, stock: v.stock });
    } else {
      await admin.from("kho_variants")
        .update({ archived_at: new Date().toISOString(), shopee_model_id: null, needs_sync_shopee: false, needs_sync_lazada: false })
        .eq("id", v.id);
      archived++;
      await log("shopee_to_db", "cleanup_variant", "success", { action: "archived", name: v.variant_name, sku: v.sku, model_id: v.shopee_model_id, stock: v.stock });
    }
  }
  return { deleted, archived };
}

// ---------------------------------------------------------------------------
// Ghi ton doc duoc tu Shopee ve MA HANG KHO.
// Chi ap dung cho listing co cong thuc 1 thanh phan x1 (listing thuong / mirror).
// Listing combo (nhieu thanh phan hoac qty>1): BO QUA — so tren Shopee la so GOI.
// Sau do: ton Shopee la GOC, nen chi bat co day nguoc cho listing nao tinh ra
// khac voi so Shopee dang co (vi du listing anh em dung chung ma hang, hoac combo).
// ---------------------------------------------------------------------------
async function applyShopeeStockToItems(list) {
  let applied = 0, skipped_combo = 0, unchanged = 0, no_bom = 0, net = 0;
  for (const x of list) {
    const { data: bom } = await admin.from("kho_variant_bom").select("item_id,qty").eq("variant_id", x.variant_id);
    if (!bom || !bom.length) { no_bom++; continue; }
    if (bom.length !== 1 || Number(bom[0].qty) !== 1) { skipped_combo++; continue; }
    const { data: it } = await admin.from("kho_items").select("id,stock").eq("id", bom[0].item_id).maybeSingle();
    if (!it) { no_bom++; continue; }
    const diff = Number(x.stock) - Number(it.stock ?? 0);
    if (diff === 0) { unchanged++; continue; }
    const { error } = await admin.rpc("kho_adjust_item_stock", {
      p_item_id: it.id,
      p_change: diff,
      p_reason: diff > 0 ? "kiem_ke_tang" : "kiem_ke_giam",
      p_direction: "none",
      p_note: `Kiem ke tu Shopee (${x.label}): ${it.stock ?? 0} -> ${x.stock}`,
    });
    if (!error) { applied++; net += diff; }
  }
  // Doi chieu lai: listing nao tinh ra dung bang so Shopee thi thoi khong day nua.
  await admin.from("kho_variants").update({ needs_sync_shopee: false }).eq("needs_sync_shopee", true);
  const byId = {}; for (const x of list) byId[x.variant_id] = Number(x.stock);
  const ids = Object.keys(byId);
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data: vs } = await admin.from("kho_variants").select("id,stock").in("id", chunk);
    const need = (vs ?? []).filter(v => Number(v.stock ?? 0) !== byId[v.id]).map(v => v.id);
    if (need.length) await admin.from("kho_variants").update({ needs_sync_shopee: true }).in("id", need);
  }
  return { applied, skipped_combo, unchanged, no_bom, net };
}

// ---------------------------------------------------------------------------
// CHI DOC ton that tren Shopee (khong ghi gi vao products/variants).
// Dien vao cot stock_shopee cua bang backup de doi chieu voi so app dang giu.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// DOC ton that tren Shopee (chi doc, khong ghi gi vao products/variants)
// ---------------------------------------------------------------------------
async function readShopeeStock() {
  let offset = 0; const itemIds = [];
  for (let guard = 0; guard < 30; guard++) {
    const j = await shopGet("/api/v2/product/get_item_list", { offset, page_size: 50, item_status: "NORMAL" });
    if (j.error) throw new Error(j.message || j.error);
    const items = j?.response?.item ?? [];
    for (const it of items) itemIds.push(it.item_id);
    if (j?.response?.has_next_page) offset = j.response.next_offset; else break;
  }
  const rows = [];
  for (let i = 0; i < itemIds.length; i += 50) {
    const batch = itemIds.slice(i, i + 50);
    const j = await shopGet("/api/v2/product/get_item_base_info", { item_id_list: batch.join(",") });
    for (const it of (j?.response?.item_list ?? [])) {
      if (it.has_model) {
        const mj = await shopGet("/api/v2/product/get_model_list", { item_id: it.item_id });
        for (const m of (mj?.response?.model ?? [])) {
          rows.push({ item_id: it.item_id, model_id: m.model_id, sku: m.model_sku ?? null, stock: firstStock(m.stock_info_v2 ?? m.stock_info) });
        }
      } else {
        rows.push({ item_id: it.item_id, model_id: null, sku: it.item_sku ?? null, stock: firstStock(it.stock_info_v2 ?? it.stock_info) });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Dien cot stock_shopee cho cac dong 'variant' cua 1 ban sao luu
// ---------------------------------------------------------------------------
async function fillShopeeStock(backupId) {
  const rows = await readShopeeStock();
  let matched = 0;
  for (const r of rows) {
    if (r.stock == null) continue;
    let q = admin.from("kho_backup_lines").update({ stock_shopee: Number(r.stock) })
      .eq("backup_id", backupId).eq("loai", "variant");
    q = r.model_id ? q.eq("shopee_model_id", r.model_id) : q.eq("shopee_item_id", r.item_id).is("shopee_model_id", null);
    const { data } = await q.select("id");
    matched += (data ?? []).length;
  }
  const { data: all } = await admin.from("kho_backup_lines")
    .select("sku,variant_name,stock_app,stock_shopee").eq("backup_id", backupId).eq("loai", "variant");
  const lech = (all ?? []).filter(x => x.stock_shopee != null && Number(x.stock_shopee) !== Number(x.stock_app));
  const chua_doi_chieu = (all ?? []).filter(x => x.stock_shopee == null).length;
  await admin.from("kho_backups").update({
    shopee_checked_at: new Date().toISOString(),
    shopee_rows: rows.length,
    shopee_lech: lech.length,
  }).eq("id", backupId);
  return { shopee_rows: rows.length, matched, lech: lech.length, chua_doi_chieu, chi_tiet_lech: lech.slice(0, 80) };
}

// ---------------------------------------------------------------------------
// CHUP 1 BAN SAO LUU: app truoc (luon thanh cong), roi doi chieu Shopee.
// Shopee loi thi ban chup app VAN GIU, chi danh dau status.
// ---------------------------------------------------------------------------
async function backupRun(kind, label, note) {
  const { data: bid, error } = await admin.rpc("kho_create_backup", {
    p_kind: kind || "auto", p_label: label || null, p_note: note || null,
  });
  if (error) { await log("db_to_shopee", "backup_run", "error", { step: "create", msg: error.message }); throw new Error(error.message); }

  let shopee = null, shopeeErr = null;
  try { shopee = await fillShopeeStock(bid); }
  catch (e) { shopeeErr = String(e?.message ?? e); await admin.from("kho_backups").update({ status: "shopee_loi" }).eq("id", bid); }

  const { data: b } = await admin.from("kho_backups").select("*").eq("id", bid).maybeSingle();
  const res = { backup_id: bid, kind: kind || "auto", header: b, shopee, shopee_error: shopeeErr };
  await log("shopee_to_db", "backup_run", shopeeErr ? "warn" : "success", {
    backup_id: bid, kind: kind || "auto", so_ma_hang: b?.so_ma_hang, so_listing: b?.so_listing,
    tong_ton_that: b?.tong_ton_that, shopee_lech: b?.shopee_lech, shopee_error: shopeeErr,
  });
  return res;
}

async function importNewStockAsPurchase(allLines) {
  // CHI nhap kho cho SP CHUA CO LICH SU KHO (SP moi). SP da co lich su -> KHONG lay so Shopee lam so nhap.
  const pids = [...new Set(allLines.map(l => l.product_id))];
  const { data: vs } = await admin.from("kho_variants").select("id,product_id").in("product_id", pids);
  const vids = (vs ?? []).map(v => v.id);
  const { data: bom } = vids.length ? await admin.from("kho_variant_bom").select("variant_id,item_id").in("variant_id", vids) : { data: [] };
  const hasHist = new Set();
  const v2p = new Map((vs ?? []).map(v => [v.id, v.product_id]));
  for (const col of ["variant_id", "via_variant_id"]) {
    if (!vids.length) break;
    const { data } = await admin.from("kho_stock_movements").select(col).in(col, vids);
    for (const r of data ?? []) hasHist.add(v2p.get(r[col]));
  }
  const itemIds = [...new Set((bom ?? []).map(b => b.item_id))];
  if (itemIds.length) {
    const { data } = await admin.from("kho_stock_movements").select("item_id").in("item_id", itemIds);
    const hitItems = new Set((data ?? []).map(r => r.item_id));
    for (const b of bom ?? []) if (hitItems.has(b.item_id)) hasHist.add(v2p.get(b.variant_id));
  }
  const skipped = allLines.filter(l => hasHist.has(l.product_id));
  const lines = allLines.filter(l => !hasHist.has(l.product_id));
  if (skipped.length) await log("shopee_to_db", "new_stock_import", "warn", { note: "Bo qua - SP da co lich su kho, khong lay ton Shopee lam so nhap", skipped: skipped.map(l => ({ label: l.label, qty: l.qty })) });
  if (!lines.length) return { skipped_has_history: skipped.length, _skipped: skipped };
  const d = new Date(Date.now() + 7 * 3600 * 1000).toISOString();
  const code = "PN" + d.slice(2, 10).replace(/-/g, "") + "-" + Math.floor(Math.random() * 900 + 100);
  const qty = lines.reduce((s, l) => s + l.qty, 0);
  const { data: po, error } = await admin.from("kho_purchases").insert({
    code, supplier_id: null, status: "draft", total_cost: 0,
    note: "Tự nhập kho từ tồn Shopee khi đồng bộ sản phẩm mới",
  }).select("id").single();
  if (error || !po) { await log("shopee_to_db", "new_stock_import", "error", { step: "purchase", msg: error?.message }); return { error: error?.message }; }
  const { error: e2 } = await admin.from("kho_purchase_items").insert(lines.map(l => ({
    purchase_id: po.id, variant_id: l.variant_id, variant_label: l.label, qty: l.qty, unit_cost: 0, discount: 0,
  })));
  if (e2) { await admin.from("kho_purchases").delete().eq("id", po.id); await log("shopee_to_db", "new_stock_import", "error", { step: "items", msg: e2.message }); return { error: e2.message }; }
  const { error: e3 } = await admin.rpc("kho_receive_purchase__impl", { p_purchase_id: po.id });
  if (e3) {
    await admin.from("kho_purchase_items").delete().eq("purchase_id", po.id);
    await admin.from("kho_purchases").delete().eq("id", po.id);
    await log("shopee_to_db", "new_stock_import", "error", { step: "receive", msg: e3.message }); return { error: e3.message };
  }
  // So nay vua doc tu Shopee -> khong can day nguoc len lai
  await admin.from("kho_variants").update({ needs_sync_shopee: false }).in("id", lines.map(l => l.variant_id));
  const res = { code, lines: lines.length, qty, skipped_has_history: skipped.length };
  await log("shopee_to_db", "new_stock_import", "success", res);
  return { ...res, _skipped: skipped };
}

async function pullProducts(importStock = false) {
  let offset = 0; const itemIds = [];
  for (let guard = 0; guard < 30; guard++) {
    const j = await shopGet("/api/v2/product/get_item_list", { offset, page_size: 50, item_status: "NORMAL" });
    if (j.error) return { error: j.error, message: j.message };
    const items = j?.response?.item ?? [];
    for (const it of items) itemIds.push(it.item_id);
    if (j?.response?.has_next_page) offset = j.response.next_offset; else break;
  }
  if (!itemIds.length) { await log("shopee_to_db", "pull_products", "success", { items: 0 }); return { items: 0, note: "Shop chua co san pham NORMAL" }; }

  let new_products = 0, new_variants = 0, linked = 0, stocktakes = 0, stocktake_net = 0, ghosts_deleted = 0, ghosts_archived = 0, adoptions = 0;
  const shopeeStock = [];   // {variant_id, stock, label} — ton doc duoc tu Shopee, xu ly sau vong lap
  const newStock = [];      // bien the MOI TAO trong lan dong bo nay -> nhap kho bang phieu nhap (tra duoc lich su)
  // SUA 02/11/2026: chi duoc "nhan lai" SP theo SKU/ten neu SP do CHUA gan tin dang nao, hoac tin dang cu da
  // bien mat khoi Shopee. Truoc day 2 tin dang con song cung item_sku (shop khac MENTG01) bi gop vao 1 SP ->
  // don "phan loai ma" an/xoa nham phan loai cua tin kia.
  const liveItems = new Set(itemIds.map(x => String(x)));
  const freeProd = (rows) => (rows ?? []).find(p => !p.shopee_item_id || !liveItems.has(String(p.shopee_item_id))) ?? null;
  for (let i = 0; i < itemIds.length; i += 50) {
    const batch = itemIds.slice(i, i + 50);
    const j = await shopGet("/api/v2/product/get_item_base_info", { item_id_list: batch.join(",") });
    const list = j?.response?.item_list ?? [];
    for (const it of list) {
      const image = it.image?.image_url_list?.[0] ?? null;
      const itemSku = it.item_sku || null;
      let prod = null; let isNewProd = false;
      { const { data } = await admin.from("kho_products").select("id,sku").eq("shopee_item_id", it.item_id).maybeSingle(); if (data) prod = data; }
      if (!prod && itemSku) { const { data } = await admin.from("kho_products").select("id,sku,shopee_item_id").in("sku", [itemSku, appSku(itemSku)]); const p = freeProd(data); if (p) { prod = p; linked++; } }
      if (!prod) { const { data } = await admin.from("kho_products").select("id,sku,shopee_item_id").eq("name", it.item_name); const p = freeProd(data); if (p) { prod = p; linked++; } }
      if (!prod) {
        // SP MOI tao tren Shopee -> app tu tao SP, SKU = SKU Shopee + "app", lien ket luon
        const { data } = await admin.from("kho_products").insert({ name: it.item_name, sku: appSku(itemSku), image_url: image, images: it.image?.image_url_list ?? [], shopee_item_id: it.item_id, has_variants: !!it.has_model, status: "active" }).select("id,sku").single();
        prod = data; new_products++; isNewProd = true;
      } else {
        const upd = { shopee_item_id: it.item_id, has_variants: !!it.has_model, name: it.item_name };
        if (image) upd.image_url = image;
        // SKU san pham tren Shopee co the duoc dat/sua SAU khi app da tao san pham
        // -> phai dong bo lai, khong chi ghi luc tao moi (truoc day BRU21 bi thieu ma vi loi nay).
        if (itemSku) upd.sku = syncSku(prod.sku, itemSku);
        await admin.from("kho_products").update(upd).eq("id", prod.id);
      }
      if (!prod) continue;
      const prodApp = isNewProd || hasApp(prod.sku);

      if (it.has_model) {
        const mj = await shopGet("/api/v2/product/get_model_list", { item_id: it.item_id });
        const models = mj?.response?.model ?? [];
        const tiers = mj?.response?.tier_variation ?? [];
        // Ung vien "bi thay the": bien the trong app co model_id KHONG con nam trong danh sach model
        // hien tai cua Shopee -> nhieu kha nang chinh la phan loai vua bi xoa & tao lai.
        const liveIds = new Set(models.map(x => String(x.model_id)));
        const { data: allVs } = await admin.from("kho_variants")
          .select("id,sku,variant_name,shopee_model_id").eq("product_id", prod.id).is("archived_at", null);
        const stale = (allVs ?? []).filter(x => !x.shopee_model_id || !liveIds.has(String(x.shopee_model_id)));
        const adopted = new Set();
        for (const m of models) {
          const name = (m.tier_index ?? []).map((idx, ti) => tiers[ti]?.option_list?.[idx]?.option).filter(Boolean).join(" / ") || m.model_sku || ("Model " + m.model_id);
          const sku = m.model_sku || null;
          const price = firstPrice(m.price_info);
          const stock = firstStock(m.stock_info_v2 ?? m.stock_info);
          let vr = null;
          { const { data } = await admin.from("kho_variants").select("id,stock,sku").eq("shopee_model_id", m.model_id).maybeSingle(); if (data) vr = data; }
          if (!vr && sku) { const { data } = await admin.from("kho_variants").select("id,stock,sku").eq("product_id", prod.id).in("sku", [sku, appSku(sku)]).limit(1).maybeSingle(); if (data) vr = data; }
          if (!vr) { const { data } = await admin.from("kho_variants").select("id,stock,sku").eq("product_id", prod.id).eq("variant_name", name).limit(1).maybeSingle(); if (data) vr = data; }
          // Nhan lai phan loai da bi xoa & tao lai: khop SKU chuan hoa (bo dau, bo gach ngang)
          // hoac khop TEN chuan hoa khong ke thu tu thuoc tinh ("One Size / Trang" = "Trang / One Size").
          if (!vr) {
            const cand = stale.find(x => !adopted.has(x.id) && sku && x.sku && normSku(x.sku) === normSku(sku))
                      || stale.find(x => !adopted.has(x.id) && normName(x.variant_name) === normName(name) && normName(name) !== "");
            if (cand) {
              adopted.add(cand.id);
              const { data } = await admin.from("kho_variants").select("id,stock,sku").eq("id", cand.id).maybeSingle();
              if (data) {
                vr = data; adoptions++;
                await log("shopee_to_db", "variant_readopt", "success", {
                  product_id: prod.id, old_name: cand.variant_name, old_sku: cand.sku, old_model_id: cand.shopee_model_id,
                  new_name: name, new_sku: sku, new_model_id: m.model_id,
                });
              }
            }
          }
          // LOP MA HANG: ton THAT nam o kho_items, variants.stock chi la so tinh san.
          // Khong ghi thang ton Shopee vao variant nua — gom lai, xu ly qua applyShopeeStockToItems().
          const payload = { shopee_model_id: m.model_id, variant_name: name, price };
          let isNewVar = false;
          if (vr) { await admin.from("kho_variants").update({ ...payload, sku: (prodApp && sku) ? appSku(sku) : syncSku(vr.sku, sku) }).eq("id", vr.id); }
          else { const { data: nv } = await admin.from("kho_variants").insert({ product_id: prod.id, stock: 0, ...payload, sku: prodApp ? appSku(sku) : sku }).select("id").single(); vr = nv; new_variants++; isNewVar = true; }
          if (isNewVar && vr) { if (stock != null && Number(stock) > 0) newStock.push({ product_id: prod.id, variant_id: vr.id, qty: Number(stock), label: it.item_name + " · " + name }); }
          else if (importStock && stock != null && vr) shopeeStock.push({ variant_id: vr.id, stock: Number(stock), label: String(sku ?? name) });
        }
        const gh = await cleanupGhostVariants(prod.id, models.map(m => m.model_id));
        ghosts_deleted += gh.deleted; ghosts_archived += gh.archived;
      } else {
        const price = firstPrice(it.price_info);
        const stock = firstStock(it.stock_info_v2 ?? it.stock_info);
        let vr = null;
        { const { data } = await admin.from("kho_variants").select("id,stock").eq("product_id", prod.id).limit(1).maybeSingle(); if (data) vr = data; }
        const payload = { price };
        let isNewVar = false;
        if (vr) { await admin.from("kho_variants").update(payload).eq("id", vr.id); }
        else { const { data: nv } = await admin.from("kho_variants").insert({ product_id: prod.id, variant_name: "(mac dinh)", sku: prodApp ? appSku(itemSku) : itemSku, price, stock: 0 }).select("id").single(); vr = nv; new_variants++; isNewVar = true; }
        if (isNewVar && vr) { if (stock != null && Number(stock) > 0) newStock.push({ product_id: prod.id, variant_id: vr.id, qty: Number(stock), label: it.item_name }); }
        else if (importStock && stock != null && vr) shopeeStock.push({ variant_id: vr.id, stock: Number(stock), label: String(itemSku ?? it.item_name) });
      }
    }
  }
  // Sau khi lay ton Shopee lam goc: cac bien the DUNG CHUNG TON (mirror) vua bi ghi de theo tung
  // listing rieng -> co the lech nhau. Chuan hoa lai: ca nhom lay so NHO NHAT (an toan, tranh ban
  // vuot ton) roi danh dau day nguoc len Shopee cho tat ca listing trong nhom.
  // ------------------------------------------------------------------
  // LAY TON SHOPEE LAM GOC -> ghi ve MA HANG KHO (kho_items),
  // BO QUA listing combo (cong thuc nhieu thanh phan hoac qty>1) vi so tren
  // Shopee la so GOI, keo ve se hong ton. Sau do tinh lai co day nguoc.
  // ------------------------------------------------------------------
  // SP MOI (chua co lich su kho): lay ton Shopee lam ton ban dau -> tao 1 PHIEU NHAP HANG (da nhan)
  // SP da co lich su kho: KHONG nhap. Neu dang bam "keo ton tu Shopee" (importStock) thi xu ly nhu cu.
  let new_stock_import = null;
  if (newStock.length) {
    new_stock_import = await importNewStockAsPurchase(newStock);
    if (importStock) for (const l of new_stock_import?._skipped ?? []) shopeeStock.push({ variant_id: l.variant_id, stock: l.qty, label: l.label });
    if (new_stock_import) delete new_stock_import._skipped;
  }

  let imp = { applied: 0, skipped_combo: 0, unchanged: 0, no_bom: 0, net: 0 };
  if (importStock && shopeeStock.length) {
    imp = await applyShopeeStockToItems(shopeeStock);
    stocktakes = imp.applied; stocktake_net = imp.net;
  }

  const result = { items: itemIds.length, new_products, new_variants, linked, import_stock: importStock, stocktakes, stocktake_net, ghosts_deleted, ghosts_archived, adoptions, ma_hang: imp, new_stock_import };
  await log("shopee_to_db", "pull_products", "success", result);
  return result;
}

async function fetchOrderDetail(order_sn) {
  const url = await shopUrl("/api/v2/order/get_order_detail", {
    order_sn_list: order_sn,
    response_optional_fields: "item_list,buyer_username,total_amount,order_status,create_time,pickup_done_time,cancel_reason,cancel_by",
  });
  const r = await fetch(url);
  const j = await r.json();
  return j?.response?.order_list?.[0] ?? null;
}

async function processOrder(order_sn, statusHint, backfill = false) {
  const d = await fetchOrderDetail(order_sn);
  // SUA 02/11/2026: khong lay duoc chi tiet don tu Shopee (API loi tam thoi, token het han, ma don la...)
  // -> KHONG ghi gi ca. Truoc day lay trang thai trong webhook/danh sach (statusHint) de cap nhat don va
  // coi nhu "chua giao" -> don huy SAU khi giao van bi cong lai kho, va webhook gia co the doi trang thai don.
  // Cron pull_orders 20 phut sau se xu ly lai. Rieng backfill (lay don cu) giu cach cu.
  if (!d && !backfill) {
    await log("shopee_to_db", "order_push", "warn", { order_sn, status_hint: statusHint ?? null, action: "skip_khong_lay_duoc_chi_tiet" });
    return { order_sn, status: statusHint ?? null, skipped: true };
  }
  const status = d?.order_status ?? statusHint ?? "UNKNOWN";
  const items = d?.item_list ?? [];
  const { data: existing } = await admin.from("kho_orders").select("id,stock_deducted,buyer_username,total_amount,ordered_at").eq("shopee_order_sn", order_sn).maybeSingle();

  const shipped = Number(d?.pickup_done_time || 0) > 0;
  const cancelInfo = {};
  if (status === "CANCELLED") {
    cancelInfo.cancel_reason = d?.cancel_reason || null;
    cancelInfo.cancel_by = d?.cancel_by || null;
    cancelInfo.shipped = shipped;
    cancelInfo.cancel_type = shipped ? "shipped" : "before_ship";
  }

  let orderId = existing?.id;
  let justInserted = false;
  if (!orderId) {
    const initialDeducted = backfill ? ACTIVE.includes(status) : false;
    const { data: ins } = await admin.from("kho_orders").insert({
      shopee_order_sn: order_sn, status, buyer_username: d?.buyer_username,
      total_amount: d?.total_amount, ordered_at: d?.create_time ? new Date(d.create_time * 1000).toISOString() : null,
      stock_deducted: initialDeducted, raw: d, platform: "shopee", ...cancelInfo,
    }).select("id").single();
    orderId = ins?.id;
    justInserted = !!orderId;
    // Dua tren UNIQUE(shopee_order_sn): neu insert that bai la do tien trinh khac (webhook vs cron)
    // vua tao don nay truoc -> doc lai id va KHONG chen lai order_items.
    if (!orderId) {
      const { data: again } = await admin.from("kho_orders").select("id").eq("shopee_order_sn", order_sn).maybeSingle();
      orderId = again?.id;
      if (!orderId) { await log("shopee_to_db", "order_push", "error", { order_sn, msg: "khong tao duoc don" }); return { order_sn, status }; }
    }
    if (justInserted) await insertOrderItems(orderId, items);
    if (backfill) {
      await log("shopee_to_db", "order_push", "success", { order_sn, status, action: "backfill" });
      return { order_sn, status };
    }
  } else {
    // d = null khi Shopee API loi tam thoi -> KHONG ghi de raw cu bang null.
    const patch = { status, ...cancelInfo };
    if (d) patch.raw = d;
    if (!existing.buyer_username && d?.buyer_username) patch.buyer_username = d.buyer_username;
    if (!existing.total_amount && d?.total_amount) patch.total_amount = d.total_amount;
    if (!existing.ordered_at && d?.create_time) patch.ordered_at = new Date(d.create_time * 1000).toISOString();
    await admin.from("kho_orders").update(patch).eq("id", orderId);

    // Vá đơn cũ thiếu sản phẩm (do lần fetch đầu tiên Shopee trả thiếu item_list)
    if (items.length) {
      const { count } = await admin.from("kho_order_items").select("id", { count: "exact", head: true }).eq("order_id", orderId);
      // Chi va khi don THAT SU chua co dong nao. Neu tien trinh khac dang chen dung luc nay,
      // UNIQUE(order_id,line_no) + upsert ignoreDuplicates dam bao khong bao gio ra 2 bo dong.
      if (!count) await insertOrderItems(orderId, items);
    }

    if (backfill) {
      await log("shopee_to_db", "order_push", "success", { order_sn, status, action: "backfill_update" });
      return { order_sn, status };
    }
  }

  const isCancel = status === "CANCELLED";

  // ===== CHONG TRU KHO 2 LAN =====
  // Webhook cua Shopee va cron pull_orders co the xu ly CUNG 1 don gan nhu cung luc (cach nhau <1s).
  // Truoc day ca 2 tien trinh deu doc stock_deducted = false roi cung tru kho -> tru gap doi.
  // Nay dung "claim" nguyen tu o DB: chi tien trinh nao UPDATE doi duoc co false->true moi duoc tru kho.
  if (!isCancel && ACTIVE.includes(status)) {
    const { data: oitems } = await admin.from("kho_order_items").select("variant_id,qty").eq("order_id", orderId);
    if ((oitems ?? []).length) {
      const { data: claimed } = await admin.from("kho_orders")
        .update({ stock_deducted: true }).eq("id", orderId).eq("stock_deducted", false).select("id");
      if ((claimed ?? []).length) {
        for (const oi of oitems ?? []) if (oi.variant_id) await admin.rpc("kho_adjust_stock", { p_variant_id: oi.variant_id, p_change: -oi.qty, p_reason: "shopee_order", p_direction: "none", p_note: `Don ${order_sn}`, p_origin: "shopee" });
        await log("shopee_to_db", "order_push", "success", { order_sn, status, action: "deduct" });
      } else {
        await log("shopee_to_db", "order_push", "success", { order_sn, status, action: "skip_da_tru_roi" });
      }
    } else {
      await log("shopee_to_db", "order_push", "success", { order_sn, status, action: "skip_chua_co_item" });
    }
  } else if (isCancel) {
    if (shipped) {
      await log("shopee_to_db", "order_push", "success", { order_sn, status, action: "cancel_shipped_no_restock" });
    } else {
      const { data: released } = await admin.from("kho_orders")
        .update({ stock_deducted: false }).eq("id", orderId).eq("stock_deducted", true).select("id");
      if ((released ?? []).length) {
        const { data: oitems } = await admin.from("kho_order_items").select("variant_id,qty").eq("order_id", orderId);
        for (const oi of oitems ?? []) if (oi.variant_id) await admin.rpc("kho_adjust_stock", { p_variant_id: oi.variant_id, p_change: oi.qty, p_reason: "shopee_cancel", p_direction: "none", p_note: `Huy don ${order_sn}`, p_origin: "shopee" });
        await log("shopee_to_db", "order_push", "success", { order_sn, status, action: "restock" });
      } else {
        await log("shopee_to_db", "order_push", "success", { order_sn, status, action: "skip_da_hoan_roi" });
      }
    }
  } else {
    await log("shopee_to_db", "order_push", "success", { order_sn, status, action: "recorded" });
  }
  return { order_sn, status };
}

async function handlePush(req) {
  const raw = await req.text();
  if (raw.length > 200000) return json({ error: "payload too large" }, 413);
  const c = await cfg();
  const base = `${PUBLIC_BASE}|${raw}`;
  const got = req.headers.get("authorization") ?? "";
  const keys = [c.key, ...PUSH_TEST_KEYS].filter(Boolean);
  // Truoc day: thieu header authorization van coi la HOP LE (sigValid = !got). Nay thieu = khong hop le.
  // Tam thoi CHUA chan (de khong lam rot don that neu cong thuc ky cua Shopee khac du kien) — chi ghi log
  // 'webhook_sig_invalid'. Sau vai ngay, neu don that deu hop le -> bat WEBHOOK_ENFORCE = true.
  const WEBHOOK_ENFORCE = false;
  // SUA 02/11/2026: 100% webhook bi coi la sai chu ky -> thu them cac cach ghep URL ma Shopee co the da dung khi ky
  // (URL dang ky tren Shopee co the khac PUBLIC_BASE) va ghi lai cach nao khop (sig_variant) de sau nay bat ENFORCE.
  const bases = [base, `${PUBLIC_BASE}/|${raw}`, `${SB_URL.replace(".supabase.co", ".functions.supabase.co")}/${FN_NAME}|${raw}`, `${req.url}|${raw}`, raw];
  let sigValid = false, sigVariant = null;
  if (got) {
    outer: for (const k of keys) for (let i = 0; i < bases.length; i++) {
      if ((await hmac(k, bases[i])) === got) { sigValid = true; sigVariant = i; break outer; }
    }
  }
  let body = {};
  try { body = JSON.parse(raw); } catch { /* */ }
  if (!sigValid) {
    await log("shopee_to_db", "webhook_sig_invalid", "warn", { code: body?.code ?? null, has_auth: !!got, got_len: got.length, ordersn: body?.data?.ordersn ?? null });
    if (WEBHOOK_ENFORCE) return json({ error: "invalid signature" }, 401);
  } else if (sigVariant !== 0) {
    await log("shopee_to_db", "webhook_sig_variant", "success", { variant: sigVariant });
  }
  if (body.code === 3 && body.data?.ordersn) {
    try { await processOrder(body.data.ordersn, body.data.status); } catch (e) { await log("shopee_to_db", "order_push", "error", { msg: String(e), sig_valid: sigValid }); }
  } else if (body.data?.conversation_id) {
    // Push tin nhan chat (chua ro chinh xac ma "code" Shopee dung cho chat vi tai lieu khong tra cuu duoc
    // luc build tinh nang nay -> nhan dien theo HINH DANG payload thay vi theo code so).
    try { await pullChatMessages(body.data.conversation_id); await pullChatConversations(); } catch (e) { await log("shopee_to_db", "chat_push", "error", { msg: String(e), sig_valid: sigValid, data: JSON.stringify(body.data ?? null).slice(0, 500) }); }
  } else {
    await log("shopee_to_db", "push", "success", { code: body.code, sig_valid: sigValid, data: sigValid ? (body.data ?? null) : JSON.stringify(body.data ?? null).slice(0, 500) });
  }
  return json({ ok: true });
}

// SUA 02/11/2026: cong tac day ton len Shopee (cot settings.push_stock_enabled, mac dinh BAT).
// shop khac TAT (chu shop 02/11: lay ton Shopee lam chuan, app chi de xem bao cao) -> khong goi update_stock.
const PUSH_OFF = { pushed: 0, skipped: 0, disabled: true, note: "Shop dang tat day ton len Shopee (lay Shopee lam chuan)" };
async function pushEnabled() {
  const { data } = await admin.from("kho_settings").select("push_stock_enabled").eq("id", 1).maybeSingle();
  return data?.push_stock_enabled !== false;
}

async function pushStock(productId) {
  if (!(await pushEnabled())) return { ...PUSH_OFF, variants: 0 };
  let variantIds;
  if (productId) {
    const { data: vs } = await admin.from("kho_variants").select("id").eq("product_id", productId);
    variantIds = (vs ?? []).map(v => v.id);
  } else {
    const { data: pend } = await admin.from("kho_stock_movements")
      .select("id,variant_id").eq("direction", "to_shopee").eq("synced", false);
    variantIds = [...new Set((pend ?? []).map(m => m.variant_id))];
  }
  let pushed = 0, skipped = 0; const details = [];
  for (const vid of variantIds) {
    const { data: v } = await admin.from("kho_variants").select("stock,shopee_model_id,product_id,archived_at").eq("id", vid).single();
    if (v?.archived_at) { skipped++; details.push({ vid, skip: "bien the khong con tren Shopee" }); continue; }
    const { data: p } = await admin.from("kho_products").select("shopee_item_id").eq("id", v.product_id).single();
    if (!p?.shopee_item_id) { skipped++; details.push({ vid, skip: "chua lien ket shopee_item_id" }); continue; }
    const stockEntry = { seller_stock: [{ stock: v.stock }] };
    if (v.shopee_model_id) stockEntry.model_id = v.shopee_model_id;
    const url = await shopUrl("/api/v2/product/update_stock");
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ item_id: p.shopee_item_id, stock_list: [stockEntry] }) });
    const j = await r.json();
    if (j.error) { await log("db_to_shopee", "update_stock", "error", { vid, item_id: p.shopee_item_id, j }); details.push({ item_id: p.shopee_item_id, error: j }); skipped++; continue; }
    pushed++;
    details.push({ item_id: p.shopee_item_id, stock: v.stock });
    await log("db_to_shopee", "update_stock", "success", { item_id: p.shopee_item_id, stock: v.stock });
  }
  if (variantIds.length) {
    let q = admin.from("kho_stock_movements").update({ synced: true, synced_at: new Date().toISOString() })
      .eq("direction", "to_shopee").eq("synced", false);
    if (productId) q = q.in("variant_id", variantIds);
    await q;
  }
  return { pushed, skipped, variants: variantIds.length, details };
}

async function pushDirtyShopee(force = false) {
  if (!(await pushEnabled())) return { ...PUSH_OFF, total: 0 };
  let q = admin.from("kho_variants").select("id,stock,shopee_model_id,product_id").is("archived_at", null);
  if (!force) q = q.eq("needs_sync_shopee", true);
  const { data: vs } = await q.limit(200);
  let pushed = 0, skipped = 0; const details = [];
  for (const v of vs ?? []) {
    const { data: p } = await admin.from("kho_products").select("shopee_item_id").eq("id", v.product_id).single();
    if (!p?.shopee_item_id) { skipped++; await admin.from("kho_variants").update({ needs_sync_shopee: false }).eq("id", v.id); continue; }
    const stockEntry = { seller_stock: [{ stock: v.stock }] };
    if (v.shopee_model_id) stockEntry.model_id = v.shopee_model_id;
    const url = await shopUrl("/api/v2/product/update_stock");
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ item_id: p.shopee_item_id, stock_list: [stockEntry] }) });
    const j = await r.json();
    if (j.error) { await log("db_to_shopee", "update_stock", "error", { vid: v.id, item_id: p.shopee_item_id, j }); details.push({ item_id: p.shopee_item_id, error: j }); skipped++; continue; }
    await admin.from("kho_variants").update({ needs_sync_shopee: false }).eq("id", v.id);
    pushed++;
    details.push({ item_id: p.shopee_item_id, stock: v.stock });
    await log("db_to_shopee", "update_stock", "success", { item_id: p.shopee_item_id, stock: v.stock });
  }
  return { pushed, skipped, total: (vs ?? []).length, details };
}

async function pullOrders(days = 7, backfill = false, endDays = 0) {
  const to0 = nowSec() - endDays * 86400; const from0 = nowSec() - days * 86400;
  const WIN = 15 * 86400 - 60;
  let fetched = 0, processed = 0; let lastErr = null;
  for (let f = from0; f < to0; f += WIN) {
    const t2 = Math.min(f + WIN, to0);
    let cursor = "";
    for (let g = 0; g < 40; g++) {
      const extra = { time_range_field: "create_time", time_from: f, time_to: t2, page_size: 50 };
      if (cursor) extra.cursor = cursor;
      const j = await shopGet("/api/v2/order/get_order_list", extra);
      if (j.error) { lastErr = { error: j.error, message: j.message }; break; }
      const list = j?.response?.order_list ?? [];
      fetched += list.length;
      for (const o of list) {
        try { await processOrder(o.order_sn, o.order_status, backfill); processed++; }
        catch (e) { await log("shopee_to_db", "order_push", "error", { order_sn: o.order_sn, msg: String(e) }); }
      }
      if (j?.response?.more && j?.response?.next_cursor) cursor = j.response.next_cursor; else break;
    }
  }
  return { fetched, processed, backfill, error: lastErr };
}

async function classifyCancels(days = 30, force = false) {
  const from = new Date(Date.now() - days * 86400000).toISOString();
  let q = admin.from("kho_orders").select("id,shopee_order_sn").eq("status", "CANCELLED").gte("ordered_at", from).not("shopee_order_sn", "is", null);
  if (!force) q = q.is("cancel_type", null);
  const { data: rows } = await q.limit(300);
  let done = 0, shippedN = 0;
  for (const o of rows ?? []) {
    try {
      const dj = await shopGet("/api/v2/order/get_order_detail", { order_sn_list: o.shopee_order_sn, response_optional_fields: "order_status,cancel_reason,cancel_by,pickup_done_time" });
      const od = dj?.response?.order_list?.[0];
      let shipped = Number(od?.pickup_done_time || 0) > 0;
      if (!shipped) {
        const trk = await shopGet("/api/v2/logistics/get_tracking_info", { order_sn: o.shopee_order_sn });
        const ls = trk?.response?.logistics_status; const ev = trk?.response?.tracking_info ?? [];
        if (ev.length > 0 && ls && ls !== "LOGISTICS_INVALID" && ls !== "LOGISTICS_NOT_STARTED" && ls !== "LOGISTICS_REQUEST_CREATED") shipped = true;
      }
      if (shipped) shippedN++;
      await admin.from("kho_orders").update({
        cancel_reason: od?.cancel_reason || null, cancel_by: od?.cancel_by || null,
        shipped, cancel_type: shipped ? "shipped" : "before_ship",
      }).eq("id", o.id);
      done++;
    } catch { /* */ }
  }
  await log("shopee_to_db", "classify_cancels", "success", { scanned: (rows ?? []).length, done, shipped: shippedN });
  return { scanned: (rows ?? []).length, done, shipped: shippedN };
}

async function pullReturns(days = 30) {
  const to = nowSec(), from = to - days * 86400; const WIN = 15 * 86400 - 120;
  const returns = []; let firstErr = null;
  for (let f = from; f < to; f += WIN) {
    const t2 = Math.min(f + WIN, to);
    for (let p = 0; p < 30; p++) {
      const j = await shopGet("/api/v2/returns/get_return_list", { page_no: p, page_size: 50, create_time_from: f, create_time_to: t2 });
      if (j.error) { if (!firstErr) firstErr = { error: j.error, message: j.message }; break; }
      const list = j?.response?.return ?? j?.response?.return_list ?? [];
      returns.push(...list);
      if (!(j?.response?.more)) break;
    }
  }
  let upserted = 0;
  for (const r of returns) {
    let order_sn = null;
    try { const d = await shopGet("/api/v2/returns/get_return_detail", { return_sn: r.return_sn }); order_sn = d?.response?.order_sn ?? null; } catch { /* */ }
    const items = (r.item ?? []).map((it) => ({ item_id: it.item_id, model_id: it.model_id, name: it.name, variation_sku: it.variation_sku, item_sku: it.item_sku, amount: it.amount, item_price: it.item_price, refund_amount: it.refund_amount, image: (it.images ?? [])[0] ?? null }));
    const row = {
      return_sn: r.return_sn, order_sn, buyer_username: r.user?.username ?? null,
      status: r.status, reason: r.reason, text_reason: r.text_reason,
      refund_amount: r.refund_amount, currency: r.currency,
      return_created_at: r.create_time ? new Date(r.create_time * 1000).toISOString() : null,
      return_updated_at: r.update_time ? new Date(r.update_time * 1000).toISOString() : null,
      needs_logistics: r.needs_logistics ?? null, tracking_number: r.tracking_number || null,
      items, raw: r, updated_at: new Date().toISOString(),
    };
    const { error } = await admin.from("kho_returns").upsert(row, { onConflict: "return_sn" });
    if (!error) upserted++;
  }
  await log("shopee_to_db", "pull_returns", firstErr && !upserted ? "error" : "success", { count: returns.length, upserted, firstErr });
  return { count: returns.length, upserted, firstErr };
}

// ============ SHOPEE CHAT (sellerchat) ============
// QUAN TRONG: conversation_id / message_id la so 19 chu so (vuot Number.MAX_SAFE_INTEGER cua JS) ->
// TUYET DOI khong duoc Number() cac ID nay (mat chinh xac vai chu so cuoi) - luon giu String() xuyen suot,
// Postgres se cast text -> bigint chinh xac o phia server. Da xac nhan bang test that voi shop that.
function chatContentPreview(msg) {
  const t = msg?.message_type;
  if (t === "text") return String(msg?.content?.text ?? "");
  const LABEL = { sticker: "[Nhãn dán]", image: "[Hình ảnh]", images: "[Hình ảnh]", item_card: "[Sản phẩm]", variation_card: "[Sản phẩm]", order: "[Đơn hàng]", voucher: "[Voucher]", video: "[Video]", order_card: "[Đơn hàng]", offer: "[Ưu đãi]", auto_reply: String(msg?.content?.text ?? "[Tự động]") };
  return LABEL[t] || `[${t || "Tin nhắn khác"}]`;
}

async function pullChatConversations(pageSize = 40) {
  let cursor = ""; const all = []; let lastErr = null;
  for (let g = 0; g < 10; g++) {
    const extra = { direction: "older", type: "all", page_size: pageSize };
    if (cursor) extra.next_timestamp = cursor;
    const j = await shopGet("/api/v2/sellerchat/get_conversation_list", extra);
    if (j.error) { lastErr = { error: j.error, message: j.message }; break; }
    const list = j?.response?.conversations ?? j?.response?.conversation_list ?? [];
    all.push(...list);
    const more = j?.response?.more;
    if (more && list.length) cursor = String(list[list.length - 1]?.last_message_timestamp ?? ""); else break;
  }
  if (lastErr && !all.length) { await log("shopee_to_db", "pull_chat_conversations", "error", lastErr); return lastErr; }
  let upserted = 0;
  for (const c of all) {
    const lastText = (c.latest_message_content && typeof c.latest_message_content === "object")
      ? (c.latest_message_type === "text" ? (c.latest_message_content.text ?? "") : chatContentPreview({ message_type: c.latest_message_type, content: c.latest_message_content }))
      : (typeof c.latest_message_content === "string" ? c.latest_message_content : null);
    const row = {
      conversation_id: String(c.conversation_id),
      buyer_id: c.to_id != null ? Number(c.to_id) : null,
      buyer_name: c.to_name || c.to_user_name || null,
      buyer_avatar: c.to_avatar || null,
      last_message_text: lastText,
      last_message_type: c.latest_message_type || null,
      // last_message_timestamp tu Shopee la NANOGIAY tu epoch (khong phai giay hay mili giay)
      last_message_time: c.last_message_timestamp ? new Date(Number(c.last_message_timestamp) / 1e6).toISOString() : null,
      unread_count: c.unread_count ?? 0,
      pinned: !!c.pinned,
      latest_message_id: c.latest_message_id != null ? String(c.latest_message_id) : null,
      raw: c,
      updated_at: new Date().toISOString(),
    };
    const { error } = await admin.from("kho_chat_conversations").upsert(row, { onConflict: "conversation_id" });
    if (!error) upserted++;
  }
  const res = { count: all.length, upserted, lastErr };
  await log("shopee_to_db", "pull_chat_conversations", "success", res);
  return res;
}

async function pullChatMessages(conversationId, pageSize = 30) {
  if (!conversationId) return { error: "thieu conversation_id" };
  const convId = String(conversationId);
  const c = await cfg();
  const myShopId = String(c.s?.shop_id ?? "");
  const j = await shopGet("/api/v2/sellerchat/get_message", { conversation_id: convId, page_size: pageSize });
  if (j.error) { await log("shopee_to_db", "pull_chat_messages", "error", { convId, j }); return { error: j.error, message: j.message }; }
  const list = j?.response?.messages ?? j?.response?.message_list ?? [];
  let upserted = 0; let lastMsgId = null;
  for (const m of list) {
    const row = {
      conversation_id: convId,
      message_id: String(m.message_id),
      direction: String(m.from_shop_id ?? "") === myShopId ? "out" : "in",
      message_type: m.message_type || "text",
      content: chatContentPreview(m),
      raw: m,
      sent_at: m.created_timestamp ? new Date(Number(m.created_timestamp) * 1000).toISOString() : null,
    };
    const { error } = await admin.from("kho_chat_messages").upsert(row, { onConflict: "message_id" });
    if (!error) { upserted++; lastMsgId = row.message_id; }
  }
  if (lastMsgId) {
    await admin.from("kho_chat_conversations").update({ unread_count: 0 }).eq("conversation_id", convId);
    try { await shopPost("/api/v2/sellerchat/read_conversation", { conversation_id: convId, last_read_message_id: lastMsgId }); } catch { /* khong chan */ }
  }
  const res = { count: list.length, upserted };
  await log("shopee_to_db", "pull_chat_messages", "success", { convId, ...res });
  return res;
}

async function sendChatMessage(buyerId, text, conversationId) {
  if (!buyerId) return { error: "thieu buyer_id" };
  if (!text || !String(text).trim()) return { error: "thieu noi dung tin nhan" };
  const body = { to_id: Number(buyerId), message_type: "text", content: { text: String(text) } };
  const j = await shopPost("/api/v2/sellerchat/send_message", body);
  if (j.error) { await log("db_to_shopee", "send_chat_message", "error", { buyerId, j }); return { error: j.error, message: j.message }; }
  const convId = j?.response?.conversation_id != null ? String(j.response.conversation_id) : (conversationId ? String(conversationId) : null);
  const msgId = j?.response?.message_id != null ? String(j.response.message_id) : String(Date.now());
  if (convId) {
    await admin.from("kho_chat_messages").upsert({
      conversation_id: convId, message_id: msgId, direction: "out",
      message_type: "text", content: String(text), raw: j.response, sent_at: new Date().toISOString(),
    }, { onConflict: "message_id" });
    await admin.from("kho_chat_conversations").upsert({
      conversation_id: convId, buyer_id: Number(buyerId), last_message_text: String(text),
      last_message_type: "text", last_message_time: new Date().toISOString(), unread_count: 0, updated_at: new Date().toISOString(),
    }, { onConflict: "conversation_id" });
  }
  await log("db_to_shopee", "send_chat_message", "success", { buyerId, convId, msgId });
  return { ok: true, conversation_id: convId, message_id: msgId };
}

async function fetchEscrow(order_sn) {
  const j = await shopGet("/api/v2/payment/get_escrow_detail", { order_sn });
  return j?.response?.order_income ?? null;
}

async function pullEscrow(limit = 40, force_sn) {
  const rows = [];
  if (force_sn) {
    const { data } = await admin.from("kho_orders").select("id,shopee_order_sn").eq("shopee_order_sn", force_sn).maybeSingle();
    if (data) rows.push(data);
  } else {
    const { data: nulls } = await admin.from("kho_orders").select("id,shopee_order_sn")
      .eq("platform", "shopee").neq("status", "UNPAID").is("escrow_fetched_at", null)
      .not("shopee_order_sn", "is", null)
      .order("ordered_at", { ascending: false }).limit(limit);
    rows.push(...(nulls ?? []));
    if (rows.length < limit) {
      const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { data: stale } = await admin.from("kho_orders").select("id,shopee_order_sn")
        .eq("platform", "shopee").not("status", "in", "(COMPLETED,CANCELLED,UNPAID)")
        .not("shopee_order_sn", "is", null)
        .not("escrow_fetched_at", "is", null).lt("escrow_fetched_at", cutoff)
        .order("ordered_at", { ascending: false }).limit(limit - rows.length);
      rows.push(...(stale ?? []));
    }
  }
  let done = 0, failed = 0;
  for (const o of rows) {
    try {
      const inc = await fetchEscrow(o.shopee_order_sn);
      if (!inc) { failed++; continue; }
      await admin.from("kho_orders").update({
        escrow_amount: inc.escrow_amount ?? null,
        fees: {
          commission_fee: inc.commission_fee ?? 0,
          service_fee: inc.service_fee ?? 0,
          seller_transaction_fee: inc.seller_transaction_fee ?? 0,
          order_ams_commission_fee: inc.order_ams_commission_fee ?? 0,
          withholding_vat_tax: inc.withholding_vat_tax ?? 0,
          withholding_pit_tax: inc.withholding_pit_tax ?? 0,
          voucher_from_seller: inc.voucher_from_seller ?? 0,
          buyer_total_amount: inc.buyer_total_amount ?? 0,
          order_selling_price: inc.order_selling_price ?? 0,
        },
        escrow_fetched_at: new Date().toISOString(),
      }).eq("id", o.id);
      done++;
    } catch { failed++; }
  }
  const res = { scanned: rows.length, done, failed };
  await log("shopee_to_db", "pull_escrow", failed && !done ? "error" : "success", res);
  return res;
}

function vnDay(epochSec) {
  return new Date((epochSec + 7 * 3600) * 1000).toISOString().slice(0, 10);
}

async function walletPage(page_no, from, to) {
  return await shopGet("/api/v2/payment/get_wallet_transaction_list", { page_no, page_size: 40, create_time_from: from, create_time_to: to });
}

async function pullAdSpend(days = 3) {
  const nowVnMs = Date.now() + 7 * 3600 * 1000;
  const startVnMidnightMs = Math.floor(nowVnMs / 86400000) * 86400000 - (days - 1) * 86400000;
  const from = Math.floor(startVnMidnightMs / 1000) - 7 * 3600;
  const to = nowSec();
  const CHUNK = 6 * 86400;
  const txs = [];
  for (let f = from; f < to; f += CHUNK) {
    const t2 = Math.min(f + CHUNK, to);
    for (let p = 0; p < 25; p++) {
      const j = await walletPage(p, f, t2);
      if (j.error) { await log("shopee_to_db", "pull_ad_spend", "error", { error: j.error, message: j.message, from: f, to: t2 }); return { error: j.error, message: j.message }; }
      const list = j?.response?.transaction_list ?? [];
      txs.push(...list);
      if (!j?.response?.more) break;
    }
  }
  const byDay = {};
  for (const t of txs) {
    const txt = JSON.stringify([t.transaction_type, t.reason, t.description, t.transaction_tab_type, t.money_flow]).toLowerCase();
    const isAds = txt.includes("spm_deduct") || txt.includes("ads") || txt.includes("quang cao") || txt.includes("quảng cáo");
    if (!isAds) continue;
    const amt = Number(t.amount ?? 0);
    if (amt >= 0) continue;
    const d = vnDay(Number(t.create_time ?? 0));
    byDay[d] = (byDay[d] ?? 0) + Math.abs(amt);
  }
  let ads_days = 0;
  for (const [d, amount] of Object.entries(byDay)) {
    await admin.from("kho_ad_spend").upsert({ spend_date: d, amount, source: "wallet", updated_at: new Date().toISOString() }, { onConflict: "spend_date" });
    ads_days++;
  }
  const adjRows = [];
  for (const t of txs) {
    const txt = `${t.transaction_type ?? ""} ${t.reason ?? ""} ${t.description ?? ""}`.toLowerCase();
    const isAdj = txt.includes("adjust") || txt.includes("điều chỉnh") || txt.includes("dieu chinh");
    if (!isAdj) continue;
    let sn = String(t.order_sn ?? "").trim();
    if (!sn || sn === "-") { const m = String(t.description ?? "").match(/\b(\d{6}[A-Z0-9]{6,10})\b/); sn = m ? m[1] : ""; }
    if (!sn) continue;
    adjRows.push({ transaction_id: Number(t.transaction_id) || 0, order_sn: sn, amount: Number(t.amount) || 0, txn_time: t.create_time ? new Date(Number(t.create_time) * 1000).toISOString() : null, description: String(t.description ?? "").slice(0, 300) });
  }
  let adj_orders = 0;
  if (adjRows.length) {
    await admin.from("kho_wallet_adjustments").upsert(adjRows, { onConflict: "transaction_id" });
    const sns = [...new Set(adjRows.map(a => a.order_sn))];
    for (const sn of sns) {
      const { data: sums } = await admin.from("kho_wallet_adjustments").select("amount").eq("order_sn", sn);
      const total = (sums ?? []).reduce((s, a) => s + (Number(a.amount) || 0), 0);
      await admin.from("kho_orders").update({ wallet_adjustment: total }).eq("shopee_order_sn", sn);
      adj_orders++;
    }
  }
  const res = { transactions: txs.length, ads_days, adj_found: adjRows.length, adj_orders, byDay };
  await log("shopee_to_db", "pull_ad_spend", "success", res);
  return res;
}

const ADMIN_ACTIONS = new Set(["save_partner", "disconnect", "auth_url", "refresh", "push_stock", "push_dirty", "pull_products", "dump_shopee_stock", "backup_run", "backup_list", "pull_orders", "status", "pull_escrow", "pull_ad_spend", "pull_finance", "wallet_test", "escrow_raw", "pull_returns", "classify_cancels", "upload_image", "resync_order", "pull_chat_conversations", "pull_chat_messages", "send_chat_message"]);

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  if (req.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" } });
  try {
    if (req.method === "POST" && !action) return await handlePush(req);

    if (action && ADMIN_ACTIONS.has(action)) {
      if (!(await isCron(req)) && !(await isOwner(req))) return json({ error: "Unauthorized" }, 401);
    }

    // ===== Màn "Kết nối Shopee": lưu Partner ID / Partner Key / môi trường (chỉ chủ shop) =====
    if (action === "save_partner") {
      const b = await req.json().catch(() => ({}));
      const pid = Number(String(b?.partner_id ?? "").trim());
      if (!Number.isInteger(pid) || pid <= 0) return json({ error: "Partner ID phải là số (lấy ở Shopee Open Platform › App)" }, 400);
      const env = b?.environment === "sandbox" ? "sandbox" : "live";
      const key = String(b?.partner_key ?? "").trim();
      const c0 = await cfg();
      if (!key && !c0.key) return json({ error: "Cần nhập Partner Key" }, 400);
      const changed = Number(c0.s?.partner_id) !== pid || (c0.s?.environment ?? "") !== env || (!!key && key !== c0.key);
      const now = new Date().toISOString();
      const upd = { partner_id: pid, environment: env, function_url: PUBLIC_BASE, updated_at: now };
      if (typeof b?.app_url === "string" && /^https?:\/\//i.test(b.app_url)) upd.app_url = b.app_url.slice(0, 300);
      if (changed) { upd.shop_id = null; upd.shop_name = null; }
      await admin.from("kho_settings").update(upd).eq("id", 1);
      const aupd = { updated_at: now };
      if (key) aupd.partner_key = key;
      if (changed) { aupd.access_token = null; aupd.refresh_token = null; aupd.token_expire_at = null; }
      await admin.from("kho_auth").update(aupd).eq("id", 1);
      await log("db_to_shopee", "save_partner", "success", { partner_id: pid, environment: env, reset_connection: changed });
      return json({ ok: true, need_connect: changed || !c0.a?.access_token });
    }
    if (action === "disconnect") {
      await admin.from("kho_auth").update({ access_token: null, refresh_token: null, token_expire_at: null, updated_at: new Date().toISOString() }).eq("id", 1);
      await admin.from("kho_settings").update({ shop_id: null, shop_name: null, updated_at: new Date().toISOString() }).eq("id", 1);
      await log("db_to_shopee", "disconnect", "success", {});
      return json({ ok: true });
    }

    if (action === "auth_url") {
      const app = url.searchParams.get("app");
      if (app && /^https?:\/\//i.test(app)) await admin.from("kho_settings").update({ app_url: app.slice(0, 300), function_url: PUBLIC_BASE }).eq("id", 1);
      const c = await cfg();
      if (!c.partner_id || !c.key) return json({ error: "Chua co partner_id/partner_key" }, 400);
      const path = "/api/v2/shop/auth_partner";
      const t = nowSec();
      const sign = await hmac(c.key, `${c.partner_id}${path}${t}`);
      const state = crypto.randomUUID().replace(/-/g, "");
      await admin.from("kho_auth").update({ auth_state: state, auth_state_at: new Date().toISOString() }).eq("id", 1);
      const redirect = `${PUBLIC_BASE}?action=callback&state=${state}`;
      const authUrl = `${c.host}${path}?partner_id=${c.partner_id}&timestamp=${t}&sign=${sign}&redirect=${encodeURIComponent(redirect)}`;
      if (url.searchParams.get("go") === "1") return Response.redirect(authUrl, 302);
      return json({ auth_url: authUrl, note: "Mo trong vong 5 phut" });
    }

    if (action === "callback") {
      const code = url.searchParams.get("code");
      const shop_id = url.searchParams.get("shop_id");
      if (!code || !shop_id) return appRedirect("shopee_error=" + encodeURIComponent("Thieu code hoac shop_id"));
      // chỉ nhận cấp quyền do chính chủ shop bấm trong app (state khớp, còn hạn 30 phút, dùng 1 lần)
      const st = url.searchParams.get("state") ?? "";
      const { data: au } = await admin.from("kho_auth").select("auth_state,auth_state_at").eq("id", 1).maybeSingle();
      const fresh = !!au?.auth_state_at && (Date.now() - new Date(au.auth_state_at).getTime()) < 30 * 60 * 1000;
      if (!st || !au?.auth_state || st !== au.auth_state || !fresh) {
        await log("db_to_shopee", "auth", "error", { reason: "state_khong_khop" });
        return appRedirect("shopee_error=" + encodeURIComponent("Link cap quyen khong hop le hoac het han. Bam Ket noi shop Shopee lai trong app."));
      }
      await admin.from("kho_auth").update({ auth_state: null, auth_state_at: null }).eq("id", 1);
      const c = await cfg();
      const path = "/api/v2/auth/token/get";
      const t = nowSec();
      const sign = await hmac(c.key, `${c.partner_id}${path}${t}`);
      const resp = await fetch(`${c.host}${path}?partner_id=${c.partner_id}&timestamp=${t}&sign=${sign}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, shop_id: Number(shop_id), partner_id: c.partner_id }),
      });
      const j = await resp.json();
      if (j.error) { await log("db_to_shopee", "auth", "error", j); return appRedirect("shopee_error=" + encodeURIComponent(j.message || j.error)); }
      await admin.from("kho_auth").update({
        access_token: j.access_token, refresh_token: j.refresh_token,
        token_expire_at: new Date((nowSec() + (j.expire_in ?? 14400)) * 1000).toISOString(), updated_at: new Date().toISOString(),
      }).eq("id", 1);
      await admin.from("kho_settings").update({ shop_id: Number(shop_id), updated_at: new Date().toISOString() }).eq("id", 1);
      try {
        const info = await shopGet("/api/v2/shop/get_shop_info");
        if (info?.shop_name) await admin.from("kho_settings").update({ shop_name: String(info.shop_name).slice(0, 200) }).eq("id", 1);
      } catch (_) { /* không có tên shop cũng không sao */ }
      await log("db_to_shopee", "auth", "success", { shop_id });
      return appRedirect("connected=" + encodeURIComponent(shop_id));
    }

    if (action === "refresh") return json({ access_token_renewed: !!(await refreshToken()) });
    if (action === "push_stock") return json(await pushStock(url.searchParams.get("product_id")));
    if (action === "push_dirty") return json(await pushDirtyShopee(url.searchParams.get("force") === "1"));
    if (action === "pull_products") {
      const imp = url.searchParams.get("import_stock") === "1";
      const r = await pullProducts(imp);
      // Sau khi lay ton Shopee lam goc, day ngay so da chuan hoa cua cac nhom dung chung ton len san.
      if (imp && !r?.error) { try { r.push = await pushDirtyShopee(); } catch { /* khong chan */ } }
      return json(r);
    }
    if (action === "backup_run" || action === "dump_shopee_stock") {
      return json(await backupRun(
        url.searchParams.get("kind") ?? (action === "dump_shopee_stock" ? "manual" : "auto"),
        url.searchParams.get("label"),
        url.searchParams.get("note")));
    }
    if (action === "backup_list") {
      const { data, error } = await admin.rpc("kho_backup_list", { p_limit: Number(url.searchParams.get("limit") ?? 30) });
      if (error) return json({ error: error.message }, 500);
      return json({ backups: data ?? [] });
    }
    if (action === "pull_orders") {
      const backfill = url.searchParams.get("backfill") === "1";
      const r = await pullOrders(Number(url.searchParams.get("days") ?? 7), backfill, Number(url.searchParams.get("end_days") ?? 0));
      if (!backfill) { try { await pullEscrow(40); await pullAdSpend(3); await pushDirtyShopee(); await classifyCancels(3); await pullReturns(20); } catch { /* khong chan pull_orders */ } }
      return json(r);
    }
    if (action === "resync_order") return json(await processOrder(url.searchParams.get("order_sn") ?? "", null, true));
    if (action === "pull_escrow") return json(await pullEscrow(Number(url.searchParams.get("limit") ?? 40), url.searchParams.get("order_sn")));
    if (action === "pull_ad_spend") return json(await pullAdSpend(Number(url.searchParams.get("days") ?? 3)));
    if (action === "pull_finance") return json({ escrow: await pullEscrow(Number(url.searchParams.get("limit") ?? 40)), ad_spend: await pullAdSpend(Number(url.searchParams.get("days") ?? 3)) });
    if (action === "pull_returns") return json(await pullReturns(Number(url.searchParams.get("days") ?? 30)));
    if (action === "classify_cancels") return json(await classifyCancels(Number(url.searchParams.get("days") ?? 30), url.searchParams.get("force") === "1"));
    if (action === "wallet_test") {
      const fromP = url.searchParams.get("from"); const toP = url.searchParams.get("to");
      const days = Number(url.searchParams.get("days") ?? 3);
      const to = toP ? Number(toP) : nowSec(); const from = fromP ? Number(fromP) : to - days * 86400;
      return json(await walletPage(Number(url.searchParams.get("page") ?? 0), from, to));
    }
    if (action === "escrow_raw") return json(await shopGet("/api/v2/payment/get_escrow_detail", { order_sn: url.searchParams.get("order_sn") ?? "" }));
    if (action === "status") {
      const c = await cfg();
      if (c.s && c.s.function_url !== PUBLIC_BASE) await admin.from("kho_settings").update({ function_url: PUBLIC_BASE }).eq("id", 1);
      return json({ environment: c.s?.environment, host: c.host, partner_id: c.partner_id || null, shop_id: c.s?.shop_id ?? null, shop_name: c.s?.shop_name ?? null,
        connected: !!c.a?.access_token && !!c.s?.shop_id, has_key: !!c.key, token_expire_at: c.a?.token_expire_at ?? null,
        last_order_sync: c.s?.last_order_sync ?? null, push_stock_enabled: c.s?.push_stock_enabled !== false,
        function_url: PUBLIC_BASE, redirect_domain: new URL(PUBLIC_BASE).host, app_url: c.s?.app_url ?? null });
    }
    if (action === "pull_chat_conversations") return json(await pullChatConversations());
    if (action === "pull_chat_messages") return json(await pullChatMessages(url.searchParams.get("conversation_id")));
    if (action === "send_chat_message") {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      const b = await req.json();
      return json(await sendChatMessage(b.buyer_id, b.text, b.conversation_id));
    }
    if (action === "upload_image") {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      return json(await uploadImage(req));
    }

    return json({ ok: true, service: "kho-shopee-sync" });
  } catch (e) {
    await log("db_to_shopee", action ?? "unknown", "error", { msg: String(e) });
    return json({ error: String(e) }, 500);
  }
});
