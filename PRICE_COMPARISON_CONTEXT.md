# Price Comparison Flow - Context

## Objective

Design a flow (separate from the main update flow) that:
1. Identifies which products need to be updated in Shopify catalogs
2. Compares the **calculated price** from the ERP with the **current price** in Shopify
3. Only flags products where the price actually changed
4. Uses the flagged data to drive the main price update flow

This prevents unnecessary Shopify API calls and database queries caused by the broad `___TimeStampUpdated` timestamp detection.

---

## Background: Why This Is Needed

### Current Problem
- The main delta detection query uses `___TimeStampUpdated` on the `Prod` table
- This timestamp fires for **ANY field change** (inventory, descriptions, status, etc.) - not just pricing fields
- The team is building a new field to track price-specific changes, but it is not ready yet
- **Current result:** ~3,000,000 individual product update calls, most of which are unnecessary

### Future Solution (When Ready)
- A new dedicated field will track only price-related changes in the `Prod` table
- Once available, this comparison flow may not be needed
- For now, this comparison flow bridges the gap

---

## System Architecture

### Platform Stack
- **Source:** Legacy ERP with SQL Server database + C# pricing functions
- **Integration:** Celigo (Standard/Lite plan)
- **Target:** Shopify B2B with catalogs and price lists
- **Scale:** ~1,150 catalogs, ~35,000 products, 62 product categories

### Catalog Types
- **Individual Catalogs:** Customers with active CI (Customer Individual) special pricing
  - Pricing: CI > GP > Standard Markup
  - Unique Key: CUSTID
  - ~200-300 catalogs
- **Shared Catalogs:** Customers WITHOUT CI pricing, grouped by configuration
  - Pricing: GP > Standard Markup (NO CI prices)
  - Unique Key: `CUSTCATEGORY|CUSTPRICETIER|CUSTPRICEMARKUP|CUSTGROUPCODE|0`
  - ~800-900 catalogs

---

## Pricing Logic (Source of Truth: C# Functions)

### Priority Order
1. **CI Special Price** (Customer Individual) - HIGHEST
   - From `specpr` table where `SPECPR_TYPE = 'CI'`
   - Requires: active approver, not expired
2. **GP Special Price** (Group Pricing) - SECOND
   - From `specpr` table where `SPECPR_TYPE = 'GP'`
   - Based on customer's `CUSTGROUPCODE`
3. **Standard Markup** - FALLBACK
   - Calculated from `price` table
   - Uses `CUSTCATEGORY` + `CUSTPRICETIER` + `CUSTPRICEMARKUP`
   - Applies WP2 ceiling, MAP floor, max price constraints

### Key Fields for Price Calculation
- `REF_COST` - Base product cost
- `PROD_MAX_SELLPRICE` - Max price ceiling
- `PROD_MAP_SELLPRICE` - Minimum Advertised Price floor
- `PROD_MIN_SALE_UNIT` - Minimum sale unit
- `PRICE_DEFAULT_LEVEL` - Default markup (when tier = 0)
- `PRICE_SELECTIONS` - Fallback markup (when selected markup = 0)
- `PRICE_MARKUP1` through `PRICE_MARKUP10` - Tier-based markups
- `REF_COST_EXPIRE_CYMD` - REF_COST expiration date
- `REF_COST_START_CYMD` - REF_COST effective start date

---

## Current Flow Architecture (Main Flows)

### Customer Sync Flow (Event-Driven)
- Detects customer changes including CI pricing changes
- Creates empty catalog + price list if it doesn't exist in Shopify
- Assigns catalog to customer
- Handles transition between Individual and Shared catalogs

### Flow 2: Populate New Catalogs (Scheduled)
- Detects newly created catalogs via timestamp filters
- Populates with ALL products across all 62 categories
- Processes one product category at a time to avoid timeouts

### Flow 3: Update Existing Catalog Prices (Scheduled)
- Uses combined change detection query (runs in seconds)
- Returns only affected catalog sections (1,000-5,000 instead of 71,000)
- Branches by: CatalogType (Individual/Shared) + UpdateScope (CATEGORY/SKU)
- Processes products one at a time (one-to-many pattern)
- Uses NOLOCK hints to prevent deadlocks

---

## Flow 3 Current Structure (Detail)

### Step 1: Delta Detection Query
Returns catalog sections needing updates with flags:
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

### Branching Logic
1. **Branch by CatalogType:** INDIVIDUAL or SHARED
2. **Branch by UpdateScope:**
   - `CATEGORY` → Fetch ALL products in category (PriceFormulaChanged = 1)
   - `SKU` → Fetch only changed SKUs (PriceFormulaChanged = 0)

### Step 2 (SKU path): Get Changed SKUs
- Query 1: Returns list of changed SKUs for that catalog section
- One-to-many expansion: Creates one record per SKU

### Step 3: Fetch Single Product Data
- Query 2: Fetches full pricing data for ONE SKU at a time
- Input uses `record._PARENT.*` for catalog config + `record.PROD_SKU`

### Step 4: Calculate Price
- Transform step using JavaScript pricing functions

### Step 5: Batch & Update Shopify
- Post response map hook groups into batches of 250
- `priceListFixedPricesAdd` mutation

---

## Known Issue: Unnecessary Updates

### Current Scale
- Delta detection: ~21,394 catalog sections affected
- Individual product calls: ~3,000,000
- Most triggered by non-pricing `___TimeStampUpdated` changes

### Root Cause
`___TimeStampUpdated` on `Prod` table fires for ANY field change, not just pricing fields.

### Temporary Fix: Price Comparison Flow (THIS CONTEXT FILE'S OBJECTIVE)

---

## New Objective: Price Comparison Flow

### Goal
Create a separate flow that:
1. Gets list of products that MIGHT need updating (from current delta detection)
2. Calculates what the new price SHOULD be
3. Fetches the CURRENT price from Shopify
4. Compares the two
5. Only flags records where price actually changed
6. Uses flagged records to drive Flow 3

### Available Data Sources
- **ERP (SQL Server):** Product data, pricing tables, special prices
- **Shopify API:** Current product prices in each catalog's price list
- **Celigo:** Can connect to both, run transformations, store intermediate data

### Key Design Decisions (To Be Made)
1. Where to store comparison results (temporary DB table, Celigo storage, file)
2. How to handle price precision (rounding, decimal comparison threshold)
3. Whether to run as pre-filter before Flow 3 or as a separate scheduled flow
4. How to pass flagged results to Flow 3

### Proposed Approach
**Two-flow approach:**
- **Flow A (Pre-filter):** Calculate + compare prices, store flagged records
- **Flow B (Update):** Read flagged records, update Shopify (existing Flow 3 logic)

---

## Technical Constraints
- Celigo query timeout: 15 seconds maximum
- Shopify API: 250 prices per `priceListFixedPricesAdd` call
- SQL deadlocks: Prevented with `WITH (NOLOCK)` on all read queries
- Celigo concurrency: Limited to 5-10 parallel operations to prevent DB/API overload
- Limited number of available Celigo flows

---

## Next Steps (For New Conversation)
1. Design the price comparison logic
2. Determine where to store comparison results
3. Build the comparison flow structure in Celigo
4. Connect comparison results to Flow 3
5. Test and validate price accuracy
