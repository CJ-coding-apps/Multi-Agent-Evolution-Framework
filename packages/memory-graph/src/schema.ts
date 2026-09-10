// KuzuDB DDL for the MAF memory graph

export const SCHEMA_DDL = `
CREATE NODE TABLE IF NOT EXISTS MemoryNode (
  id         STRING,
  kind       STRING,
  label      STRING,
  properties STRING,
  run_id     STRING,
  created_at STRING,
  updated_at STRING,
  PRIMARY KEY (id)
);

CREATE REL TABLE IF NOT EXISTS MemoryEdge (
  FROM MemoryNode TO MemoryNode,
  id        STRING,
  relation  STRING,
  weight    DOUBLE,
  metadata  STRING,
  created_at STRING
);
`;
