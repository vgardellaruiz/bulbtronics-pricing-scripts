# Create Empty Catalogs Flow - Context

## Purpose

This flow creates empty Shopify catalogs and price lists for all active catalog
combinations. It runs before the populate and update flows — those flows require
the catalog shell (catalog ID + price list ID) to already exist in Shopify.

This is separate from:
- **Customer Sync Flow** — assigns customers to catalogs (handles Individual catalog creation per customer)
- **Flow 2 (Populate)** — fills catalogs with prices after they are created
- **Flow 3 (Update)** — updates prices in existing catalogs

---

## When It Runs

- **One-time migration:** Run once to create all rollup catalog shells for the new
  rollup architecture (replaces old CUSTCATEGORY-keyed shared catalogs)
- **Ongoing:** Run on a schedule to catch new catalog combinations that appear as
  customer configurations change (new tier/markup/group combinations)

---

## What It Creates Per Catalog

For each unique catalog combination:
1. A Shopify **CompanyLocationCatalog** (empty, no products yet)
2. A Shopify **PriceList** linked to that catalog

---

## Catalog Types

### Individual Catalogs
- One per customer with active CI special pricing
- Title: `CUST-{CUSTID}`
- Unique key: `CUSTID`
- Created by: Customer Sync Flow (event-driven, not this flow)
- **This flow does NOT create Individual catalogs**

### Shared / Rollup Catalogs
- One per unique `CATGOR_CATALOG_ROLLUP | CUSTPRICETIER | CUSTPRICEMARKUP | CUSTGROUPCODE` combination
- Title: `{CATGOR_CATALOG_ROLLUP}-T{CUSTPRICETIER}-PM{CUSTPRICEMARKUP}-{CUSTGROUPCODE}`
  - Examples: `C01-T1-PM0-IHU`, `C03-T4-PM0.5-IHU`, `R01-PM0-IHU`
- **This flow creates all Shared/Rollup catalogs**

---

## Flow Structure

### Step 1: Get All Required Catalog Combinations
- Query returns all distinct rollup catalog combinations that currently have active customers
- Each row = one catalog that should exist in Shopify
- See **Starter Query** section below

### Step 2: Check if Catalog Already Exists in Shopify
- Look up by catalog title (used as unique identifier)
- Skip if already exists

### Step 3: Create Catalog + Price List
- Create `CompanyLocationCatalog` in Shopify
- Create `PriceList` linked to that catalog
- Store catalog ID + price list ID for use by Flow 2 and Flow 3

---

## Starter Query

Returns all active rollup catalog combinations that need to exist in Shopify.
Each row is one catalog. The `PROD_CATEGORY` cross-join is retained for Celigo
chunking compatibility — use `DISTINCT ON UniqueKey` if you only need catalog
headers without product category detail.

```sql
WITH CustomersWithIndividualPricing AS (
    SELECT DISTINCT sp.SPECPR_KEY AS CUSTID
    FROM dbo.specpr sp
    WHERE sp.SPECPR_TYPE = 'CI'
        AND sp.SPECPR_APPROVER IS NOT NULL
        AND LTRIM(RTRIM(sp.SPECPR_APPROVER)) <> ''
        AND sp.SPECPR_EXPIRE_DATE > GETDATE()
),
SharedCatalogs AS (
    SELECT DISTINCT
        'SHARED' AS CatalogType,
        CONCAT(
            LTRIM(RTRIM(ISNULL(cg.CATGOR_CATALOG_ROLLUP, ''))), '|',
            LTRIM(RTRIM(ISNULL(c.CUSTPRICETIER, '0'))), '|',
            CAST(ISNULL(c.CUSTPRICEMARKUP, 0) AS VARCHAR(20)), '|',
            LTRIM(RTRIM(ISNULL(c.CUSTGROUPCODE, ''))), '|',
            '0'
        ) AS UniqueKey,
        NULL AS CUSTID,
        LTRIM(RTRIM(ISNULL(cg.CATGOR_CATALOG_ROLLUP, ''))) AS CATGOR_CATALOG_ROLLUP,
        LTRIM(RTRIM(ISNULL(c.CUSTPRICETIER, '0'))) AS CUSTPRICETIER,
        ISNULL(c.CUSTPRICEMARKUP, 0) AS CUSTPRICEMARKUP,
        LTRIM(RTRIM(ISNULL(c.CUSTGROUPCODE, ''))) AS CUSTGROUPCODE,
        0 AS IS_MEMBER_NULL
    FROM dbo.cust c
    INNER JOIN dbo.CATGOR cg WITH (NOLOCK)
        ON LTRIM(RTRIM(cg.CATGOR_OLD_CATEGORY)) = LTRIM(RTRIM(c.CUSTCATEGORY))
    LEFT JOIN CustomersWithIndividualPricing ci
        ON c.CUSTID = ci.CUSTID
    WHERE c.CUSTID IS NOT NULL
        AND ci.CUSTID IS NULL
        AND LTRIM(RTRIM(ISNULL(c.CUSTCATEGORY, ''))) <> ''
        AND c.CUSTMEMBERNUM IS NOT NULL
        AND LTRIM(RTRIM(ISNULL(cg.CATGOR_CATALOG_ROLLUP, ''))) <> ''
),
ProductCategories AS (
    SELECT DISTINCT LTRIM(RTRIM(PRICAT_CATEGORY)) AS PROD_CATEGORY
    FROM dbo.pricat
    WHERE PRICAT_CATEGORY IS NOT NULL
        AND LTRIM(RTRIM(PRICAT_CATEGORY)) <> ''
        AND PRICAT_CATEGORY <> 'NONE'
)
SELECT
    sc.CatalogType,
    sc.UniqueKey,
    sc.CUSTID,
    sc.CATGOR_CATALOG_ROLLUP,
    sc.CUSTPRICETIER,
    sc.CUSTPRICEMARKUP,
    sc.CUSTGROUPCODE,
    sc.IS_MEMBER_NULL,
    pc.PROD_CATEGORY,
    CONCAT(
        sc.CATGOR_CATALOG_ROLLUP, '-T', sc.CUSTPRICETIER,
        '-PM', CAST(sc.CUSTPRICEMARKUP AS VARCHAR(20)),
        '-', sc.CUSTGROUPCODE
    ) AS CatalogTitle
FROM SharedCatalogs sc
CROSS JOIN ProductCategories pc
ORDER BY sc.CatalogType, sc.UniqueKey, pc.PROD_CATEGORY;
```

---

## Open Questions

1. **Existing old shared catalogs:** What happens to the old CUSTCATEGORY-keyed shared
   catalogs already in Shopify? Do they need to be deleted, or left as-is until
   customers are reassigned to the new rollup catalogs?

2. **Individual catalogs:** Confirm this flow should skip Individual catalog creation
   entirely and leave that to the Customer Sync Flow.

---

## Related Files

- `PROJECT_CONTEXT.md` — Overall system architecture
- `CATALOG_ROLLUP_CONTEXT.md` — Rollup architecture, unique key, title format
- `PRICE_COMPARISON_CONTEXT.md` — Interim solution for reducing unnecessary updates
