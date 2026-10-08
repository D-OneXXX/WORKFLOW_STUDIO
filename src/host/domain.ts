/**
 * The plugin's own storage domain and the workflow record store.
 *
 * The domain name must match /^[a-z][a-z0-9_]*$/, so it is `dsh_workflow`;
 * a hyphen would throw when the spec is defined. The plugin reads and writes
 * nothing outside this domain.
 *
 * Types are structural rather than imported: the runtime resolves
 * `@deepseek-ai/dsh-storage-domain` from the Harness installation, and the
 * declared shapes below are exactly what 0.2.0-rc.2 validates.
 */

import { recordSchema, type WorkflowRecord } from './schemas.js'

/** The domain name; valid against the storage layer's unit-name rule. */
export const WORKFLOW_DOMAIN = 'dsh_workflow'

/** The single table holding workflow records. */
export const WORKFLOW_TABLE = 'workflows'

/** A parsed, validated value: the storage layer uses zod. */
interface SchemaLike<T> {
  parse(value: unknown): T
}

/** One table declaration, as `domainTable` produces. */
interface TableSpecLike<V> {
  valueSchema: SchemaLike<V>
}

/** The subset of `Domain` this plugin uses. */
export interface DomainLike {
  table(name: string): {
    get(key: string): WorkflowRecord | undefined
    keys(): IterableIterator<string>
    put(key: string, value: WorkflowRecord): Promise<void>
    delete(key: string): Promise<boolean>
  }
  close(): Promise<void>
}

/** The shape `defineDomain` validates at module load. */
export interface DomainSpecLike {
  name: string
  version: number
  layout: 'single' | 'per-record'
  compatibleVersions?: readonly number[]
  tables: Record<string, TableSpecLike<unknown>>
}

/** Wrap a zod schema the way `domainTable` does. */
export function domainTable<V>(valueSchema: SchemaLike<V>): TableSpecLike<V> {
  return { valueSchema }
}

/**
 * The plugin's domain declaration.
 *
 * `defineDomain` from `@deepseek-ai/dsh-storage-domain` ultimately validates
 * exactly this shape, so the Host imports that function and passes this spec
 * through; keeping the literal here makes the name and version auditable.
 */
export function workflowDomainSpec(defineDomain: (spec: DomainSpecLike) => unknown): unknown {
  return defineDomain({
    name: WORKFLOW_DOMAIN,
    version: 1,
    layout: 'single',
    tables: {
      [WORKFLOW_TABLE]: domainTable(recordSchema),
    },
  })
}

/** Read-only view over the domain that the service consumes. */
export class WorkflowStore {
  constructor(private readonly domain: DomainLike) {}

  /** Every stored workflow, newest first. */
  list(): WorkflowRecord[] {
    const table = this.domain.table(WORKFLOW_TABLE)
    const rows: WorkflowRecord[] = []
    for (const key of table.keys()) {
      const value = table.get(key)
      if (value !== undefined) rows.push(value)
    }
    return rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  /** One record, or undefined when the id is unknown. */
  get(id: string): WorkflowRecord | undefined {
    return this.domain.table(WORKFLOW_TABLE).get(id)
  }

  /** Insert or replace a record. */
  async put(record: WorkflowRecord): Promise<void> {
    await this.domain.table(WORKFLOW_TABLE).put(record.id, record)
  }

  /** Remove a record; true when something was removed. */
  async remove(id: string): Promise<boolean> {
    return await this.domain.table(WORKFLOW_TABLE).delete(id)
  }
}

/** A stable, filesystem-safe id for a new workflow. */
export function newWorkflowId(): string {
  return `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Validate a record read back from storage. */
export function parseRecord(value: unknown): WorkflowRecord {
  return recordSchema.parse(value)
}
