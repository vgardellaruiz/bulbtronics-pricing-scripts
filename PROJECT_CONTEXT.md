# Bulbtronics Pricing Migration to Shopify - Project Context

## System Architecture

### Platform Stack
- **Source:** Legacy ERP with SQL Server database + C# pricing functions
- **Integration:** Celigo (Standard/Lite plan)
- **Target:** Shopify B2B with catalogs and price lists
- **Scale:** ~1,150 catalogs (~200-300 Individual + ~800-900 Shared), 62 product categories, ~35,000 products
- **Catalog sections:** ~71,000 total (1,150 catalogs × 62 categories) — typical run affects ~21,394
- **Shopify Limits:** 10,000 catalogs max, 25 per company location

---

## Database Structure

### Key Tables

#### 1. `dbo.cust` - Customer Master
- **Fields:** CUSTID, CUSTCATEGORY, CUSTPRICETIER, CUSTPRICEMARKUP, CUSTGROUPCODE, CUSTMEMBERNUM
- **Tracking:** `___TimeStampUpdated` - tracks any field modification

#### 2. `dbo.Prod` - Product Catalog
- **Fields:** PROD_SKU, CATEGORY, REF_COST, PROD_MAX_SELLPRICE, PROD_MAP_SELLPRICE, PROD_MIN_SALE_UNIT, PROD_LOCATION, PROD_STATUS
- **Date Fields:** `REF_COST_EXPIRE_CYMD` - when REF_COST expires; `REF_COST_START_CYMD` - when REF_COST becomes active
- **Tracking:** `___TimeStampUpdated` - tracks any field modification (⚠️ fires for ALL changes, not just pricing)
- **⚠️ Important:** REF_COST expiration/start dates do NOT update the timestamp — must be checked separately

#### 3. `dbo.specpr` - Special Pricing
- **SPECPR_TYPE:**
  - 'CI' = Customer Individual (customer-specific pricing)
  - 'GP' = Group Pricing (buying group pricing)
- **SPECPR_KEY:** CUSTID for CI, GROUPCODE for GP
- **Fields:** SPECPR_SKU, SPECPR_PRICE, SPECPR_APPROVER
- **Dates:** SPECPR_CREATE_DATE, SPECPR_UPDATE_DATE, SPECPR_EXPIRE_DATE, SPECPR_START_DATE
- **Tracking:** `___TimeStampUpdated` - tracks modifications (NOT expirations)
- **⚠️ Important:** Expiration dates passing does NOT update timestamp

#### 4. `dbo.price` - Markup Pricing Matrix
- **price_cust_cat:** Customer category (WP2, JD1, DLR, etc.)
- **PRICE_PROD_CAT:** Product category (DEUT, GERM, PHOT, etc.)
- **Fields:** PRICE_DEFAULT_LEVEL, PRICE_SELECTIONS, PRICE_MARKUP1 through PRICE_MARKUP10
- **Tracking:** `___TimeStampUpdated` - tracks modifications
- **Change Frequency:** Less than annually (not time-sensitive)

#### 5. `DeletedRowsKey` - Deletion Audit Table
- **TableName:** SPECPR, PRICE, Prod, etc.
- **Keys:** Key1, Key2, Key3 (composite key values)
- **KeyNotes:** Describes what each key represents
- **Tracking:** `___TimeStampUpdated` - when deletion occurred
- **ACKDate:** Acknowledgment tracking (nullable)

**Example for SPECPR:**
```
Key1: SPECPR_TYPE
Key2: SPECPR_KEY
Key3: SPECPR_SKU
```

**Example for PRICE:**
```
Key1: PRICE_PROD_CAT
Key2: price_cust_cat
```

#### 6. `dbo.pricat` - Product Categories
- **PRICAT_CATEGORY:** Used to get distinct product categories

---

## C# Pricing Functions (Source of Truth)

### File: `original-functions.cs`

### Main Function: GetPrice (lines 7-66)

**Priority Order:**
1. **CI Special Price** (Customer Individual) - HIGHEST PRIORITY
2. **GP Special Price** (Group Pricing) - SECOND PRIORITY
3. **Standard Markup Calculation** - FALLBACK

**⚠️ CRITICAL BEHAVIOR:**
- If special price exists (CI or GP), returns IMMEDIATELY (lines 19-22)
- Special prices **bypass ALL constraints** (no max price, MAP, or WP2 ceiling checks)
- Only standard markup prices apply constraints

**Calculation Steps for Standard Markup:**
1. Get markup % based on category + tier + customer markup (line 23)
2. Calculate: `price = (markup × cost) / 100` (line 25)
3. Calculate WP2 reference price (alternative ceiling) (lines 30-40)
4. Apply MAP (Minimum Advertised Price) floor (lines 42-53)
5. Apply max sell price ceiling (lines 58-61)
6. Return final price (2 decimals) (line 63)

### CheckSpecialProdPrice (lines 69-107)
- Checks CI first (lines 78-91)
- Then checks GP (lines 92-105)
- Requires SPECPR_APPROVER to be non-empty
- Filters by `SPECPR_EXPIRE_DATE > today`
- Returns boolean + outputs price via ref parameter

### GetProdMarkup (lines 110-139)
- Looks up markup % from price table
- Matches: `PRICE_PROD_CAT = product.CATEGORY` AND `price_cust_cat = customer.CUSTCATEGORY`
- Uses tier to select `PRICE_MARKUP{tier}` column
- If tier = 0, uses PRICE_DEFAULT_LEVEL
- If markup = 0, falls back to PRICE_SELECTIONS
- Adds customer's PRICEMARKUP adjustment (× 100)
- Returns 999999.99 if category not found (error condition)

### WP2 Reference Pricing (lines 30-40)
- Calculates alternative price using `PRICE_PROD_CAT = 'WP2'`
- Uses same customer category for price_cust_cat
- Uses as ceiling constraint for standard markup
- If WP2 price < max price → use WP2 as max
- Query: `PRICE_PROD_CAT = 'WP2' AND price_cust_cat = customer.CUSTCATEGORY`

### GetPricingTable (lines 142-161)
- Loads special pricing and markup tables into memory
- **If isMemberNull = true OR (no category AND no group):**
  - Uses defaults: custId="106565", group="IHU", category="WP2"
  - **Owner clarification:** These are placeholders that skip special pricing
- **Else:** Uses actual customer data

### SpecialPricingCust (lines 165-199)
- Queries CI prices: `SPECPR_TYPE='CI' AND SPECPR_KEY=@custid AND SPECPR_EXPIRE_DATE>@today`
- Queries GP prices: `SPECPR_TYPE='GP' AND SPECPR_KEY=@groupid AND SPECPR_EXPIRE_DATE>@today`
- Merges both result sets
- Returns combined DataTable

### ProdPricingCust (lines 202-215)
- Queries price table: `price_cust_cat = @custcat`
- Pads 2-character categories to 3 characters (adds space)
- Returns markup matrix for customer category

---

## Catalog Types for Shopify

### 1. Individual Catalogs
- **Who:** Customers with active CI (Customer Individual) special pricing
- **Includes:** CI prices + GP prices + standard markup
- **Priority:** CI > GP > standard
- **Unique Key:** CUSTID
- **Count:** ~200-300 catalogs
- **One catalog per customer**

### 2. Shared Catalogs
- **Who:** Customers WITHOUT CI pricing (grouped by configuration)
- **Includes:** GP prices + standard markup (NO CI)
- **Priority:** GP > standard
- **Unique Key:** `CUSTCATEGORY|CUSTPRICETIER|CUSTPRICEMARKUP|CUSTGROUPCODE|0`
- **Count:** ~800-900 catalogs
- **Multiple customers share the same catalog**

### 3. QuickBuy Catalog (Placeholder/Default)
- **Who:** Anonymous users (CUSTMEMBERNUM is null)
- **Configuration:** WP2|0|0||1
- **Includes:** Standard markup only (highest prices)
- **Special Note:** Owner confirmed IHU/106565 placeholders should skip special pricing entirely

---

## Key Parameters & Business Rules

### CUSTMEMBERNUM
- **If NULL:** QuickBuy user (anonymous checkout)
- **If has value:** Registered user
- **Owner clarification:** isMemberNull = QuickBuy mode, NOT just "field is null"

### Default/Placeholder Values (QuickBuy)
- **Customer ID:** "106565" (intentional placeholder, no real pricing)
- **Buying Group:** "IHU" (intentional placeholder, no real pricing)
- **Category:** "WP2" (default category, typically 160% markup)
- **Purpose:** Force anonymous users to skip special pricing, get highest prices

### Pricing Hierarchy Observed (from data analysis)
- **140% markup** → Best pricing (premium/high-volume customers)
- **150% markup** → Mid-tier pricing
- **155% markup** → Custom negotiated rates
- **160% markup** → Default/WP2/QuickBuy (highest prices)

### PRICE Formula Change Frequency
- **Changes:** Less than annually
- **Not time-sensitive**
- **Acceptable sync schedule:** Hourly to 6 hours
- **Owner confirmed:** This cadence is sufficient for business needs

---

## JavaScript Implementation

### Shared Catalog Pricing Function
```javascript
function calculatePriceShared(product, catalogConfig)
```
- ✅ Checks GP special pricing first
- ✅ Falls back to standard markup
- ✅ Does NOT check CI pricing
- ✅ Applies WP2 ceiling, MAP floor, max price
- ✅ Complete and tested

### Individual Catalog Pricing Function
```javascript
function calculatePriceIndividual(product, catalogConfig)
```
- ✅ Checks CI special pricing FIRST (highest priority)
- ✅ Checks GP special pricing SECOND
- ✅ Falls back to standard markup
- ✅ Applies WP2 ceiling, MAP floor, max price
- ✅ Matches C# logic exactly

**Key Difference:** Individual function checks CI pricing before GP, shared function skips CI entirely.

---

## Catalog Configuration Query

```sql
WITH CustomersWithIndividualPricing AS (
    SELECT DISTINCT sp.SPECPR_KEY as CUSTID
    FROM dbo.specpr sp
    WHERE sp.SPECPR_TYPE = 'CI'
        AND sp.SPECPR_APPROVER IS NOT NULL
        AND LTRIM(RTRIM(sp.SPECPR_APPROVER)) <> ''
        AND sp.SPECPR_EXPIRE_DATE > GETDATE()
),
IndividualCatalogs AS (
    SELECT 
        'INDIVIDUAL' as CatalogType,
        c.CUSTID as UniqueKey,
        c.CUSTID,
        LTRIM(RTRIM(ISNULL(c.CUSTCATEGORY, ''))) AS CUSTCATEGORY,
        LTRIM(RTRIM(ISNULL(c.CUSTPRICETIER, '0'))) AS CUSTPRICETIER,
        ISNULL(c.CUSTPRICEMARKUP, 0) AS CUSTPRICEMARKUP,
        LTRIM(RTRIM(ISNULL(c.CUSTGROUPCODE, ''))) AS CUSTGROUPCODE,
        0 AS IS_MEMBER_NULL
    FROM dbo.cust c
    INNER JOIN CustomersWithIndividualPricing ci ON c.CUSTID = ci.CUSTID
    WHERE c.CUSTID IS NOT NULL
        AND LTRIM(RTRIM(ISNULL(c.CUSTCATEGORY, ''))) <> ''
        AND c.CUSTMEMBERNUM IS NOT NULL
),
SharedCatalogs AS (
    SELECT DISTINCT
        'SHARED' as CatalogType,
        CONCAT(
            LTRIM(RTRIM(ISNULL(c.CUSTCATEGORY, ''))), '|',
            LTRIM(RTRIM(ISNULL(c.CUSTPRICETIER, '0'))), '|',
            CAST(ISNULL(c.CUSTPRICEMARKUP, 0) AS VARCHAR(20)), '|',
            LTRIM(RTRIM(ISNULL(c.CUSTGROUPCODE, ''))), '|',
            '0'
        ) as UniqueKey,
        NULL as CUSTID,
        LTRIM(RTRIM(ISNULL(c.CUSTCATEGORY, ''))) AS CUSTCATEGORY,
        LTRIM(RTRIM(ISNULL(c.CUSTPRICETIER, '0'))) AS CUSTPRICETIER,
        ISNULL(c.CUSTPRICEMARKUP, 0) AS CUSTPRICEMARKUP,
        LTRIM(RTRIM(ISNULL(c.CUSTGROUPCODE, ''))) AS CUSTGROUPCODE,
        0 AS IS_MEMBER_NULL
    FROM dbo.cust c
    LEFT JOIN CustomersWithIndividualPricing ci ON c.CUSTID = ci.CUSTID
    WHERE c.CUSTID IS NOT NULL
        AND ci.CUSTID IS NULL
        AND LTRIM(RTRIM(ISNULL(c.CUSTCATEGORY, ''))) <> ''
        AND c.CUSTMEMBERNUM IS NOT NULL
),
ProductCategories AS (
    SELECT DISTINCT LTRIM(RTRIM(PRICAT_CATEGORY)) AS PROD_CATEGORY
    FROM dbo.pricat
    WHERE PRICAT_CATEGORY IS NOT NULL 
        AND LTRIM(RTRIM(PRICAT_CATEGORY)) <> ''
        AND PRICAT_CATEGORY <> 'NONE'
),
AllCatalogs AS (
    SELECT 
        ic.CatalogType,
        ic.UniqueKey,
        ic.CUSTID,
        ic.CUSTCATEGORY,
        ic.CUSTPRICETIER,
        ic.CUSTPRICEMARKUP,
        ic.CUSTGROUPCODE,
        ic.IS_MEMBER_NULL,
        pc.PROD_CATEGORY
    FROM IndividualCatalogs ic
    CROSS JOIN ProductCategories pc
    UNION ALL
    SELECT 
        sc.CatalogType,
        sc.UniqueKey,
        sc.CUSTID,
        sc.CUSTCATEGORY,
        sc.CUSTPRICETIER,
        sc.CUSTPRICEMARKUP,
        sc.CUSTGROUPCODE,
        sc.IS_MEMBER_NULL,
        pc.PROD_CATEGORY
    FROM SharedCatalogs sc
    CROSS JOIN ProductCategories pc
)
SELECT *
FROM AllCatalogs
ORDER BY CatalogType, UniqueKey, PROD_CATEGORY;
```

**Key Features:**
- Only creates catalogs currently in use (~1,100)
- NOT all possible combinations (~13,000)
- Cross-joins with ProductCategories for processing chunks
- Each catalog-category combination processes separately

---

## Product Data Query (Individual Catalogs)

**Includes:**
- Product fields (SKU, CATEGORY, REF_COST, MAX, MAP)
- Customer parameters (CUSTID, CATEGORY, TIER, MARKUP, GROUP)
- Price table joins:
  - Customer category pricing (pr join)
  - WP2 reference pricing (prWP2 join)
- Special pricing joins:
  - CI special prices (spCI join with expiration filter)
  - GP special prices (spGP join with expiration filter)

**Filter:** Uses `@ProductCategory` to chunk by product category

**Query:**
```sql
DECLARE @CustomerCategory VARCHAR(10) = {{record.CUSTCATEGORY}};
DECLARE @CustomerTier VARCHAR(10) = {{record.CUSTPRICETIER}};
DECLARE @CustomerMarkup DECIMAL(10,4) = {{record.CUSTPRICEMARKUP}};
DECLARE @CustomerGroupCode VARCHAR(50) = {{record.CUSTGROUPCODE}};
DECLARE @CustomerID VARCHAR(50) = {{record.CUSTID}};  -- NEW: Individual customer ID
DECLARE @IsMemberNull BIT = {{record.IS_MEMBER_NULL}};
DECLARE @ProductCategory VARCHAR(50) = {{record.PROD_CATEGORY}};

DECLARE @EffectiveGroupCode VARCHAR(50);
DECLARE @EffectiveCategory VARCHAR(10);
DECLARE @EffectiveCustomerID VARCHAR(50);

IF @IsMemberNull = 1 
   OR (
       (LTRIM(RTRIM(@CustomerCategory)) = '' OR @CustomerCategory IS NULL)
       AND (LTRIM(RTRIM(@CustomerGroupCode)) = '' OR @CustomerGroupCode IS NULL)
   )
BEGIN
    SET @EffectiveGroupCode = 'IHU';
    SET @EffectiveCategory = 'WP2';
    SET @EffectiveCustomerID = '106565';  -- Default customer ID
END
ELSE
BEGIN
    SET @EffectiveGroupCode = ISNULL(@CustomerGroupCode, '');
    SET @EffectiveCategory = ISNULL(NULLIF(LTRIM(RTRIM(@CustomerCategory)), ''), 'WP2');
    SET @EffectiveCustomerID = @CustomerID;
END;

WITH ProductsWithWH1 AS (
    SELECT DISTINCT p.PROD_SKU
    FROM dbo.Prod p
    WHERE p.PROD_LOCATION = 1
        AND (p.PROD_STATUS = 'N' OR (p.PROD_STATUS = 'D' AND p.RECD - p.USED > 0))
        AND p.CATEGORY <> 'NONE'
        AND p.PROD_SKU_CLASS = 'N'
        AND LTRIM(RTRIM(p.CATEGORY)) = @ProductCategory  -- Filter by product category
),
RolledUpProducts AS (
    SELECT 
        MAX(CASE WHEN p.PROD_LOCATION = 1 THEN p.ID END) AS ID,
        MAX(CASE WHEN p.PROD_LOCATION = 1 THEN p.CATEGORY END) AS CATEGORY,
        p.PROD_SKU AS PROD_SKU,
        MAX(CASE WHEN p.PROD_LOCATION = 1 THEN p.REF_COST END) AS REF_COST,
        MAX(CASE WHEN p.PROD_LOCATION = 1 THEN p.PROD_MAX_SELLPRICE END) AS PROD_MAX_SELLPRICE,
        MAX(CASE WHEN p.PROD_LOCATION = 1 THEN p.PROD_MAP_SELLPRICE END) AS PROD_MAP_SELLPRICE,
        MAX(CASE WHEN p.PROD_LOCATION = 1 THEN p.PROD_MIN_SALE_UNIT END) AS PROD_MIN_SALE_UNIT
    FROM dbo.Prod p
    INNER JOIN ProductsWithWH1 wh1 ON p.PROD_SKU = wh1.PROD_SKU
    WHERE (p.PROD_STATUS = 'N' OR (p.PROD_STATUS = 'D' AND p.RECD - p.USED > 0))
        AND p.PROD_LOCATION IN (1, 2, 5, 7)
        AND p.CATEGORY <> 'NONE'
    GROUP BY p.PROD_SKU
)
SELECT 
    rp.ID,
    rp.PROD_SKU AS SKU,
    LTRIM(RTRIM(rp.CATEGORY)) AS CATEGORY,
    rp.REF_COST,
    ISNULL(rp.PROD_MAX_SELLPRICE, 0) AS PROD_MAX_SELLPRICE,
    ISNULL(rp.PROD_MAP_SELLPRICE, 0) AS PROD_MAP_SELLPRICE,
    rp.PROD_MIN_SALE_UNIT,
    
    @EffectiveCategory AS CUSTCATEGORY,
    @CustomerTier AS CUSTPRICETIER,
    @CustomerMarkup AS CUSTPRICEMARKUP,
    @EffectiveGroupCode AS CUSTGROUPCODE,
    @EffectiveCustomerID AS CUSTID,
    @IsMemberNull AS IS_MEMBER_NULL,
    
    pr.PRICE_DEFAULT_LEVEL,
    pr.PRICE_SELECTIONS,
    pr.PRICE_MARKUP1,
    pr.PRICE_MARKUP2,
    pr.PRICE_MARKUP3,
    pr.PRICE_MARKUP4,
    pr.PRICE_MARKUP5,
    pr.PRICE_MARKUP6,
    pr.PRICE_MARKUP7,
    pr.PRICE_MARKUP8,
    pr.PRICE_MARKUP9,
    pr.PRICE_MARKUP10,
    
    prWP2.PRICE_DEFAULT_LEVEL AS WP2_PRICE_DEFAULT_LEVEL,
    prWP2.PRICE_SELECTIONS AS WP2_PRICE_SELECTIONS,
    prWP2.PRICE_MARKUP1 AS WP2_PRICE_MARKUP1,
    prWP2.PRICE_MARKUP2 AS WP2_PRICE_MARKUP2,
    prWP2.PRICE_MARKUP3 AS WP2_PRICE_MARKUP3,
    prWP2.PRICE_MARKUP4 AS WP2_PRICE_MARKUP4,
    prWP2.PRICE_MARKUP5 AS WP2_PRICE_MARKUP5,
    prWP2.PRICE_MARKUP6 AS WP2_PRICE_MARKUP6,
    prWP2.PRICE_MARKUP7 AS WP2_PRICE_MARKUP7,
    prWP2.PRICE_MARKUP8 AS WP2_PRICE_MARKUP8,
    prWP2.PRICE_MARKUP9 AS WP2_PRICE_MARKUP9,
    prWP2.PRICE_MARKUP10 AS WP2_PRICE_MARKUP10,
    
    spCI.SPECPR_PRICE AS CI_SPECIAL_PRICE,  -- Customer Individual pricing
    spGP.SPECPR_PRICE AS GP_SPECIAL_PRICE   -- Group pricing
    
FROM RolledUpProducts rp
LEFT JOIN dbo.price pr 
    ON LTRIM(RTRIM(pr.PRICE_PROD_CAT)) = LTRIM(RTRIM(rp.CATEGORY))
    AND pr.price_cust_cat = @EffectiveCategory
LEFT JOIN dbo.price prWP2
    ON LTRIM(RTRIM(prWP2.PRICE_PROD_CAT)) = 'WP2'  -- Original C# logic
    AND prWP2.price_cust_cat = @EffectiveCategory   -- Customer's category
LEFT JOIN dbo.specpr spCI
    ON spCI.SPECPR_TYPE = 'CI'
    AND LTRIM(RTRIM(spCI.SPECPR_SKU)) = rp.PROD_SKU
    AND spCI.SPECPR_KEY = @EffectiveCustomerID  -- Individual customer
    AND spCI.SPECPR_APPROVER IS NOT NULL
    AND LTRIM(RTRIM(spCI.SPECPR_APPROVER)) <> ''
    AND spCI.SPECPR_EXPIRE_DATE > GETDATE()
LEFT JOIN dbo.specpr spGP
    ON spGP.SPECPR_TYPE = 'GP'
    AND LTRIM(RTRIM(spGP.SPECPR_SKU)) = rp.PROD_SKU
    AND spGP.SPECPR_KEY = @EffectiveGroupCode
    AND spGP.SPECPR_APPROVER IS NOT NULL
    AND LTRIM(RTRIM(spGP.SPECPR_APPROVER)) <> ''
    AND spGP.SPECPR_EXPIRE_DATE > GETDATE()
    AND @EffectiveGroupCode <> ''
WHERE rp.REF_COST IS NOT NULL
ORDER BY rp.PROD_SKU;
```

## Product Data Query (Individual Catalogs)
Similar to the query for Individual catalogs bot doesn't consider special prices.

**Includes:**
- Product fields (SKU, CATEGORY, REF_COST, MAX, MAP)
- Customer parameters (CUSTID, CATEGORY, TIER, MARKUP, GROUP)
- Price table joins:
  - Customer category pricing (pr join)
  - WP2 reference pricing (prWP2 join)

**Filter:** Uses `@ProductCategory` to chunk by product category

**Query:**
```sql
DECLARE @CustomerCategory VARCHAR(10) = {{record.CUSTCATEGORY}};
DECLARE @CustomerTier VARCHAR(10) = {{record.CUSTPRICETIER}};
DECLARE @CustomerMarkup DECIMAL(10,4) = {{record.CUSTPRICEMARKUP}};
DECLARE @CustomerGroupCode VARCHAR(50) = {{record.CUSTGROUPCODE}};
DECLARE @IsMemberNull BIT = {{record.IS_MEMBER_NULL}};
DECLARE @ProductCategory VARCHAR(50) = {{record.PROD_CATEGORY}};

DECLARE @EffectiveGroupCode VARCHAR(50);
DECLARE @EffectiveCategory VARCHAR(10);

IF @IsMemberNull = 1 
   OR (
       (LTRIM(RTRIM(@CustomerCategory)) = '' OR @CustomerCategory IS NULL)
       AND (LTRIM(RTRIM(@CustomerGroupCode)) = '' OR @CustomerGroupCode IS NULL)
   )
BEGIN
    SET @EffectiveGroupCode = 'IHU';
    SET @EffectiveCategory = 'WP2';
END
ELSE
BEGIN
    SET @EffectiveGroupCode = ISNULL(@CustomerGroupCode, '');
    SET @EffectiveCategory = ISNULL(NULLIF(LTRIM(RTRIM(@CustomerCategory)), ''), 'WP2');
END;

WITH ProductsWithWH1 AS (
    SELECT DISTINCT p.PROD_SKU
    FROM dbo.Prod p
    WHERE p.PROD_LOCATION = 1
        AND (p.PROD_STATUS = 'N' OR (p.PROD_STATUS = 'D' AND p.RECD - p.USED > 0))
        AND p.CATEGORY <> 'NONE'
        AND p.PROD_SKU_CLASS = 'N'
        AND LTRIM(RTRIM(p.CATEGORY)) = @ProductCategory  -- Filter by product category
),
RolledUpProducts AS (
    SELECT 
        MAX(CASE WHEN p.PROD_LOCATION = 1 THEN p.ID END) AS ID,
        MAX(CASE WHEN p.PROD_LOCATION = 1 THEN p.CATEGORY END) AS CATEGORY,
        p.PROD_SKU AS PROD_SKU,
        MAX(CASE WHEN p.PROD_LOCATION = 1 THEN p.REF_COST END) AS REF_COST,
        MAX(CASE WHEN p.PROD_LOCATION = 1 THEN p.PROD_MAX_SELLPRICE END) AS PROD_MAX_SELLPRICE,
        MAX(CASE WHEN p.PROD_LOCATION = 1 THEN p.PROD_MAP_SELLPRICE END) AS PROD_MAP_SELLPRICE,
        MAX(CASE WHEN p.PROD_LOCATION = 1 THEN p.PROD_MIN_SALE_UNIT END) AS PROD_MIN_SALE_UNIT
    FROM dbo.Prod p
    INNER JOIN ProductsWithWH1 wh1 ON p.PROD_SKU = wh1.PROD_SKU
    WHERE (p.PROD_STATUS = 'N' OR (p.PROD_STATUS = 'D' AND p.RECD - p.USED > 0))
        AND p.PROD_LOCATION IN (1, 2, 5, 7)
        AND p.CATEGORY <> 'NONE'
    GROUP BY p.PROD_SKU
)
SELECT 
    rp.ID,
    rp.PROD_SKU AS SKU,
    LTRIM(RTRIM(rp.CATEGORY)) AS CATEGORY,
    rp.REF_COST,
    ISNULL(rp.PROD_MAX_SELLPRICE, 0) AS PROD_MAX_SELLPRICE,
    ISNULL(rp.PROD_MAP_SELLPRICE, 0) AS PROD_MAP_SELLPRICE,
    rp.PROD_MIN_SALE_UNIT,
    
    @EffectiveCategory AS CUSTCATEGORY,
    @CustomerTier AS CUSTPRICETIER,
    @CustomerMarkup AS CUSTPRICEMARKUP,
    @EffectiveGroupCode AS CUSTGROUPCODE,
    @IsMemberNull AS IS_MEMBER_NULL,
    
    pr.PRICE_DEFAULT_LEVEL,
    pr.PRICE_SELECTIONS,
    pr.PRICE_MARKUP1,
    pr.PRICE_MARKUP2,
    pr.PRICE_MARKUP3,
    pr.PRICE_MARKUP4,
    pr.PRICE_MARKUP5,
    pr.PRICE_MARKUP6,
    pr.PRICE_MARKUP7,
    pr.PRICE_MARKUP8,
    pr.PRICE_MARKUP9,
    pr.PRICE_MARKUP10,
    
    prWP2.PRICE_DEFAULT_LEVEL AS WP2_PRICE_DEFAULT_LEVEL,
    prWP2.PRICE_SELECTIONS AS WP2_PRICE_SELECTIONS,
    prWP2.PRICE_MARKUP1 AS WP2_PRICE_MARKUP1,
    prWP2.PRICE_MARKUP2 AS WP2_PRICE_MARKUP2,
    prWP2.PRICE_MARKUP3 AS WP2_PRICE_MARKUP3,
    prWP2.PRICE_MARKUP4 AS WP2_PRICE_MARKUP4,
    prWP2.PRICE_MARKUP5 AS WP2_PRICE_MARKUP5,
    prWP2.PRICE_MARKUP6 AS WP2_PRICE_MARKUP6,
    prWP2.PRICE_MARKUP7 AS WP2_PRICE_MARKUP7,
    prWP2.PRICE_MARKUP8 AS WP2_PRICE_MARKUP8,
    prWP2.PRICE_MARKUP9 AS WP2_PRICE_MARKUP9,
    prWP2.PRICE_MARKUP10 AS WP2_PRICE_MARKUP10,
    
    spGP.SPECPR_PRICE AS GP_SPECIAL_PRICE,
    NULL AS CI_SPECIAL_PRICE
    
FROM RolledUpProducts rp
LEFT JOIN dbo.price pr 
    ON LTRIM(RTRIM(pr.PRICE_PROD_CAT)) = LTRIM(RTRIM(rp.CATEGORY))
    AND pr.price_cust_cat = @EffectiveCategory
LEFT JOIN dbo.price prWP2
    ON LTRIM(RTRIM(prWP2.PRICE_PROD_CAT)) = 'WP2'  -- CHANGED: Original C# logic
    AND prWP2.price_cust_cat = @EffectiveCategory   -- CHANGED: Customer's category
LEFT JOIN dbo.specpr spGP
    ON spGP.SPECPR_TYPE = 'GP'
    AND LTRIM(RTRIM(spGP.SPECPR_SKU)) = rp.PROD_SKU
    AND spGP.SPECPR_KEY = @EffectiveGroupCode
    AND spGP.SPECPR_APPROVER IS NOT NULL
    AND LTRIM(RTRIM(spGP.SPECPR_APPROVER)) <> ''
    AND spGP.SPECPR_EXPIRE_DATE > GETDATE()
    AND @EffectiveGroupCode <> ''
WHERE rp.REF_COST IS NOT NULL
ORDER BY rp.PROD_SKU;
```


---

## Update Strategy Planning

### Current Constraints
- **Each catalog takes 11 minutes to create**
- **1,150 catalogs = ~211 hours for full regeneration**
- Cannot recreate all catalogs frequently
- **All catalogs contain all products** with different prices
- One price list per catalog
- Prices are overwritten with calculated values
- Check if catalog exists: Query Shopify by catalog title

### Change Detection Sources

#### 1. PRICE Table Changes (Rare - <annually)
```sql
SELECT DISTINCT PRICE_PROD_CAT, price_cust_cat
FROM price
WHERE ___TimeStampUpdated > @LastRunDate
```
- **Affects:** All catalogs using that customer category
- **Scope:** Only products in affected product category need updating
- **Impact:** ~100 catalogs × ~200 products instead of all

#### 2. Product Changes (Daily)
```sql
SELECT PROD_SKU, CATEGORY, REF_COST, PROD_MAX_SELLPRICE, PROD_MAP_SELLPRICE
FROM Prod
WHERE ___TimeStampUpdated > @LastRunDate
```
- **Affects:** ALL catalogs
- **Scope:** Only changed products need recalculation
- **Note:** Timestamp updates for ANY field change (not just pricing fields)

#### 3. Special Price Changes (Daily) - FOUR Sub-types

**A. New/Modified (Timestamp-based):**
```sql
SELECT SPECPR_TYPE, SPECPR_KEY, SPECPR_SKU, SPECPR_PRICE
FROM specpr
WHERE ___TimeStampUpdated > @LastRunDate
    AND SPECPR_EXPIRE_DATE > GETDATE()
    AND SPECPR_APPROVER IS NOT NULL
    AND LTRIM(RTRIM(SPECPR_APPROVER)) <> ''
```

**B. Expiring (Date-based) - ⚠️ NO timestamp change:**
```sql
SELECT SPECPR_TYPE, SPECPR_KEY, SPECPR_SKU
FROM specpr
WHERE SPECPR_EXPIRE_DATE BETWEEN @LastRunDate AND GETDATE()
    AND SPECPR_APPROVER IS NOT NULL
    AND LTRIM(RTRIM(SPECPR_APPROVER)) <> ''
```

**C. Starting (Date-based):**
```sql
SELECT SPECPR_TYPE, SPECPR_KEY, SPECPR_SKU
FROM specpr
WHERE SPECPR_START_DATE BETWEEN @LastRunDate AND GETDATE()
    AND SPECPR_EXPIRE_DATE > GETDATE()
    AND SPECPR_APPROVER IS NOT NULL
    AND LTRIM(RTRIM(SPECPR_APPROVER)) <> ''
```

**D. Deleted:**
```sql
SELECT Key1 AS SPECPR_TYPE, Key2 AS SPECPR_KEY, Key3 AS SPECPR_SKU
FROM DeletedRowsKey
WHERE TableName = 'SPECPR'
    AND ___TimeStampUpdated > @LastRunDate
```

---

## Current Flow Architecture (Production)

### Customer Sync Flow (Event-Driven)
- **Trigger:** Customer record changes (any field) OR CI special price changes (4 sources)
- **What it does:**
  1. Detects customer or CI pricing changes
  2. Determines if customer needs Individual or Shared catalog
  3. Creates empty catalog + price list in Shopify if it doesn't exist yet
  4. Assigns catalog to customer/company location
  5. Handles transitions (Individual → Shared when CI pricing expires, and vice versa)
- **Why it includes catalog creation:** Ensures catalog exists before Flow 2 tries to populate it
- **CI change detection uses 4 sources:**
  - New/Modified (timestamp on `specpr`)
  - Expiring (date range: SPECPR_EXPIRE_DATE in window)
  - Starting (date range: SPECPR_START_DATE in window)
  - Deleted (DeletedRowsKey audit table)

**Catalog Type Determination Query:**
```sql
DECLARE @CustomerID VARCHAR(50) = {{record.CUSTID}};
SELECT
    CASE
        WHEN EXISTS (
            SELECT 1 FROM dbo.specpr sp
            WHERE sp.SPECPR_TYPE = 'CI'
                AND sp.SPECPR_KEY = @CustomerID
                AND sp.SPECPR_APPROVER IS NOT NULL
                AND LTRIM(RTRIM(sp.SPECPR_APPROVER)) <> ''
                AND sp.SPECPR_EXPIRE_DATE > GETDATE()
        ) THEN 'INDIVIDUAL'
        ELSE 'SHARED'
    END AS CatalogType
```

---

### Flow 2: Populate New Catalogs (Scheduled)
- **Trigger:** Detects catalogs created since last run (via timestamp filters)
- **What it does:** Populates newly created empty catalogs with ALL products across all 62 categories
- **Strategy:** Processes one product category at a time to avoid Celigo timeout limits
- **Why separate from Customer Sync Flow:** Customer Sync creates the empty catalog; Flow 2 fills it with prices
- **Detection:** Checks for Individual catalogs with new/active CI pricing AND Shared catalogs with recently changed customer configs

---

### Flow 3: Update Existing Catalog Prices (Scheduled)
- **Trigger:** Runs every 2–4 hours
- **What it does:** Detects price-relevant changes and updates only affected catalog sections
- **Strategy:** Combined delta detection returns only affected sections (1,000–5,000 instead of 71,000)
- **Branching:** By CatalogType (Individual/Shared) + UpdateScope (CATEGORY/SKU)
- **Scale (observed):** ~21,394 catalog sections, ~3,000,000 individual SKU calls (mostly unnecessary — see Known Issue below)

#### Known Issue: Unnecessary Updates
- `___TimeStampUpdated` on `Prod` fires for ANY field change (inventory, descriptions, etc.), not just pricing fields
- This causes ~3,000,000 individual product update calls per run, most of which result in no actual price change
- **Team is building** a dedicated price-change field — not ready yet
- **Temporary fix planned:** Price Comparison Flow (see `PRICE_COMPARISON_CONTEXT.md`)

---

## Celigo Flow Architecture

### Customer Sync Flow (Event-Driven)
- **Trigger:** Customer record changes OR CI special price changes
- **Purpose:** Keep catalog assignments and catalog types in sync with ERP
- **Handles catalog creation:** Creates empty catalog + price list if needed, assigns to customer
- **See:** "Customer Sync Flow" section above for full details

---

### Flow 2: Populate New Catalogs (Scheduled)
- **Frequency:** Scheduled (after Customer Sync Flow creates empty catalogs)
- **Purpose:** Fill newly created empty catalogs with all products and calculated prices
- **Process:** One product category at a time (62 categories) to avoid timeouts
- **Notes:**
  - Takes ~11 minutes per catalog
  - Creates complete, ready-to-use catalogs
  - Uses JavaScript pricing functions to calculate prices
  - Uploads via `priceListFixedPricesAdd` (batched 250 per call)
  - Sets quantity rules via `quantityRulesAdd`

---

### Flow 3: Update Product Prices (Incremental Updates)

**⚠️ Updates existing catalogs only — does NOT create new catalogs**

#### **Overview**
- **Frequency:** Every 2-4 hours (scheduled)
- **Purpose:** Update existing catalog prices when products/special prices/markup formulas change
- **Strategy:** Combined delta detection returns only affected catalog sections (1,000–5,000 rows instead of 71,000)
- **Performance:** ~50x faster than full regeneration by updating only changed SKUs

#### **Shopify API Capabilities (Confirmed)**
- ✅ CAN update individual product prices without recreating entire price list
- ✅ Uses `priceListFixedPricesAdd` mutation (links by product variant ID)
- ✅ Uses `quantityRulesAdd` for quantity rules
- ✅ Batching: 250 prices per mutation call
- ✅ Enables surgical SKU-level updates

#### **Performance Context**
- **Total:** 35,000 active products across 62 product categories
- **Catalogs:** 1,150 catalogs (Individual + Shared)
- **Processing time:** 2-4 hours acceptable for incremental updates
- **Timestamp tracking:** Celigo provides @LastRunDate

---

### Flow 3 Detailed Structure

#### **Step 1: Combined Delta Detection (Single Query)**

The delta detection is now a **single combined query** that replaces the old two-step approach (separate catalog listing + per-section change check). It returns only catalog sections that actually need updating, with flags explaining why.

**Output:** ~1,000–5,000 rows (vs. 71,000 with old approach)

**Example record:**
```json
{
  "CatalogType": "INDIVIDUAL",
  "UniqueKey": "01865",
  "CUSTID": "01865",
  "CUSTCATEGORY": "RD1",
  "CUSTPRICETIER": "0",
  "CUSTPRICEMARKUP": 0,
  "CUSTGROUPCODE": "...",
  "IS_MEMBER_NULL": 0,
  "PROD_CATEGORY": "ADAP",
  "PriceFormulaChanged": 0,
  "ProductsChanged": 1,
  "CI_Changed": 0,
  "GP_Changed": 0,
  "NeedsUpdate": 1,
  "UpdateScope": "SKU",
  "catalogTitle": "CUST-01865",
  "catalogId": "gid://shopify/CompanyLocationCatalog/...",
  "priceListId": "gid://shopify/PriceList/..."
}
```

**Flag meanings:**
- `PriceFormulaChanged`: PRICE table markup formula changed → triggers full category update
- `ProductsChanged`: Product fields changed (REF_COST, MAX, MAP, REF_COST dates)
- `CI_Changed`: Customer Individual special prices changed
- `GP_Changed`: Group special prices changed
- `NeedsUpdate`: 1 = process this section (all returned rows have NeedsUpdate = 1)
- `UpdateScope`: `'CATEGORY'` = update all products in category; `'SKU'` = only changed SKUs

**Update Scope Logic:**
- `PriceFormulaChanged = 1` → `UpdateScope = 'CATEGORY'`
- Otherwise → `UpdateScope = 'SKU'`

**⚠️ Product change detection uses THREE sources (not just timestamp):**
```sql
ChangedProducts AS (
    SELECT DISTINCT LTRIM(RTRIM(CATEGORY)) AS PROD_CATEGORY
    FROM dbo.Prod WITH (NOLOCK)
    WHERE (
        REF_COST_EXPIRE_CYMD BETWEEN @LastRunDate AND GETDATE()
        OR REF_COST_START_CYMD BETWEEN @LastRunDate AND GETDATE()
        OR ___TimeStampUpdated > @LastRunDate
    )
    AND (PROD_STATUS = 'N' OR (PROD_STATUS = 'D' AND RECD - USED > 0))
    AND CATEGORY <> 'NONE'
    AND PROD_SKU_CLASS = 'N'
)
```
Reason: REF_COST expiration/activation do NOT update `___TimeStampUpdated`, so date ranges must be checked separately.

---

#### **Change Detection Sources (4 Types)**

**1. Product Changes (SKU-level, Daily)**
- Detects: `Prod.___TimeStampUpdated > @LastRunDate`
- Filters: `CATEGORY = @PROD_CATEGORY` AND active status
- Impact: All catalogs need those SKUs updated
- Note: Timestamp fires for ANY field change (inventory, status, etc.), not just pricing fields

**2. CI Special Price Changes (SKU-level, Daily) - 4 Sub-sources**

**A. New/Modified (Timestamp-based):**
```sql
SPECPR_TYPE = 'CI' AND ___TimeStampUpdated > @LastRunDate
AND SPECPR_EXPIRE_DATE > GETDATE()
```

**B. Expiring (Date-based - ⚠️ NO timestamp):**
```sql
SPECPR_TYPE = 'CI' AND SPECPR_EXPIRE_DATE BETWEEN @LastRunDate AND GETDATE()
```

**C. Starting (Date-based):**
```sql
SPECPR_TYPE = 'CI' AND SPECPR_START_DATE BETWEEN @LastRunDate AND GETDATE()
AND SPECPR_EXPIRE_DATE > GETDATE()
```

**D. Deleted (Audit table):**
```sql
TableName = 'SPECPR' AND Key1 = 'CI' AND ___TimeStampUpdated > @LastRunDate
```

**3. GP Special Price Changes (SKU-level, Daily) - 4 Sub-sources**
Same structure as CI but `SPECPR_TYPE = 'GP'`

**4. PRICE Table Changes (Category-level, Rare <annually)**
```sql
price.___TimeStampUpdated > @LastRunDate
WHERE PRICE_PROD_CAT = @PROD_CATEGORY AND price_cust_cat = @CUSTCATEGORY
```

**Why CUSTPRICETIER is NOT checked:**
- PRICE table has ONE row per (PRICE_PROD_CAT, price_cust_cat)
- That row contains ALL tier markups (PRICE_MARKUP1 through PRICE_MARKUP10)
- Tier selects WHICH column to use, but if the row changes, ALL tiers are affected
- Example: If PRICE_MARKUP2 changes, tier 2 catalogs need updating, but we can't know which column changed, so update all tiers

---

#### **Step 2: Branching Logic**

**Branch Point 1: CatalogType**
```
INDIVIDUAL → Use Individual catalog queries (CI + GP + Standard)
SHARED     → Use Shared catalog queries (GP + Standard, NO CI)
```

**Branch Point 2: UpdateScope**
```
CATEGORY → PATH A (Full Category Update — PriceFormulaChanged = 1)
SKU      → PATH B (Specific SKUs Only — all other changes)
```

---

#### **Step 3A: PATH A - Full Category Update**

**When triggered:** `PriceFormulaChanged = 1` (PRICE table markup changed)

**Why full category:** Markup formula affects ALL products in category — cannot optimize to specific SKUs.

**Process:**
1. Branch by CatalogType (Individual/Shared)
2. Fetch ALL products in `@PROD_CATEGORY` using the full product data query
3. Calculate prices for all using JavaScript functions
4. Update Shopify via `priceListFixedPricesAdd` (batched 250 per call)

---

#### **Step 3B: PATH B - Specific SKUs Only (2-Query Pattern)**

**When triggered:** Any SKU-level change without PRICE formula change (most common path)

**Why 2 queries:** The original combined query (get changed SKUs + full product data in one query) caused Celigo timeout errors (15-second limit). Split into:

**Query B1 — Get Changed SKU List (lightweight):**
- Inputs: `{{record.CUSTID}}` (Individual) or `{{record.CUSTGROUPCODE}}` (Shared), `{{record.PROD_CATEGORY}}`, `@LastRunDate`
- Sources: Product timestamp/date changes + CI changes (4 sources) + GP changes (4 sources)
- Output: List of distinct `PROD_SKU` values
- All tables use `WITH (NOLOCK)`

**Celigo One-to-Many Step:**
- Expands each SKU into its own record
- Next query receives: `record.PROD_SKU` (the single SKU) + `record._PARENT.*` (all catalog config fields)

**Query B2 — Fetch Single Product Data (one SKU at a time):**
- Input: `{{record.PROD_SKU}}` for the target SKU
- Catalog config from: `{{record._PARENT.CUSTCATEGORY}}`, `{{record._PARENT.CUSTGROUPCODE}}`, etc.
- Fetches full pricing data (product fields, price table, special prices) for that ONE SKU
- Individual version: includes CI + GP special price joins
- Shared version: NO CI join, returns `NULL AS CI_SPECIAL_PRICE`
- All joins use `WITH (NOLOCK)`

**Step 4: Calculate Price**
- JavaScript transform using `calculatePriceIndividual()` or `calculatePriceShared()`

**Step 5: Batch & Update Shopify**
- Post response map hook groups records into batches of 250
- `priceListFixedPricesAdd` mutation

**Performance:**
- Before (category-level): 1,150 catalogs × 500 DEUT products = 575,000 price updates
- After (SKU-level): 1,150 catalogs × ~10 changed SKUs = ~11,500 price updates
- ~50x faster per legitimate pricing change

---

### Flow 3 Query Summary

**Queries Used:**

1. ✅ **Step 1:** Combined delta detection query — returns affected catalog sections with flags
2. ✅ **Step 3A — PATH A (CATEGORY):** Full product data query — Individual and Shared variants
3. ✅ **Step 3B — PATH B (SKU), Query B1:** Get changed SKU list — Individual and Shared variants (lightweight)
4. ✅ **Step 3B — PATH B (SKU), Query B2:** Fetch single product data — Individual and Shared variants (one SKU at a time via `record._PARENT.*`)

**⚠️ Important: All queries use `WITH (NOLOCK)`**
- Prevents deadlocks from Celigo parallel processing (confirmed deadlock errors without it)
- Celigo concurrency should be limited to 5–10 parallel operations to reduce DB/API load

---

### Catalog Parameter Usage Reference

| Parameter | Where Used | Purpose |
|-----------|------------|---------|
| **CUSTCATEGORY** | PRICE table lookup | Gets base markup: `price_cust_cat = CUSTCATEGORY` |
| **CUSTPRICETIER** | Column selection | Selects which markup column: `PRICE_MARKUP{tier}` |
| **CUSTPRICEMARKUP** | Adjustment | Added to base markup: `markup + (CUSTPRICEMARKUP × 100)` |
| **CUSTGROUPCODE** | GP special prices | Lookup: `SPECPR_TYPE='GP' AND SPECPR_KEY = CUSTGROUPCODE` |
| **CUSTID** | CI special prices | Lookup: `SPECPR_TYPE='CI' AND SPECPR_KEY = CUSTID` |
| **PROD_CATEGORY** | Product filter | Filters products and PRICE lookup: `PRICE_PROD_CAT = PROD_CATEGORY` |
| **IS_MEMBER_NULL** | QuickBuy mode | If 1 → skip special pricing (not used in update flow) |

**Pricing Priority Flow:**
1. Check CI price (uses CUSTID) → If found, RETURN
2. Check GP price (uses CUSTGROUPCODE) → If found, RETURN
3. Calculate standard markup:
   - Get base from PRICE table (uses CUSTCATEGORY + PROD_CATEGORY)
   - Select column using CUSTPRICETIER
   - Add CUSTPRICEMARKUP adjustment
   - Apply WP2 ceiling, MAP floor, max price constraints

---

## Resolved Questions

1. ✅ **Can you update individual product prices without recreating the entire price list?**
   - YES — `priceListFixedPricesAdd` mutation updates/overwrites prices by variant ID without recreating the list
   - Batching: 250 prices per call
   - This enables the SKU-level update pattern

2. ✅ **Shopify API usage confirmed:**
   - Uses `priceListFixedPricesAdd` mutation
   - Prices are overwritten (not deleted + recreated)
   - `quantityRulesAdd` for quantity rules

3. **11-minute catalog creation time:** Most likely Shopify API upload time (batching 35,000 products at 250 per call = 140 API calls per catalog)

## Outstanding Questions / Known Gaps

1. **New price-specific change field in `Prod` table:**
   - Team is building this field to replace `___TimeStampUpdated` for pricing detection
   - Not ready yet — when available, it will eliminate most of the ~3,000,000 unnecessary calls
   - Price Comparison Flow is the interim solution

2. **Price Comparison Flow design:**
   - How to store comparison results (temporary DB table, Celigo storage, file?)
   - How to handle price precision (rounding threshold for float comparison)
   - See `PRICE_COMPARISON_CONTEXT.md` for full context

---

## Important Implementation Notes

### Rules to Follow
- ✅ All pricing logic must follow C# functions exactly (source of truth)
- ✅ Only exception: Owner's QuickBuy clarification (skip IHU/106565 special pricing lookup)
- ✅ Expiration handling automatic (SQL filters expired, fallback to next priority)
- ✅ PRICE table deletions are cleanup only (always assume active record exists)
- ✅ All catalogs contain all products (just different prices per catalog)
- ✅ Never create queries or functions unless explicitly requested
- ✅ Always verify against C# source of truth before implementing
- ✅ All SQL queries must use `WITH (NOLOCK)` on all table references (prevents deadlocks from parallel Celigo processing)
- ✅ Celigo concurrency: limit to 5–10 parallel operations to prevent DB/API overload
- ✅ Celigo handlebars syntax: DECLARE variables must use `{{record.FIELDNAME}}` or `{{record._PARENT.FIELDNAME}}` — never hardcode test values in production queries

### Shopify B2B Pricing Priority Issue
**Problem:** Shopify B2B has no catalog priority - it shows the LOWEST price across all assigned catalogs.

**C# Behavior:** Priority-based (CI > GP > standard)
**Shopify Behavior:** Lowest-price-based (no priority concept)

**Example Issue:**
- Customer has individual catalog with CI price: $100
- Customer also has shared catalog with standard price: $80
- ERP shows: $100 (CI priority)
- Shopify shows: $80 (lowest price wins)

**Potential Solutions:**
- Option A: Only assign ONE catalog per customer (either individual OR shared, never both)
- Option B: Accept difference and document
- Option C: Apply constraints to special prices (changes ERP logic - not recommended)

### Expiration Timing Issue
**Problem:** Shopify catalogs are static/pre-calculated

**Scenario:**
- Today (Jan 1): Generate catalog, special price expires Jan 15 → Price included
- Jan 15: Special price expires in ERP
- Jan 16-30: Shopify catalog STILL shows expired price (stale data)

**Solution:** Regular scheduled regeneration to catch expired prices

---

## File Structure

### Current Repository Files
- `original-functions.cs` - C# pricing functions (source of truth)
- `pricing.js` - JavaScript price calculation functions
- `index.js` - Batch price generation script
- `db.js` - Database connection configuration
- `test.js` - Testing utilities
- `prices_long.csv` - Generated pricing output
- `PROJECT_CONTEXT.md` - This file (overall architecture and flow design)
- `PRICE_COMPARISON_CONTEXT.md` - Context for the Price Comparison Flow (interim solution for reducing unnecessary updates)

---

## Next Steps

1. **Design and build Price Comparison Flow** (see `PRICE_COMPARISON_CONTEXT.md`):
   - Calculate what each product price SHOULD be (using existing JS functions)
   - Fetch current price from Shopify price list
   - Compare and flag only products where price actually changed
   - Use flagged records to drive Flow 3 instead of all detected changes
2. **Await new price-specific change field** on `Prod` table from dev team (will replace interim Price Comparison Flow)
3. **Catalog deletion strategy:** Delete catalogs with 0 company/location assignments (weekly cleanup with optional grace period) to stay within Shopify's 10,000 catalog limit

---

## Contact & Clarifications

### Owner Clarifications Received:
1. **isMemberNull** = QuickBuy mode (anonymous checkout), not just "CUSTMEMBERNUM is null"
2. QuickBuy users should skip special pricing lookup entirely (IHU/106565 are wasteful placeholders)
3. PRICE formula changes are infrequent (<annually) and not time-sensitive
4. Hourly to 6-hour sync schedule is acceptable for PRICE changes
5. **Shopify API confirmed:** `priceListFixedPricesAdd` used, prices overwritten (not deleted + recreated), 250 per batch
6. **Individual catalog** = ALL products for that category + standard markup + GP special prices + CI special prices (CI highest priority)
7. **`___TimeStampUpdated`** fires for ANY Prod field change — team is building a dedicated price-change field (not yet ready)
8. **`PRICE_DEFAULT_LEVEL`** = markup used when `CUSTPRICETIER = 0` (no tier selection)
9. **`PRICE_SELECTIONS`** = fallback markup when the selected tier's markup value is 0
10. **Product category changes** are detected via `___TimeStampUpdated` — old category in Shopify is NOT a concern because price lists use variant IDs (not category structure)

### Questions Pending:
1. Root cause of 11-minute catalog creation time (likely Shopify API batching)
2. Price Comparison Flow implementation decisions (storage, precision threshold) — see `PRICE_COMPARISON_CONTEXT.md`

