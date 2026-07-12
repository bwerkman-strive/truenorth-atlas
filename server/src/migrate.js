import { migrate, pool } from './db.js';
migrate().then(() => { console.log('migrated'); return pool.end(); })
  .catch(e => { console.error(e); process.exit(1); });
