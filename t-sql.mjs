import initSqlJs from 'sql.js';
import path from 'node:path';
const p = path.resolve('node_modules/sql.js/dist/sql-wasm.wasm');
const SQL = await initSqlJs({ locateFile: () => p });
const db = new SQL.Database();
db.run('create table t(a)'); db.run('insert into t values (42)');
console.log(JSON.stringify(db.exec('select * from t')));
