const clone = (row) => JSON.parse(JSON.stringify(row));

export function createFakeDb() {
  const tables = new Map();

  class Query {
    constructor(table) {
      this.table = table;
      this.op = 'select';
      this.filters = [];
      this.limitCount = null;
    }
    select() { return this; }
    eq(column, value) { this.filters.push([column, value]); return this; }
    limit(count) { this.limitCount = count; return this; }
    insertIfAbsent(row) {
      this.op = 'insertIfAbsent';
      this.row = clone(row);
      return this;
    }
    update(patch) {
      this.op = 'update';
      this.patch = clone(patch);
      return this;
    }
    matches(row) {
      return this.filters.every(([column, value]) => row[column] === value);
    }
    run() {
      const rows = tables.get(this.table);
      const matched = rows.filter((row) => this.matches(row));
      if (this.op === 'insertIfAbsent') {
        if (matched.length) return { data: [], error: null };
        rows.push(this.row);
        return { data: [clone(this.row)], error: null };
      }
      if (this.op === 'update') {
        for (const row of matched) Object.assign(row, this.patch);
        return { data: matched.map(clone), error: null };
      }
      let data = matched;
      if (this.limitCount) data = data.slice(0, this.limitCount);
      return { data: data.map(clone), error: null };
    }
    then(resolve, reject) {
      try { resolve(this.run()); } catch (error) { reject(error); }
    }
  }

  return {
    from(table) {
      if (!tables.has(table)) tables.set(table, []);
      return new Query(table);
    },
    tables,
  };
}
