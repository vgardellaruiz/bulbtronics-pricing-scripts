# Catalog Rollup Architecture - Context

## Why This Exists

The original shared catalog design created one catalog per unique combination of `CUSTCATEGORY|CUSTPRICETIER|CUSTPRICEMARKUP|CUSTGROUPCODE`, resulting in ~800–900 shared catalogs. Many customer categories had identical markups in the `price` table, making their catalogs redundant. The rollup consolidates those categories into a smaller set of logical catalog groups, dramatically reducing catalog count and Celigo processing time.

---

## New Catalog Structure

| Type | Count | Description |
|------|-------|-------------|
| **Rollup Shared (C01–C05)** | 5 groups × 8 tiers = **40 catalogs** | Standard 8-tier pricing, each group covers multiple CUSTCATEGORY values with identical markups |
| **Rollup Shared (R01)** | **1 catalog** | Single-tier only, uses `PRICE_DEFAULT_LEVEL` for markup lookup |
| **Individual** | ~200–300 | Unchanged — one per customer with active CI special pricing |

**Total shared catalogs (approx):** 41 (vs. ~800–900 previously)

---

## CATGOR Table

This table is the source of truth for the rollup mapping.

### Key Fields

| Field | Description |
|-------|-------------|
| `CATGOR_OLD_CATEGORY` | The original customer category code (same as `CUSTCATEGORY` in `cust` table) |
| `CATGOR_CATALOG_ROLLUP` | The new rollup catalog code this category maps to (e.g., `C03`, `R01`) |
| `CATGOR_CLASS` | Customer class / segment description |
| `CATGOR_MARKET_GROUP` | Market group label |
| `CATGOR_CUSTOMER_TYPE` | Customer type description |
| `CATGOR_DISABLED` | Whether the category is disabled (`Y`/`N`) |

### Example Record

```json
{
  "CATGOR_OLD_CATEGORY": "E15",
  "CATGOR_CLASS": "TRANSPORTATION",
  "CATGOR_CATALOG_ROLLUP": "C03"
}
```

---

## Catalog Unique Key (Rollup Shared)

```
CATGOR_CATALOG_ROLLUP | CUSTPRICETIER
```

- **`CATGOR_CATALOG_ROLLUP`** — the rolled-up catalog group (C01–C05, R01)
- **`CUSTPRICETIER`** — the customer's pricing tier (1–8 for C-catalogs; uses `PRICE_DEFAULT_LEVEL` for R01)

Each Celigo flow still processes one product category at a time to stay within timeout limits, so the processing key is effectively:

```
CATGOR_CATALOG_ROLLUP | CUSTPRICETIER | PROD_CATEGORY
```

---

## Markup Lookup for Rollup Catalogs

Since all categories grouped under a rollup code share the same markups, you only need one representative `CUSTCATEGORY` to look up the markup matrix.

### Step 1 — Get a representative category for the rollup group

```sql
SELECT DISTINCT TOP 1 LTRIM(RTRIM(CATGOR_OLD_CATEGORY)) AS RepCategory
FROM dbo.CATGOR
WHERE LTRIM(RTRIM(CATGOR_CATALOG_ROLLUP)) = @RollupCode
```

### Step 2 — Query the price table using that category

```sql
SELECT *
FROM dbo.price
WHERE price_cust_cat = @RepCategory
  AND LTRIM(RTRIM(PRICE_PROD_CAT)) = @ProductCategory
```

This returns the same markup row that would have been used for any of the categories in the group (they are identical by design).

### R01 — Single Tier

R01 uses `PRICE_DEFAULT_LEVEL` from the retrieved markup row as the tier selector, equivalent to `CUSTPRICETIER = 0` in the existing pricing logic.

---

## Customer Assignment to Rollup Catalogs

Customers are assigned to a rollup catalog based on:

1. **Look up their `CUSTCATEGORY`** in the `CATGOR` table via `CATGOR_OLD_CATEGORY`
2. **Read `CATGOR_CATALOG_ROLLUP`** → this is their catalog group
3. **Combine with `CUSTPRICETIER`** → this identifies their specific catalog within the group

```sql
SELECT c.CUSTID, c.CUSTPRICETIER, cg.CATGOR_CATALOG_ROLLUP
FROM dbo.cust c
JOIN dbo.CATGOR cg
  ON LTRIM(RTRIM(cg.CATGOR_OLD_CATEGORY)) = LTRIM(RTRIM(c.CUSTCATEGORY))
WHERE c.CUSTID = @CustomerID
```

The Customer Sync Flow uses this lookup to determine catalog assignment and handle transitions.

---

## Pricing Logic (What Changes vs. What Stays the Same)

### Unchanged
- **Individual catalogs:** CI > GP > Standard, one catalog per CUSTID
- **GP special pricing:** Still checked before standard markup for all shared catalogs
- **Standard markup calculation:** Same formula (markup × cost / 100), same WP2 ceiling, MAP floor, max price constraints
- **Product category chunking:** Still required per Celigo flow limits

### Changed
- **Catalog identity:** No longer `CUSTCATEGORY|CUSTPRICETIER|...` — now `CATGOR_CATALOG_ROLLUP|CUSTPRICETIER`
- **Markup source:** Looked up via a representative category from `CATGOR` instead of directly from `CUSTCATEGORY`
- **Catalog count:** ~800–900 shared → 41 shared (40 C-catalogs + 1 R01)

---

## Flow Architecture Impact

### Customer Sync Flow
- Must now look up `CATGOR_CATALOG_ROLLUP` via `CATGOR` table to determine catalog assignment
- Catalog type determination: Individual if active CI pricing exists; otherwise Shared (rollup)
- Catalog title format: **TBD** (e.g., `ROLLUP-C03-T2`)

### Flow 2 (Populate New Catalogs)
- Detects newly created rollup catalogs
- Populates with all products across all 62 categories
- Uses representative category for markup lookup (via CATGOR)

### Flow 3 (Update Existing Catalog Prices)
- Delta detection query must map changed categories to their rollup group
- UpdateScope (CATEGORY / SKU) logic unchanged
- Processing key: `CATGOR_CATALOG_ROLLUP | CUSTPRICETIER | PROD_CATEGORY`

---

## Catalog Title Format (Shopify)

Rollup shared catalog titles follow this pattern:

```
C0<rollup_number>-T<tier_number>
```

**Examples:**
- `C01-T1` — Rollup group C01, tier 1
- `C03-T4` — Rollup group C03, tier 4
- `C05-T8` — Rollup group C05, tier 8

This produces 40 distinct shared catalog titles for C01–C05 (5 groups × 8 tiers).

R01 title format: **TBD** — R01 has a single tier using `PRICE_DEFAULT_LEVEL`; no tier suffix may be needed (e.g., just `R01`).

Individual catalog titles remain unchanged: `CUST-{CUSTID}`

---

## Open Questions

1. **`CUSTPRICEMARKUP`:** In the old system, this per-customer adjustment (`finalMarkup = baseMarkup + CUSTPRICEMARKUP × 100`) was part of the shared catalog unique key because customers with different values would calculate different prices and couldn't share a catalog. In the new rollup key (`CATGOR_CATALOG_ROLLUP|CUSTPRICETIER`) it is absent. Clarification needed: are all rolled-up customers expected to have `CUSTPRICEMARKUP = 0`, or does it still vary and create sub-variants?

2. **R01 catalog title:** Is the Shopify title for the R01 catalog just `R01`, or does it follow a different pattern?

3. **`CATGOR` change detection:** Should the `___TimeStampUpdated` on `CATGOR` be monitored for rollup reassignments (e.g., if a category moves from C03 to C04)?

---

## Related Files

- `PROJECT_CONTEXT.md` — Overall system architecture and flow design
- `PRICE_COMPARISON_CONTEXT.md` — Interim solution for reducing unnecessary price updates
- `original-functions.cs` — C# pricing functions (source of truth)
- `pricing.js` — JavaScript implementation of pricing functions
