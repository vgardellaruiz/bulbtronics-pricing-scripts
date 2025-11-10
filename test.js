import { getPool } from "./db.js";

try {
  const pool = await getPool();
  const { recordset } = await pool.request().query("SELECT 1 AS ok");
  console.log("TEST OK ->", recordset);
  process.exit(0);
} catch (e) {
  console.error("TEST FAIL ->", e);
  process.exit(1);
}
