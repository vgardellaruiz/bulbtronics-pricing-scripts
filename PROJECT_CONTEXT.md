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
    -- Gets customers with active CI special pricing
    SELECT DISTINCT sp.SPECPR_KEY as CUSTID
    FROM dbo.specpr sp
    WHERE sp.SPECPR_TYPE = 'CI'
        AND sp.SPECPR_APPROVER IS NOT NULL
        AND LTRIM(RTRIM(sp.SPECPR_APPROVER)) <> ''
        AND sp.SPECPR_EXPIRE_DATE > GETDATE()
),
IndividualCatalogs AS (
    -- One catalog per customer with CI pricing
    SELECT 'INDIVIDUAL' as CatalogType, c.CUSTID as UniqueKey, ...
    FROM dbo.cust c
    INNER JOIN CustomersWithIndividualPricing ci ON c.CUSTID = ci.CUSTID
    WHERE c.CUSTMEMBERNUM IS NOT NULL
),
SharedCatalogs AS (
    -- Distinct configurations for customers without CI
    SELECT DISTINCT 'SHARED' as CatalogType,
        CONCAT(CUSTCATEGORY,'|',CUSTPRICETIER,'|',CUSTPRICEMARKUP,'|',CUSTGROUPCODE,'|0') as UniqueKey, ...
    FROM dbo.cust c
    LEFT JOIN CustomersWithIndividualPricing ci ON c.CUSTID = ci.CUSTID
    WHERE ci.CUSTID IS NULL
        AND c.CUSTMEMBERNUM IS NOT NULL
),
ProductCategories AS (
    -- All product categories from pricat table
    SELECT DISTINCT LTRIM(RTRIM(PRICAT_CATEGORY)) AS PROD_CATEGORY
    FROM dbo.pricat
),
AllCatalogs AS (
    -- CROSS JOIN catalogs with categories for chunking
    SELECT * FROM IndividualCatalogs CROSS JOIN ProductCategories
    UNION ALL
    SELECT * FROM SharedCatalogs CROSS JOIN ProductCategories
)
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

**Important Joins:**
```sql
LEFT JOIN dbo.price pr
    ON LTRIM(RTRIM(pr.PRICE_PROD_CAT)) = LTRIM(RTRIM(rp.CATEGORY))
    AND pr.price_cust_cat = @EffectiveCategory

LEFT JOIN dbo.price prWP2
    ON LTRIM(RTRIM(prWP2.PRICE_PROD_CAT)) = 'WP2'
    AND prWP2.price_cust_cat = @EffectiveCategory

LEFT JOIN dbo.specpr spCI
    ON spCI.SPECPR_TYPE = 'CI'
    AND LTRIM(RTRIM(spCI.SPECPR_SKU)) = rp.PROD_SKU
    AND spCI.SPECPR_KEY = @EffectiveCustomerID
    AND spCI.SPECPR_EXPIRE_DATE > GETDATE()

LEFT JOIN dbo.specpr spGP
    ON spGP.SPECPR_TYPE = 'GP'
    AND LTRIM(RTRIM(spGP.SPECPR_SKU)) = rp.PROD_SKU
    AND spGP.SPECPR_KEY = @EffectiveGroupCode
    AND spGP.SPECPR_EXPIRE_DATE > GETDATE()
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
