-- Count distinct combinations of CUSTCATEGORY + CUSTPRICETIER + CUSTPRICEMARKUP
-- This shows how many different shared catalog configurations exist

-- Option 1: Just the count
SELECT COUNT(*) AS TotalCombinations
FROM (
  SELECT DISTINCT
    NULLIF(LTRIM(RTRIM(CUSTCATEGORY)), '') AS CustCategory,
    ISNULL(CUSTPRICETIER, 0) AS PriceTier,
    ISNULL(CUSTPRICEMARKUP, 0) AS PriceMarkup
  FROM dbo.cust
  WHERE CUSTID NOT IN (
    -- Exclude customers with individual catalogs (CI special pricing)
    SELECT DISTINCT SPECPR_KEY
    FROM dbo.specpr
    WHERE SPECPR_TYPE = 'CI'
      AND SPECPR_EXPIRE_DATE > GETDATE()
      AND SPECPR_APPROVER IS NOT NULL
      AND LTRIM(RTRIM(SPECPR_APPROVER)) <> ''
  )
) AS Combinations;

-- Option 2: Show all combinations with customer counts
SELECT
  NULLIF(LTRIM(RTRIM(CUSTCATEGORY)), '') AS CustCategory,
  ISNULL(CUSTPRICETIER, 0) AS PriceTier,
  ISNULL(CUSTPRICEMARKUP, 0) AS PriceMarkup,
  COUNT(*) AS CustomerCount
FROM dbo.cust
WHERE CUSTID NOT IN (
  -- Exclude customers with individual catalogs (CI special pricing)
  SELECT DISTINCT SPECPR_KEY
  FROM dbo.specpr
  WHERE SPECPR_TYPE = 'CI'
    AND SPECPR_EXPIRE_DATE > GETDATE()
    AND SPECPR_APPROVER IS NOT NULL
    AND LTRIM(RTRIM(SPECPR_APPROVER)) <> ''
)
GROUP BY
  NULLIF(LTRIM(RTRIM(CUSTCATEGORY)), ''),
  ISNULL(CUSTPRICETIER, 0),
  ISNULL(CUSTPRICEMARKUP, 0)
ORDER BY CustomerCount DESC, CustCategory, PriceTier, PriceMarkup;

-- Option 3: Include ALL customers (with and without individual catalogs)
-- to see the full spectrum
SELECT
  NULLIF(LTRIM(RTRIM(CUSTCATEGORY)), '') AS CustCategory,
  ISNULL(CUSTPRICETIER, 0) AS PriceTier,
  ISNULL(CUSTPRICEMARKUP, 0) AS PriceMarkup,
  COUNT(*) AS CustomerCount,
  SUM(CASE WHEN c.CUSTID IN (
    SELECT DISTINCT SPECPR_KEY
    FROM dbo.specpr
    WHERE SPECPR_TYPE = 'CI'
      AND SPECPR_EXPIRE_DATE > GETDATE()
      AND SPECPR_APPROVER IS NOT NULL
      AND LTRIM(RTRIM(SPECPR_APPROVER)) <> ''
  ) THEN 1 ELSE 0 END) AS CustomersWithIndividualCatalog
FROM dbo.cust c
GROUP BY
  NULLIF(LTRIM(RTRIM(CUSTCATEGORY)), ''),
  ISNULL(CUSTPRICETIER, 0),
  ISNULL(CUSTPRICEMARKUP, 0)
ORDER BY CustomerCount DESC, CustCategory, PriceTier, PriceMarkup;
