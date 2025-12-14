# Bulbtronics Pricing Migration to Shopify - Project Context

## System Architecture

### Platform Stack
- **Source:** Legacy ERP with SQL Server database + C# pricing functions
- **Integration:** Celigo (Standard/Lite plan)
- **Target:** Shopify B2B with catalogs and price lists
- **Scale:** ~1,100 catalogs (currently assigned), ~13,000 possible combinations
- **Shopify Limits:** 10,000 catalogs max, 25 per company location

---

## Database Structure

### Key Tables

#### 1. `dbo.cust` - Customer Master
- **Fields:** CUSTID, CUSTCATEGORY, CUSTPRICETIER, CUSTPRICEMARKUP, CUSTGROUPCODE, CUSTMEMBERNUM
- **Tracking:** `___TimeStampUpdated` - tracks any field modification

#### 2. `dbo.Prod` - Product Catalog
- **Fields:** PROD_SKU, CATEGORY, REF_COST, PROD_MAX_SELLPRICE, PROD_MAP_SELLPRICE, PROD_MIN_SALE_UNIT, PROD_LOCATION, PROD_STATUS
- **Tracking:** `___TimeStampUpdated` - tracks any field modification

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

## Proposed Update Flow Architecture

### Flow 1: New Catalog Creation
- **When:** Weekly or when new customers added
- **What:** Creates new catalogs that don't exist
- **How:** Run catalog configuration query
- **Check:** Query Shopify by catalog title to see if exists
- **Process:** Full catalog with all products and calculated prices

### Flow 2: PRICE Formula Updates (Optimized)
**Trigger:** PRICE table `___TimeStampUpdated > @LastRunDate`

**Detection Query:**
```sql
SELECT DISTINCT pr.PRICE_PROD_CAT, pr.price_cust_cat
FROM price pr
WHERE pr.___TimeStampUpdated > @LastRunDate
```

**Find Affected Catalogs:**
```sql
-- Individual catalogs
SELECT DISTINCT 'INDIVIDUAL' as CatalogType, c.CUSTID as UniqueKey,
    c.CUSTCATEGORY, c.CUSTPRICETIER, c.CUSTPRICEMARKUP, c.CUSTGROUPCODE,
    'DEUT' as PROD_CATEGORY  -- The changed product category
FROM cust c
WHERE c.CUSTCATEGORY = 'JD1'  -- Matches changed price_cust_cat
  AND c.CUSTMEMBERNUM IS NOT NULL
  AND EXISTS (SELECT 1 FROM specpr sp
              WHERE sp.SPECPR_TYPE = 'CI'
                AND sp.SPECPR_KEY = c.CUSTID
                AND sp.SPECPR_EXPIRE_DATE > GETDATE())

UNION

-- Shared catalogs
SELECT DISTINCT 'SHARED' as CatalogType,
    CONCAT(CUSTCATEGORY,'|',CUSTPRICETIER,'|',CUSTPRICEMARKUP,'|',CUSTGROUPCODE,'|0') as UniqueKey,
    CUSTCATEGORY, CUSTPRICETIER, CUSTPRICEMARKUP, CUSTGROUPCODE,
    'DEUT' as PROD_CATEGORY
FROM (SELECT DISTINCT CUSTCATEGORY, CUSTPRICETIER, CUSTPRICEMARKUP, CUSTGROUPCODE
      FROM cust
      WHERE CUSTCATEGORY = 'JD1' AND CUSTMEMBERNUM IS NOT NULL) configs
```

**Action:** Update ONLY products WHERE CATEGORY = changed PROD_CAT in affected catalogs

**Impact:** ~100 catalogs × ~200 products instead of all

### Flow 3: Daily Product/Special Price Updates

**Strategy: Batch by Product Category**

#### For Product Changes:
1. Get changed products
2. Group by CATEGORY
3. For each affected category → Update that category in ALL catalogs

```sql
-- Get changed products grouped by category
SELECT DISTINCT CATEGORY
FROM Prod
WHERE ___TimeStampUpdated > @LastRunDate
```

#### For CI (Customer Individual) Special Prices:
```sql
-- Get affected customer + product category
SELECT DISTINCT sp.SPECPR_KEY as CUSTID, p.CATEGORY
FROM [special price change sources] sp
INNER JOIN Prod p ON sp.SPECPR_SKU = p.PROD_SKU
WHERE sp.SPECPR_TYPE = 'CI'
```
**Action:** Update that product category in ONLY that customer's individual catalog

#### For GP (Group Pricing) Special Prices:
```sql
-- Get affected group + product category
SELECT DISTINCT sp.SPECPR_KEY as CUSTGROUPCODE, p.CATEGORY
FROM [special price change sources] sp
INNER JOIN Prod p ON sp.SPECPR_SKU = p.PROD_SKU
WHERE sp.SPECPR_TYPE = 'GP'
```
**Action:** Update that product category in ALL catalogs with that buying group

**Combined Change Sources for Special Prices:**
- New/Modified (timestamp)
- Expiring (date range)
- Starting (date range)
- Deleted (DeletedRowsKey)

---

## Celigo Flow Architecture

### Flow 1: New Catalog Creation
- **Frequency:** Weekly or on-demand
- **Purpose:** Create new catalogs that don't exist yet in Shopify
- **Trigger:** Manual or scheduled
- **Process:**
  1. Run catalog configuration query (same as Flow 2 Query 1)
  2. Check if catalog exists in Shopify by catalog title
  3. If doesn't exist → Create empty catalog + price list
  4. Populate with all products (35,000 products)
  5. Calculate prices using JavaScript functions
  6. Upload to Shopify via `priceListFixedPricesAdd` (batched 250 per call)
  7. Set quantity rules via `quantityRulesAdd`

**Notes:**
- Currently functional in Celigo
- Takes ~11 minutes per catalog
- Creates complete, ready-to-use catalogs
- Customer configuration changes (CUSTCATEGORY, TIER, MARKUP, GROUP) are handled by separate customer/company sync flow

---

### Flow 2: Update Product Prices (Incremental Updates)

**⚠️ DIFFERENT FROM Flow 1 - This updates existing catalogs only**

#### **Overview**
- **Frequency:** Every 2-4 hours (scheduled)
- **Purpose:** Update existing catalog prices when products/special prices/markup formulas change
- **Strategy:** Detect changes, determine minimal scope, update only what's needed
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

### Flow 2 Detailed Structure

#### **Step 1: Get All Catalog Sections**

**Query 1: Catalog Configuration Query (Divided by Product Category)**

Same query as new catalog creation, returns catalog configurations cross-joined with product categories for efficient batching.

**Output:** ~71,000 rows (1,150 catalogs × 62 categories)

**Example record:**
```json
{
  "CatalogType": "SHARED",
  "UniqueKey": "A2|0|0|...|0",
  "CUSTID": null,
  "CUSTCATEGORY": "A2",
  "CUSTPRICETIER": "0",
  "CUSTPRICEMARKUP": 0,
  "CUSTGROUPCODE": "...",
  "IS_MEMBER_NULL": 0,
  "PROD_CATEGORY": "ADAP"
}
```

**Key fields:**
- `CatalogType`: INDIVIDUAL or SHARED
- `UniqueKey`: Catalog identifier
- `CUSTID`: Customer ID (for Individual), NULL (for Shared)
- `CUSTCATEGORY`: Customer category (e.g., "A2", "JD1", "WP2")
- `CUSTPRICETIER`: Tier 0-10 (selects which markup column to use)
- `CUSTPRICEMARKUP`: Customer-specific markup adjustment
- `CUSTGROUPCODE`: Buying group code
- `PROD_CATEGORY`: Product category for this processing chunk

---

#### **Step 2: Check Changes Since Last Run**

**Query 2: Change Detection Query**

For each catalog section from Query 1, check if any changes affect it.

**Input parameters:**
- `@LastRunDate` - From Celigo timestamp tracking
- `@CatalogType` - From catalog section
- `@CUSTID` - From catalog section
- `@CUSTCATEGORY` - From catalog section
- `@CUSTGROUPCODE` - From catalog section
- `@PROD_CATEGORY` - From catalog section

**Output:**
```json
{
  "PriceFormulaChanged": 0,
  "ProductsChanged": 1,
  "CI_Changed": 0,
  "GP_Changed": 0,
  "NeedsUpdate": 1,
  "UpdateScope": "SKU"
}
```

**Field meanings:**
- `PriceFormulaChanged`: PRICE table markup formula changed (affects entire category)
- `ProductsChanged`: Product fields changed (REF_COST, MAX, MAP, CATEGORY)
- `CI_Changed`: Customer Individual special prices changed
- `GP_Changed`: Group special prices changed
- `NeedsUpdate`: 1 = process this section, 0 = skip
- `UpdateScope`: 'CATEGORY' = update all products, 'SKU' = update only changed SKUs

**Update Scope Logic:**
- If `PriceFormulaChanged = 1` → `UpdateScope = 'CATEGORY'` (PRICE change affects all products)
- Otherwise → `UpdateScope = 'SKU'` (only specific SKUs changed)

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

#### **Step 3: Branching Logic**

**Branch Point 1: NeedsUpdate?**
```
if NeedsUpdate = 0 → SKIP (go to next catalog section)
if NeedsUpdate = 1 → Proceed to Branch Point 2
```

**Branch Point 2: UpdateScope?**
```
if UpdateScope = 'CATEGORY' → PATH A (Full Category Update)
if UpdateScope = 'SKU' → PATH B (Specific SKUs Only)
```

---

#### **Step 4A: PATH A - Full Category Update**

**When triggered:**
- `PriceFormulaChanged = 1` (PRICE table markup changed)
- Any mix that includes PRICE change

**Why full category:**
- Markup formula affects ALL products in category
- Cannot optimize to specific SKUs

**Process:**
1. Use existing product query (Individual or Shared based on CatalogType)
2. Fetch ALL products in `@PROD_CATEGORY` (~500-1,000 products)
3. Calculate prices for all using JavaScript functions
4. Update Shopify via `priceListFixedPricesAdd` (batched 250 per call)

**Example result:**
```json
{
  "PriceFormulaChanged": 1,
  "ProductsChanged": 0,
  "NeedsUpdate": 1,
  "UpdateScope": "CATEGORY"
}
```

---

#### **Step 4B: PATH B - Specific SKUs Only** ⚡

**When triggered:**
- `ProductsChanged = 1` AND `PriceFormulaChanged = 0`
- `CI_Changed = 1` AND `PriceFormulaChanged = 0`
- `GP_Changed = 1` AND `PriceFormulaChanged = 0`
- Any SKU-level change without PRICE formula change

**Why specific SKUs:**
- Only specific products changed
- Can optimize by fetching/updating only those (5-50 SKUs vs 500-1,000)

**Process:**
1. **Query 3:** Get list of changed SKUs for this catalog section
2. Use modified product query (filtered by SKU list)
3. Fetch ONLY those SKUs' product data
4. Calculate prices for only those SKUs
5. Update Shopify via `priceListFixedPricesAdd` (batched 250 per call)

**Performance improvement:**
- Before: Update 1,150 catalogs × 500 DEUT products = 575,000 price updates
- After: Update 1,150 catalogs × 10 changed SKUs = 11,500 price updates
- **~50x faster!** 🚀

**Example result:**
```json
{
  "PriceFormulaChanged": 0,
  "ProductsChanged": 1,
  "NeedsUpdate": 1,
  "UpdateScope": "SKU"
}
```

---

### Flow 2 Query Summary

**Queries Used:**

1. ✅ **Query 1:** Get all catalog sections (divided by product category) - EXISTS
2. ✅ **Query 2:** Check changes for specific catalog section - CREATED
3. ⏳ **Query 3:** Get changed SKUs list (for PATH B) - PENDING
4. ✅ **Query 4A:** Fetch all products - SHARED (full category) - EXISTS
5. ✅ **Query 4B:** Fetch all products - INDIVIDUAL (full category) - EXISTS
6. ⏳ **Query 5A:** Fetch specific SKUs - SHARED (filtered) - PENDING
7. ⏳ **Query 5B:** Fetch specific SKUs - INDIVIDUAL (filtered) - PENDING

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

## Critical Outstanding Questions

1. **Can you update individual product prices in Shopify price lists without recreating the entire list?**
   - If YES → Can do surgical SKU-level updates (much faster)
   - If NO → Must batch by product category as proposed

2. **Current Shopify API usage:**
   - Are you using `priceListFixedPricesAdd` mutation?
   - Do you delete and recreate price lists or update existing?
   - Maximum 250 prices per mutation call

3. **What causes the 11-minute catalog creation time?**
   - SQL query to fetch products?
   - JavaScript price calculation?
   - Shopify API upload (most likely)?

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
- `PROJECT_CONTEXT.md` - This file

---

## Next Steps

1. **Confirm Shopify API capabilities** for individual price updates
2. **Design complete SQL queries** for update flow:
   - PRICE change detection → affected catalogs + products
   - Product change detection → grouping by category
   - Special price change detection → affected catalogs mapping
3. **Build Celigo flow structure** for incremental updates
4. **Test performance** of category-batched updates vs full regeneration
5. **Implement change tracking** mechanism to store @LastRunDate
6. **Create update validation** to ensure prices match C# calculation

---

## Contact & Clarifications

### Owner Clarifications Received:
1. **isMemberNull** = QuickBuy mode (anonymous checkout), not just "CUSTMEMBERNUM is null"
2. QuickBuy users should skip special pricing lookup entirely (IHU/106565 are wasteful placeholders)
3. PRICE formula changes are infrequent (<annually) and not time-sensitive
4. Hourly to 6-hour sync schedule is acceptable for PRICE changes

### Questions Pending:
1. Shopify API update capabilities (individual prices vs full price list replacement)
2. Current API implementation details (mutations used, deletion strategy)
3. Root cause of 11-minute catalog creation time

