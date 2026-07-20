import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

export function certifyNativeSqlite(databasePath) {
  const db = new Database(databasePath);
  try {
    db.pragma('foreign_keys = ON');
    const journalMode = db.pragma('journal_mode = WAL', { simple: true });
    db.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE child (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES parent(id),
        value TEXT NOT NULL
      );
    `);
    const commit = db.transaction(() => {
      db.prepare('INSERT INTO parent (name) VALUES (?)').run('committed');
      db.prepare('INSERT INTO child (parent_id, value) VALUES (?, ?)').run(1, 'visible');
    });
    commit();
    try {
      const rollback = db.transaction(() => {
        db.prepare('INSERT INTO parent (name) VALUES (?)').run('rolled-back');
        throw new Error('intentional certification rollback');
      });
      rollback();
    } catch (error) {
      if (error.message !== 'intentional certification rollback') throw error;
    }
    const committedRows = db.prepare('SELECT count(*) AS count FROM parent').get().count;
    if (committedRows !== 1) throw new Error(`expected one committed row, found ${committedRows}`);
    return { journalMode, committedRows, sqliteVersion: db.prepare('select sqlite_version() AS version').get().version };
  } finally {
    db.close();
  }
}

export function verifyNativeSqliteRestart(databasePath) {
  const db = new Database(databasePath);
  try {
    db.pragma('foreign_keys = ON');
    const child = db.prepare('SELECT value FROM child WHERE parent_id = 1').get();
    const foreignKeys = db.pragma('foreign_key_check');
    const integrity = db.pragma('integrity_check', { simple: true });
    if (child?.value !== 'visible') throw new Error('committed child was not durable after restart');
    if (foreignKeys.length !== 0) throw new Error('foreign_key_check returned violations');
    if (integrity !== 'ok') throw new Error(`integrity_check returned ${integrity}`);
    return { child: child.value, integrity };
  } finally {
    db.close();
  }
}
