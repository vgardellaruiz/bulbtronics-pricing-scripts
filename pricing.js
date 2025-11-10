import { getPool, sql } from "./db.js";

// Helpers
const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;
const toDecimal = (n) => Number.parseFloat(n ?? 0);

// Construye "hoy 00:00" para replicar DateTime.Today del C#
function todayAtMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// ---- QUERIES ----
export async function getSpecialPricingCust({
  custId,
  buyingGroup,
  status = "A", // "A" = modo normal con filtro por fecha; "I" = exacto por SKU sin filtro de fecha (igual que C#)
  sku = "X",
}) {
  const pool = await getPool();
  const today = todayAtMidnight();

  // CI = customer individual
  const paramsCI = pool
    .request()
    .input("custid", sql.VarChar, custId)
    .input("SKU", sql.VarChar, sku)
    .input("today", sql.DateTime, today);

  const sqlCI =
    status === "I"
      ? `
        SELECT *
        FROM specpr
        WHERE SPECPR_TYPE = 'CI'
          AND SPECPR_KEY = @custid
          AND SPECPR_SKU = @SKU
          AND SPECPR_APPROVER IS NOT NULL
          AND LTRIM(RTRIM(SPECPR_APPROVER)) <> ''
      `
      : `
        SELECT *
        FROM specpr
        WHERE SPECPR_TYPE = 'CI'
          AND SPECPR_KEY = @custid
          AND SPECPR_EXPIRE_DATE > @today
          AND SPECPR_APPROVER IS NOT NULL
          AND LTRIM(RTRIM(SPECPR_APPROVER)) <> ''
      `;

  const rsCI = await paramsCI.query(sqlCI);

  // GP = group pricing
  const paramsGP = pool
    .request()
    .input("groupid", sql.VarChar, buyingGroup)
    .input("SKU", sql.VarChar, sku)
    .input("today", sql.DateTime, today);

  const sqlGP =
    status === "I"
      ? `
        SELECT *
        FROM specpr
        WHERE SPECPR_TYPE = 'GP'
          AND SPECPR_KEY = @groupid
          AND SPECPR_SKU = @SKU
          AND SPECPR_APPROVER IS NOT NULL
          AND LTRIM(RTRIM(SPECPR_APPROVER)) <> ''
      `
      : `
        SELECT *
        FROM specpr
        WHERE SPECPR_TYPE = 'GP'
          AND SPECPR_KEY = @groupid
          AND SPECPR_EXPIRE_DATE > @today
          AND SPECPR_APPROVER IS NOT NULL
          AND LTRIM(RTRIM(SPECPR_APPROVER)) <> ''
      `;

  const rsGP = await paramsGP.query(sqlGP);

  // Unión de CI ∪ GP
  return [...rsCI.recordset, ...rsGP.recordset];
}

export async function getProdPricingCust({ custCat }) {
  const pool = await getPool();
  let cat = custCat ?? "";
  if (cat.length === 2) cat += " "; // igual que el C#

  const rs = await pool
    .request()
    .input("custcat", sql.VarChar, cat)
    .query(`SELECT * FROM price WHERE price_cust_cat = @custcat`);

  return rs.recordset;
}

// ---- LOGIC ----
export async function checkSpecialProdPrice({
  inProdSku,
  isMemberNull,
  custId,
  buyingGroup,
  custCategory,
}) {
  // C#: GetPricingTable(...) decide defaults según isMemberNull / faltantes
  const useDefaults = isMemberNull || (!custCategory && !buyingGroup);

  const spTable = await getSpecialPricingCust({
    custId: useDefaults ? "106565" : custId,
    buyingGroup: useDefaults ? "IHU" : buyingGroup,
    // status = "A" (modo normal con filtro de fecha); si necesitás modo "I", pasalo como parámetro adicional
  });

  // Primero CI (cliente), luego GP (grupo), con aprobador ya validado en SQL
  for (const row of spTable) {
    if (
      (row.SPECPR_TYPE ?? "").toString().trim() === "CI" &&
      (row.SPECPR_SKU ?? "").toString().trim() ===
        (inProdSku ?? "").toString().trim()
    ) {
      return {
        found: true,
        price: toDecimal(row.SPECPR_PRICE),
        contractRef: String(row.SPECPR_CONTRACT_REF ?? ""),
        contractCost: toDecimal(row.SPECPR_CONTRACT_COST),
      };
    }
  }
  for (const row of spTable) {
    if (
      (row.SPECPR_TYPE ?? "").toString().trim() === "GP" &&
      (row.SPECPR_SKU ?? "").toString().trim() ===
        (inProdSku ?? "").toString().trim()
    ) {
      return {
        found: true,
        price: toDecimal(row.SPECPR_PRICE),
        contractRef: String(row.SPECPR_CONTRACT_REF ?? ""),
        contractCost: toDecimal(row.SPECPR_CONTRACT_COST),
      };
    }
  }

  return { found: false };
}

export async function getProdMarkup({
  inProdCat,
  custCategory,
  PRICETIER,
  PRICEMARKUP,
}) {
  // Cargar la tabla de markups por CATEGORÍA DE CLIENTE (WP2, DLR, etc.)
  const prodPriceTable = await getProdPricingCust({
    custCat: custCategory ?? "WP2",
  });

  for (const row of prodPriceTable) {
    if (
      String(row.PRICE_PROD_CAT ?? "").trim() === String(inProdCat ?? "").trim()
    ) {
      const tier =
        Number(PRICETIER) === 0
          ? String(row.PRICE_DEFAULT_LEVEL ?? "").trim()
          : String(PRICETIER).trim();

      // "PRICE_MARKUP" + tier (ej: PRICE_MARKUP1)
      let col = `PRICE_MARKUP${tier}`;
      let val = Number(row[col] ?? 0);

      if (val === 0) {
        // Fallback del C#: usar PRICE_SELECTIONS
        col = `PRICE_MARKUP${row.PRICE_SELECTIONS}`;
        val = Number(row[col] ?? 0);
      }

      // C#: valorDeTabla + (PRICEMARKUP * 100)
      return Number(val) + Number(PRICEMARKUP) * 100;
    }
  }

  // Si no encuentra fila de esa categoría de producto en la tabla del cliente
  return 999999.99;
}

export async function getPrice({
  prodID,
  prod_sku,
  category,
  ref_Cost,
  maxSellPrice,
  isMemberNull,
  custId,
  buyingGroup,
  PRICETIER,
  PRICEMARKUP,
  custcategory,
  mapSellPrice = 0,
}) {
  // 1) Precio especial (CI/GP) aprobado y vigente
  const spec = await checkSpecialProdPrice({
    inProdSku: prod_sku,
    isMemberNull,
    custId,
    buyingGroup,
    custCategory: custcategory,
  });
  if (spec.found) {
    return Number(spec.price.toFixed(2));
  }

  // 2) Markup por categoría
  const prodmarkup = await getProdMarkup({
    inProdCat: category,
    custCategory: custcategory,
    PRICETIER,
    PRICEMARKUP,
  });

  const prodcost = toDecimal(ref_Cost);
  let prodprice = round3((prodmarkup * prodcost) / 100);
  let maxprice = toDecimal(maxSellPrice);

  // 3) Marca comparativa "WP2"
  const qbprodmarkup = await getProdMarkup({
    inProdCat: "WP2",
    custCategory: custcategory,
    PRICETIER,
    PRICEMARKUP,
  });
  const qbprodcost = toDecimal(ref_Cost);
  const qbprodprice = round3((qbprodmarkup * qbprodcost) / 100);

  if (qbprodprice < maxprice || maxprice === 0) {
    maxprice = qbprodprice;
  }
  if (maxprice === 0) {
    maxprice = qbprodprice;
  }

  // 4) MAP
  if (qbprodprice < toDecimal(mapSellPrice)) {
    prodprice = toDecimal(mapSellPrice);
  }
  if (toDecimal(mapSellPrice) > 0 && prodprice < toDecimal(mapSellPrice)) {
    prodprice = toDecimal(mapSellPrice);
  }

  // 5) Tope por maxprice
  if (prodprice > maxprice && maxprice > 0) {
    prodprice = maxprice;
  }

  // formato final con 2 decimales
  return Number(prodprice.toFixed(2));
}
