DECLARE @LastRunStr nvarchar(100) = {{dateAdd lastExportDateTime "-18000000" }};
{{!--DECLARE @LastRunStr nvarchar(100) = '2026-05-06T18:20:37.303Z'--}}

SET @LastRunStr = REPLACE(@LastRunStr, '''', '');
SET @LastRunStr = REPLACE(@LastRunStr, '"', '');
SET @LastRunStr = REPLACE(@LastRunStr, 'T', ' ');
SET @LastRunStr = REPLACE(@LastRunStr, 'Z', '');

DECLARE @LastRun datetime2(3) =
  COALESCE(
    TRY_CONVERT(datetime2(3), @LastRunStr, 121),
    TRY_CONVERT(datetime2(3), @LastRunStr)
  );

WITH AllChanges AS (

    SELECT
        LTRIM(RTRIM(c.CUSTID)) AS CUSTID,
        c.___TimeStampUpdated AS changed_at,
        1 AS changed_cust,
        0 AS changed_contact,
        0 AS changed_shipto,
        0 AS changed_ci_pricing,
        0 AS deleted_cust,
        0 AS deleted_contact,
        0 AS deleted_shipto
    FROM dbo.cust c
    WHERE
        c.___TimeStampUpdated >= @LastRun
        AND EXISTS (
            SELECT 1
            FROM dbo.states s
            WHERE
                LTRIM(RTRIM(s.STATES_ABBREV)) = LTRIM(RTRIM(c.CUSTSTATE))
                AND LTRIM(RTRIM(s.STATES_ALLOW_ON_WEB)) = 'Y'
        )

    UNION ALL

    SELECT
        LTRIM(RTRIM(ct.Contact_Custid)) AS CUSTID,
        ct.Contact_Date AS changed_at,
        0 AS changed_cust,
        1 AS changed_contact,
        0 AS changed_shipto,
        0 AS changed_ci_pricing,
        0 AS deleted_cust,
        0 AS deleted_contact,
        0 AS deleted_shipto
    FROM dbo.Contact ct
    WHERE
        ct.Contact_Date >= @LastRun
        AND EXISTS (
            SELECT 1
            FROM dbo.cust c
            JOIN dbo.states s
                ON LTRIM(RTRIM(s.STATES_ABBREV)) = LTRIM(RTRIM(c.CUSTSTATE))
                AND LTRIM(RTRIM(s.STATES_ALLOW_ON_WEB)) = 'Y'
            WHERE
                LTRIM(RTRIM(c.CUSTID)) = LTRIM(RTRIM(ct.Contact_Custid))
        )

    UNION ALL

    SELECT
        LTRIM(RTRIM(st.SHIPTO_ID)) AS CUSTID,
        st.___TimeStampUpdated AS changed_at,
        0 AS changed_cust,
        0 AS changed_contact,
        1 AS changed_shipto,
        0 AS changed_ci_pricing,
        0 AS deleted_cust,
        0 AS deleted_contact,
        0 AS deleted_shipto
    FROM dbo.SHIPTO st
    WHERE
        st.___TimeStampUpdated >= @LastRun
        AND EXISTS (
            SELECT 1
            FROM dbo.cust c
            JOIN dbo.states s
                ON LTRIM(RTRIM(s.STATES_ABBREV)) = LTRIM(RTRIM(c.CUSTSTATE))
                AND LTRIM(RTRIM(s.STATES_ALLOW_ON_WEB)) = 'Y'
            WHERE
                LTRIM(RTRIM(c.CUSTID)) = LTRIM(RTRIM(st.SHIPTO_ID))
        )

    UNION ALL

    SELECT
        LTRIM(RTRIM(sp.SPECPR_KEY)) AS CUSTID,
        sp.___TimeStampUpdated AS changed_at,
        0 AS changed_cust,
        0 AS changed_contact,
        0 AS changed_shipto,
        1 AS changed_ci_pricing,
        0 AS deleted_cust,
        0 AS deleted_contact,
        0 AS deleted_shipto
    FROM dbo.specpr sp
    WHERE
        sp.SPECPR_TYPE = 'CI'
        AND sp.___TimeStampUpdated >= @LastRun
        AND sp.SPECPR_APPROVER IS NOT NULL
        AND LTRIM(RTRIM(sp.SPECPR_APPROVER)) <> ''
        AND sp.SPECPR_EXPIRE_DATE > GETDATE()
        AND EXISTS (
            SELECT 1
            FROM dbo.cust c
            JOIN dbo.states s
                ON LTRIM(RTRIM(s.STATES_ABBREV)) = LTRIM(RTRIM(c.CUSTSTATE))
                AND LTRIM(RTRIM(s.STATES_ALLOW_ON_WEB)) = 'Y'
            WHERE
                LTRIM(RTRIM(c.CUSTID)) = LTRIM(RTRIM(sp.SPECPR_KEY))
        )

    UNION ALL

    SELECT
        LTRIM(RTRIM(sp.SPECPR_KEY)) AS CUSTID,
        sp.SPECPR_EXPIRE_DATE AS changed_at,
        0 AS changed_cust,
        0 AS changed_contact,
        0 AS changed_shipto,
        1 AS changed_ci_pricing,
        0 AS deleted_cust,
        0 AS deleted_contact,
        0 AS deleted_shipto
    FROM dbo.specpr sp
    WHERE
        sp.SPECPR_TYPE = 'CI'
        AND sp.SPECPR_EXPIRE_DATE BETWEEN @LastRun AND GETDATE()
        AND sp.SPECPR_APPROVER IS NOT NULL
        AND LTRIM(RTRIM(sp.SPECPR_APPROVER)) <> ''
        AND EXISTS (
            SELECT 1
            FROM dbo.cust c
            JOIN dbo.states s
                ON LTRIM(RTRIM(s.STATES_ABBREV)) = LTRIM(RTRIM(c.CUSTSTATE))
                AND LTRIM(RTRIM(s.STATES_ALLOW_ON_WEB)) = 'Y'
            WHERE
                LTRIM(RTRIM(c.CUSTID)) = LTRIM(RTRIM(sp.SPECPR_KEY))
        )

    UNION ALL

    SELECT
        LTRIM(RTRIM(sp.SPECPR_KEY)) AS CUSTID,
        sp.SPECPR_START_DATE AS changed_at,
        0 AS changed_cust,
        0 AS changed_contact,
        0 AS changed_shipto,
        1 AS changed_ci_pricing,
        0 AS deleted_cust,
        0 AS deleted_contact,
        0 AS deleted_shipto
    FROM dbo.specpr sp
    WHERE
        sp.SPECPR_TYPE = 'CI'
        AND sp.SPECPR_START_DATE BETWEEN @LastRun AND GETDATE()
        AND sp.SPECPR_EXPIRE_DATE > GETDATE()
        AND sp.SPECPR_APPROVER IS NOT NULL
        AND LTRIM(RTRIM(sp.SPECPR_APPROVER)) <> ''
        AND EXISTS (
            SELECT 1
            FROM dbo.cust c
            JOIN dbo.states s
                ON LTRIM(RTRIM(s.STATES_ABBREV)) = LTRIM(RTRIM(c.CUSTSTATE))
                AND LTRIM(RTRIM(s.STATES_ALLOW_ON_WEB)) = 'Y'
            WHERE
                LTRIM(RTRIM(c.CUSTID)) = LTRIM(RTRIM(sp.SPECPR_KEY))
        )

    UNION ALL

    SELECT
        LTRIM(RTRIM(drk.Key2)) AS CUSTID,
        drk.___TimeStampUpdated AS changed_at,
        0 AS changed_cust,
        0 AS changed_contact,
        0 AS changed_shipto,
        1 AS changed_ci_pricing,
        0 AS deleted_cust,
        0 AS deleted_contact,
        0 AS deleted_shipto
    FROM dbo.DeletedRowsKey drk
    WHERE
        drk.___TimeStampUpdated >= @LastRun
        AND drk.ACKDate IS NULL
        AND drk.TableName = 'SPECPR'
        AND drk.Key1 = 'CI'
        AND EXISTS (
            SELECT 1
            FROM dbo.cust c
            JOIN dbo.states s
                ON LTRIM(RTRIM(s.STATES_ABBREV)) = LTRIM(RTRIM(c.CUSTSTATE))
                AND LTRIM(RTRIM(s.STATES_ALLOW_ON_WEB)) = 'Y'
            WHERE
                LTRIM(RTRIM(c.CUSTID)) = LTRIM(RTRIM(drk.Key2))
        )

    UNION ALL

    SELECT
        drk.Key2 AS CUSTID,
        drk.___TimeStampUpdated AS changed_at,
        0 AS changed_cust,
        0 AS changed_contact,
        0 AS changed_shipto,
        0 AS changed_ci_pricing,
        CASE WHEN drk.TableName = 'cust'    THEN 1 ELSE 0 END AS deleted_cust,
        CASE WHEN drk.TableName = 'Contact' THEN 1 ELSE 0 END AS deleted_contact,
        CASE WHEN drk.TableName = 'SHIPTO'  THEN 1 ELSE 0 END AS deleted_shipto
    FROM dbo.DeletedRowsKey drk
    WHERE
        drk.___TimeStampUpdated >= @LastRun
        AND drk.ACKDate IS NULL
        AND drk.TableName IN ('cust', 'Contact', 'SHIPTO')
)

SELECT
    ac.CUSTID,
    MAX(ac.changed_at) AS last_changed_at,
    MAX(ac.changed_cust) AS changed_cust,
    MAX(ac.changed_contact) AS changed_contact,
    MAX(ac.changed_shipto) AS changed_shipto,
    MAX(ac.changed_ci_pricing) AS changed_ci_pricing,
    MAX(ac.deleted_cust) AS deleted_cust,
    MAX(ac.deleted_contact) AS deleted_contact,
    MAX(ac.deleted_shipto) AS deleted_shipto,
    LTRIM(RTRIM(c.CUSTCATEGORY)) AS CUSTCATEGORY,
    LTRIM(RTRIM(c.CUSTTERMS)) AS CUSTTERMS,
    LTRIM(RTRIM(c.CUSTPRICETIER)) AS CUSTPRICETIER
FROM AllChanges ac
LEFT JOIN dbo.cust c
    ON LTRIM(RTRIM(c.CUSTID)) = ac.CUSTID
WHERE
    (c.CUSTID IS NULL OR c.CUSTID NOT IN ('91929','15189','02352','04194','101867','03280','69108','06493','33981','95869','06151','93866','02778','103851','02550','62326','106565'))

GROUP BY
    ac.CUSTID,
    c.CUSTCATEGORY,
    c.CUSTTERMS,
    c.CUSTPRICETIER
ORDER BY
    MAX(ac.changed_at) ASC;
