// Moving a memory graph between Kùzu versions, and between backends.
//
// Kùzu changed its on-disk format before 1.0 and 0.11.3 cannot read a 0.7.x graph. The
// migration is therefore an export/import, not a compatibility test (D-58): this module
// writes plain nodes, edges and JSON properties, and reads them back into a fresh graph.
// Nothing here knows a Cypher dialect beyond the queries below, so a later importer for
// another backend reads the same file.
import type { GraphQueryRunner, GraphRow } from '@maf/types';

export const GRAPH_EXPORT_FORMAT = 'maf-graph';
export const GRAPH_EXPORT_FORMAT_VERSION = 1;

/** The plain shape written to disk: no Kùzu identifiers, no storage addresses. */
export interface ExportedNode {
  id:         string;
  kind:       string;
  label:      string;
  properties: Record<string, unknown>;
  runId:      string;
  createdAt:  string;
  updatedAt:  string;
}

export interface ExportedEdge {
  id:        string;
  fromId:    string;
  toId:      string;
  relation:  string;
  weight:    number;
  metadata:  Record<string, unknown>;
  createdAt: string;
}

export interface GraphExport {
  format:        typeof GRAPH_EXPORT_FORMAT;
  formatVersion: number;
  /** The Kùzu library that wrote this file, for the record; import does not depend on it. */
  kuzuVersion:   string;
  exportedAt:    string;
  nodes:         ExportedNode[];
  edges:         ExportedEdge[];
}

export interface ImportReport {
  nodesCreated: number;
  edgesCreated: number;
}

/** A refused import or export, with a sentence a user can act on. */
export class GraphTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphTransferError';
  }
}

/**
 * Reads every node and edge out of `graph`. Ordered by id so the same graph always produces
 * the same file. A stored `properties`/`metadata` blob that is not JSON aborts the export:
 * a rescue tool that silently rewrites a bad row as `{}` loses exactly the data it exists to
 * carry.
 */
export async function exportGraph(graph: GraphQueryRunner, kuzuVersion: string): Promise<GraphExport> {
  const nodeRows = await graph.run({
    cypher: `MATCH (n:MemoryNode)
     RETURN n.id AS id, n.kind AS kind, n.label AS label, n.properties AS properties,
            n.run_id AS runId, n.created_at AS createdAt, n.updated_at AS updatedAt
     ORDER BY id`,
    params: {},
  });
  const edgeRows = await graph.run({
    cypher: `MATCH (a:MemoryNode)-[e:MemoryEdge]->(b:MemoryNode)
     RETURN e.id AS id, a.id AS fromId, b.id AS toId, e.relation AS relation,
            e.weight AS weight, e.metadata AS metadata, e.created_at AS createdAt
     ORDER BY id`,
    params: {},
  });

  const nodes = nodeRows.map(exportedNode);
  const edges = edgeRows.map(exportedEdge);
  // An export the importer would refuse is not an export. The rows are checked while they are
  // still in hand — before the caller writes a byte — because a rescue file that cannot be read
  // back fails at exactly the moment it is needed.
  assertExportable(nodes, edges);

  return {
    format: GRAPH_EXPORT_FORMAT,
    formatVersion: GRAPH_EXPORT_FORMAT_VERSION,
    kuzuVersion,
    exportedAt: new Date().toISOString(),
    nodes,
    edges,
  };
}

const NODE_REQUIRED_FIELDS = ['id', 'kind', 'label', 'runId', 'createdAt', 'updatedAt'] as const;
const EDGE_REQUIRED_FIELDS = ['id', 'fromId', 'toId', 'relation', 'createdAt'] as const;

/**
 * The export half of the import's own rules: every field `parseGraphExport` requires non-empty,
 * and a weight it requires finite. The first bad row stops the export, naming the row and the
 * field; no file is written, because the caller only writes what this function returned.
 */
function assertExportable(nodes: ExportedNode[], edges: ExportedEdge[]): void {
  nodes.forEach((node, i) => {
    const where = `node ${i} (MemoryNode ${JSON.stringify(node.id || '(no id)')})`;
    for (const field of NODE_REQUIRED_FIELDS) {
      if (node[field] === '') {
        throw new GraphTransferError(
          `Cannot export ${where}: ${field} is empty. The importer requires it, so the file would be unreadable.`,
        );
      }
    }
  });
  edges.forEach((edge, i) => {
    const where = `edge ${i} (MemoryEdge ${JSON.stringify(edge.id || '(no id)')})`;
    for (const field of EDGE_REQUIRED_FIELDS) {
      if (edge[field] === '') {
        throw new GraphTransferError(
          `Cannot export ${where}: ${field} is empty. The importer requires it, so the file would be unreadable.`,
        );
      }
    }
    if (!Number.isFinite(edge.weight)) {
      throw new GraphTransferError(
        `Cannot export ${where}: weight is ${String(edge.weight)}, not a finite number. The importer requires one, so the file would be unreadable.`,
      );
    }
  });
}

/**
 * Parses and validates an export file. The file is input, not a trusted artifact: every field
 * is checked before a single row is written, and the error names the row that failed.
 */
export function parseGraphExport(text: string, source: string): GraphExport {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new GraphTransferError(`${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const file = asRecord(value, source);
  if (file['format'] !== GRAPH_EXPORT_FORMAT) {
    throw new GraphTransferError(
      `${source} is not a maf graph export (format is ${JSON.stringify(file['format'] ?? null)}, expected ${JSON.stringify(GRAPH_EXPORT_FORMAT)}).`,
    );
  }
  const formatVersion = file['formatVersion'];
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new GraphTransferError(`${source} has no valid formatVersion (got ${JSON.stringify(formatVersion ?? null)}).`);
  }
  if (formatVersion > GRAPH_EXPORT_FORMAT_VERSION) {
    throw new GraphTransferError(
      `${source} was written with graph format ${formatVersion}; this maf reads format ${GRAPH_EXPORT_FORMAT_VERSION}. Upgrade maf to import it.`,
    );
  }

  const nodes = asArray(file['nodes'], `${source}: nodes`)
    .map((node, i) => exportedNodeFrom(node, `${source}: nodes[${i}]`));
  const edges = asArray(file['edges'], `${source}: edges`)
    .map((edge, i) => exportedEdgeFrom(edge, `${source}: edges[${i}]`));
  validateGraph(nodes, edges, source);

  return {
    format: GRAPH_EXPORT_FORMAT,
    formatVersion,
    kuzuVersion: typeof file['kuzuVersion'] === 'string' ? file['kuzuVersion'] : 'unknown',
    exportedAt: typeof file['exportedAt'] === 'string' ? file['exportedAt'] : '',
    nodes,
    edges,
  };
}

/**
 * Writes a parsed export into `graph`, which must be empty. Every value is bound; the only
 * text assembled is the fixed query skeleton. A transaction means a failure leaves either the
 * whole graph or none of it, and the final count is compared to the file so a silently
 * skipped row (a `MATCH` that wrote nothing, say) is an error rather than a success line.
 */
export async function importGraph(graph: GraphQueryRunner, exported: GraphExport): Promise<ImportReport> {
  if (exported.formatVersion > GRAPH_EXPORT_FORMAT_VERSION) {
    throw new GraphTransferError(`The export uses graph format ${exported.formatVersion}; this maf writes format ${GRAPH_EXPORT_FORMAT_VERSION}.`);
  }
  // `parseGraphExport` has already checked a file, but this function is exported on its own and a
  // caller may hand it an object it built. An edge whose endpoint is missing makes its `MATCH`
  // write nothing, which would otherwise commit the nodes and fail only the count afterwards.
  validateGraph(exported.nodes, exported.edges, 'The export');

  const existing = await graph.run({ cypher: `MATCH (n:MemoryNode) RETURN count(n) AS c`, params: {} });
  const count = Number(existing[0]?.['c'] ?? 0);
  if (count !== 0) {
    throw new GraphTransferError(
      `The target graph already holds ${count} node(s). Import expects a fresh database: move it aside or choose another path with --db.`,
    );
  }

  await graph.run({ cypher: `BEGIN TRANSACTION`, params: {} });
  try {
    for (const node of exported.nodes) {
      await graph.run({
        cypher: `CREATE (:MemoryNode {id: $id, kind: $kind, label: $label, properties: $properties, run_id: $runId, created_at: $createdAt, updated_at: $updatedAt})`,
        params: {
          id: node.id, kind: node.kind, label: node.label, properties: JSON.stringify(node.properties),
          runId: node.runId, createdAt: node.createdAt, updatedAt: node.updatedAt,
        },
      });
    }
    for (const edge of exported.edges) {
      await graph.run({
        cypher: `MATCH (a:MemoryNode {id: $fromId}), (b:MemoryNode {id: $toId})
         CREATE (a)-[:MemoryEdge {id: $id, relation: $relation, weight: $weight, metadata: $metadata, created_at: $createdAt}]->(b)`,
        params: {
          fromId: edge.fromId, toId: edge.toId, id: edge.id, relation: edge.relation,
          weight: edge.weight, metadata: JSON.stringify(edge.metadata), createdAt: edge.createdAt,
        },
      });
    }
    await graph.run({ cypher: `COMMIT`, params: {} });
  } catch (err) {
    try { await graph.run({ cypher: `ROLLBACK`, params: {} }); } catch { /* the original failure is the one to report */ }
    throw err;
  }

  const nodeCount = Number((await graph.run({ cypher: `MATCH (n:MemoryNode) RETURN count(n) AS c`, params: {} }))[0]?.['c'] ?? -1);
  const edgeCount = Number((await graph.run({ cypher: `MATCH ()-[e:MemoryEdge]->() RETURN count(e) AS c`, params: {} }))[0]?.['c'] ?? -1);
  if (nodeCount !== exported.nodes.length || edgeCount !== exported.edges.length) {
    // Unreachable with the transaction above, but a count is the only thing that proves it.
    throw new GraphTransferError(
      `Import wrote ${nodeCount} nodes and ${edgeCount} edges, but the file holds ${exported.nodes.length} and ${exported.edges.length}.`,
    );
  }
  return { nodesCreated: nodeCount, edgesCreated: edgeCount };
}

/** The largest node or edge array a single import reads: a bound, not a recommendation. */
export const MAX_IMPORT_ROWS = 1_000_000;

function exportedNode(row: GraphRow): ExportedNode {
  const id = String(row['id'] ?? '');
  return {
    id,
    kind:       String(row['kind'] ?? ''),
    label:      String(row['label'] ?? ''),
    properties: parseJsonObject(String(row['properties'] ?? '{}'), `MemoryNode ${id} properties`),
    runId:      String(row['runId'] ?? ''),
    createdAt:  String(row['createdAt'] ?? ''),
    updatedAt:  String(row['updatedAt'] ?? ''),
  };
}

function exportedEdge(row: GraphRow): ExportedEdge {
  const id = String(row['id'] ?? '');
  return {
    id,
    fromId:    String(row['fromId'] ?? ''),
    toId:      String(row['toId'] ?? ''),
    relation:  String(row['relation'] ?? ''),
    weight:    Number(row['weight'] ?? 1),
    metadata:  parseJsonObject(String(row['metadata'] ?? '{}'), `MemoryEdge ${id} metadata`),
    createdAt: String(row['createdAt'] ?? ''),
  };
}

function exportedNodeFrom(value: unknown, where: string): ExportedNode {
  const record = asRecord(value, where);
  return {
    id:         requiredString(record['id'], `${where}.id`),
    kind:       requiredString(record['kind'], `${where}.kind`),
    label:      requiredString(record['label'], `${where}.label`),
    properties: asRecord(record['properties'], `${where}.properties`),
    runId:      requiredString(record['runId'], `${where}.runId`),
    createdAt:  requiredString(record['createdAt'], `${where}.createdAt`),
    updatedAt:  requiredString(record['updatedAt'], `${where}.updatedAt`),
  };
}

function exportedEdgeFrom(value: unknown, where: string): ExportedEdge {
  const record = asRecord(value, where);
  const weight = record['weight'];
  if (typeof weight !== 'number' || !Number.isFinite(weight)) {
    throw new GraphTransferError(`${where}.weight must be a finite number, got ${JSON.stringify(weight ?? null)}.`);
  }
  return {
    id:        requiredString(record['id'], `${where}.id`),
    fromId:    requiredString(record['fromId'], `${where}.fromId`),
    toId:      requiredString(record['toId'], `${where}.toId`),
    relation:  requiredString(record['relation'], `${where}.relation`),
    weight,
    metadata:  asRecord(record['metadata'], `${where}.metadata`),
    createdAt: requiredString(record['createdAt'], `${where}.createdAt`),
  };
}

/** The two structural rules an import depends on: unique ids, and no edge to a node not in the file. */
function validateGraph(nodes: ExportedNode[], edges: ExportedEdge[], source: string): void {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) throw new GraphTransferError(`${source}: node id ${JSON.stringify(node.id)} appears twice.`);
    ids.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) throw new GraphTransferError(`${source}: edge id ${JSON.stringify(edge.id)} appears twice.`);
    edgeIds.add(edge.id);
    if (!ids.has(edge.fromId)) throw new GraphTransferError(`${source}: edge ${JSON.stringify(edge.id)} starts at missing node ${JSON.stringify(edge.fromId)}.`);
    if (!ids.has(edge.toId)) throw new GraphTransferError(`${source}: edge ${JSON.stringify(edge.id)} ends at missing node ${JSON.stringify(edge.toId)}.`);
  }
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GraphTransferError(`${where} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new GraphTransferError(`${where} must be a JSON array.`);
  if (value.length > MAX_IMPORT_ROWS) {
    throw new GraphTransferError(`${where} holds ${value.length} entries; the import limit is ${MAX_IMPORT_ROWS}.`);
  }
  return value;
}

function requiredString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new GraphTransferError(`${where} must be a non-empty string.`);
  }
  return value;
}

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new GraphTransferError(
      `${what} is not valid JSON (${err instanceof Error ? err.message : String(err)}), so the export would lose it. Refusing to continue: ${text.slice(0, 120)}`,
    );
  }
  return asRecord(value, what);
}
