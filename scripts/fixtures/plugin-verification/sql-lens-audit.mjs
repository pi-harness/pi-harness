import { open } from 'node:fs/promises';
import console from 'node:console';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const path = fileURLToPath(new URL('./sql-lens-audit.sqlite', import.meta.url));
const reservation = await open(path, 'wx', 0o600);
await reservation.close();
const db = new DatabaseSync(path);
try {
  db.exec("CREATE TABLE audit(label TEXT, big INTEGER, payload BLOB, empty TEXT); INSERT INTO audit VALUES ('测试😀', 9223372036854775807, x'000102ff', NULL);");
} finally { db.close(); }
console.log('sql_audit_fixture CREATED');
