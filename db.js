// db.js
import sql from "mssql";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, ".env") });

const config = {
  server: process.env.SQL_HOST || "127.0.0.1",
  database: process.env.SQL_DB || "BULBtest",
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    port: Number(process.env.SQL_PORT || 1433),
  },
};

console.log("[DB CONFIG]", {
  server: config.server,
  port: config.options.port,
  auth: "SQL login",
});

let poolPromise;
export function getPool() {
  if (!poolPromise) poolPromise = new sql.ConnectionPool(config).connect();
  return poolPromise;
}
export { sql };
