// D1 em memória para testes: a mesma interface usada pelo Worker (prepare/bind/first/all/run/batch)
// sobre node:sqlite (Node 22.13+ sem flag), com a migração real aplicada e chaves estrangeiras ligadas como no D1.
import {DatabaseSync} from "node:sqlite";
import {readFileSync, readdirSync} from "node:fs";
import {join} from "node:path";

export function criarD1(pastaMigracoes, ate = null) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(pastaMigracoes).filter(f => f.endsWith(".sql") && (!ate || f <= ate)).sort()) db.exec(readFileSync(join(pastaMigracoes, f), "utf8"));
  const linha = r => (r ? {...r} : null);
  const declaracao = (sql, args = []) => ({
    sql, // instrumentação de interleavings/falhas nos testes, sem quebrar a atomicidade do batch
    bind: (...novos) => declaracao(sql, novos),
    async first(coluna) {
      const r = linha(db.prepare(sql).get(...args));
      return r && coluna ? r[coluna] : r;
    },
    async all() {
      return {success: true, results: db.prepare(sql).all(...args).map(linha), meta: {}};
    },
    run() {
      const s = db.prepare(sql);
      if (/\breturning\b/i.test(sql)) {
        const results = s.all(...args).map(linha);
        return {success: true, results, meta: {changes: results.length}};
      }
      const r = s.run(...args);
      return {success: true, results: [], meta: {changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid)}};
    },
  });
  return {
    sqlite: db,
    prepare: sql => declaracao(sql),
    async batch(lista) {
      db.exec("BEGIN");
      try {
        const saida = [];
        // Nenhum await entre statements: como no D1, outra requisição não entra no meio da transação.
        for (const s of lista) saida.push(s.run());
        db.exec("COMMIT");
        return saida;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
