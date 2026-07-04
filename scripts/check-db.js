import Database from 'better-sqlite3';

const db = new Database('C:\\Users\\PC Omar\\Downloads\\sistema-bk\\prisma\\dev.db');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log('Tables:', JSON.stringify(tables));

for (const t of tables) {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM "' + t.name + '"').get();
  console.log(t.name + ': ' + count.cnt + ' rows');
}

db.close();
