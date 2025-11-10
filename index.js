import { getPool } from "./db.js";
import { getPrice } from "./pricing.js";
import { createObjectCsvWriter } from "csv-writer";

// ---------- Config rápida para probar ----------
const CLIENTS_LIMIT = parseInt(process.env.CLIENTS_LIMIT ?? "50", 10); // subí luego
const PRODUCTS_LIMIT = parseInt(process.env.PRODUCTS_LIMIT ?? "200", 10); // subí luego
const CUST_FILTER = (process.env.CUST_FILTER ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean); // ej: "106565,123456"
const OUTPUT = process.env.OUTPUT ?? "prices_long.csv"; // formato largo recomendado
// ----------------------------------------------

async function fetchCustomers() {
  const pool = await getPool();
  if (CUST_FILTER.length > 0) {
    const inList = CUST_FILTER.map((_, i) => `@id${i}`).join(",");
    const req = pool.request();
    CUST_FILTER.forEach((id, i) => req.input(`id${i}`, id));
    const { recordset } = await req.query(`
      SELECT
        CUSTID,
        NULLIF(LTRIM(RTRIM(CUSTGROUPCODE)), '')   AS BuyingGroup,
        NULLIF(LTRIM(RTRIM(CUSTCATEGORY)), '')    AS CustCategory,
        ISNULL(CUSTPRICETIER, 0)                  AS PriceTier,
        ISNULL(CUSTPRICEMARKUP, 0)                AS PriceMarkup,
        CUSTMEMBERNUM
      FROM dbo.cust
      WHERE CUSTID IN (${inList})
    `);
    return recordset;
  } else {
    const { recordset } = await pool.request().query(`
      SELECT TOP (${CLIENTS_LIMIT})
        CUSTID,
        NULLIF(LTRIM(RTRIM(CUSTGROUPCODE)), '')   AS BuyingGroup,
        NULLIF(LTRIM(RTRIM(CUSTCATEGORY)), '')    AS CustCategory,
        ISNULL(CUSTPRICETIER, 0)                  AS PriceTier,
        ISNULL(CUSTPRICEMARKUP, 0)                AS PriceMarkup,
        CUSTMEMBERNUM
      FROM dbo.cust
      WHERE CUSTID IS NOT NULL
      ORDER BY CUSTID
    `);
    return recordset;
  }
}

async function fetchProducts() {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`
    WITH ProductsWithWH1 AS (
      SELECT DISTINCT p.PROD_SKU
      FROM dbo.Prod p
      WHERE p.PROD_LOCATION = 1
        AND (p.PROD_STATUS = 'N' OR (p.PROD_STATUS = 'D' AND p.RECD - p.USED > 0))
        AND p.CATEGORY <> 'NONE'
        AND p.PROD_SKU_CLASS = 'N'
    ),
    RolledUpProducts AS (
      SELECT 
        MAX(CASE WHEN p.PROD_LOCATION = 1 THEN p.ID END)                 AS ID,
        MAX(CASE WHEN p.PROD_LOCATION = 1 THEN p.CATEGORY END)           AS CATEGORY,
        p.PROD_SKU                                                       AS PROD_SKU,
        MAX(CASE WHEN p.PROD_LOCATION = 1 THEN p.REF_COST END)           AS REF_COST,
        MAX(CASE WHEN p.PROD_LOCATION = 1 THEN p.PROD_MAX_SELLPRICE END) AS PROD_MAX_SELLPRICE,
        MAX(CASE WHEN p.PROD_LOCATION = 1 THEN p.PROD_MAP_SELLPRICE END) AS PROD_MAP_SELLPRICE
      FROM dbo.Prod p
      INNER JOIN ProductsWithWH1 wh1 ON p.PROD_SKU = wh1.PROD_SKU
      WHERE (p.PROD_STATUS = 'N' OR (p.PROD_STATUS = 'D' AND p.RECD - p.USED > 0))
        AND p.PROD_LOCATION IN (1, 2, 5, 7)
        AND p.CATEGORY <> 'NONE'
      GROUP BY p.PROD_SKU
    )
    SELECT TOP (${PRODUCTS_LIMIT})
      ID,
      CATEGORY,
      PROD_SKU,
      REF_COST,
      ISNULL(PROD_MAX_SELLPRICE, 0) AS PROD_MAX_SELLPRICE,
      ISNULL(PROD_MAP_SELLPRICE, 0) AS PROD_MAP_SELLPRICE
    FROM RolledUpProducts
    WHERE REF_COST IS NOT NULL
    ORDER BY PROD_SKU;
  `);
  return recordset;
}

function buildCustomerContext(row) {
  const isMemberNull = !row.CUSTMEMBERNUM; // igual que tu C#
  return {
    custId: row.CUSTID,
    buyingGroup: row.BuyingGroup,
    custcategory: row.CustCategory,
    PRICETIER: String(row.PriceTier ?? "0"),
    PRICEMARKUP: Number(row.PriceMarkup ?? 0),
    isMemberNull,
  };
}

async function main() {
  const customers = await fetchCustomers();
  const products = await fetchProducts();

  if (customers.length === 0) {
    console.log("No hay clientes para procesar.");
    return;
  }
  if (products.length === 0) {
    console.log("No hay productos para procesar.");
    return;
  }

  const csvWriter = createObjectCsvWriter({
    path: OUTPUT,
    header: [
      { id: "CUSTID", title: "CUSTID" },
      { id: "SKU", title: "SKU" },
      { id: "CATEGORY", title: "CATEGORY" },
      { id: "REF_COST", title: "REF_COST" },
      { id: "MAX_SELLPRICE", title: "MAX_SELLPRICE" },
      { id: "MAP", title: "MAP" },
      { id: "FINAL_PRICE", title: "FINAL_PRICE" },
    ],
    append: false,
    alwaysQuote: true,
  });

  const batch = [];
  let rowsWritten = 0;

  for (const c of customers) {
    const ctx = buildCustomerContext(c);

    for (const p of products) {
      const price = await getPrice({
        prodID: p.ID,
        prod_sku: p.PROD_SKU,
        category: p.CATEGORY,
        ref_Cost: p.REF_COST,
        maxSellPrice: p.PROD_MAX_SELLPRICE,
        isMemberNull: ctx.isMemberNull,
        custId: ctx.custId,
        buyingGroup: ctx.buyingGroup,
        PRICETIER: ctx.PRICETIER,
        PRICEMARKUP: ctx.PRICEMARKUP,
        custcategory: ctx.custcategory,
        mapSellPrice: p.PROD_MAP_SELLPRICE,
      });

      batch.push({
        CUSTID: ctx.custId,
        SKU: String(p.PROD_SKU).trim(),
        CATEGORY: p.CATEGORY,
        REF_COST: p.REF_COST,
        MAX_SELLPRICE: p.PROD_MAX_SELLPRICE,
        MAP: p.PROD_MAP_SELLPRICE,
        FINAL_PRICE: price,
      });

      // flush por bloques para no comer RAM
      if (batch.length >= 2000) {
        await csvWriter.writeRecords(batch);
        rowsWritten += batch.length;
        batch.length = 0;
        process.stdout.write(`Escritas ${rowsWritten} filas...\r`);
      }
    }
  }

  if (batch.length > 0) {
    await csvWriter.writeRecords(batch);
    rowsWritten += batch.length;
  }

  console.log(
    `\n✔ Listo. Archivo ${OUTPUT} con ${rowsWritten} filas (formato largo)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
