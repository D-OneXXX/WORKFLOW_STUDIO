import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { compile } from '../lib/shared/compiler.js'
import { saveRequestSchema, recordSchema } from '../lib/host/schemas.js'

const interchangeSchema = z.object({
  format: z.literal('dsh-workflow-studio'), version: z.literal(1),
  workflow: saveRequestSchema.omit({ id: true }),
})

export function parseInterchange(value) {
  const document = interchangeSchema.parse(value)
  compile(document.workflow.graph)
  return document.workflow
}

export class WorkflowStore {
  #records
  #path
  #queue = Promise.resolve()
  constructor(path, records) { this.#path = path; this.#records = records }
  static async open(directory) {
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'workflows.json')
    let records = []
    try { records = z.array(recordSchema).parse(JSON.parse(await readFile(path, 'utf8'))) }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`工作流数据无法读取，原文件已保留：${error.message}`) }
    return new WorkflowStore(path, records)
  }
  #mutate(change) {
    const next = this.#queue.then(async () => {
      const records = structuredClone(this.#records)
      const result = change(records)
      const temporary = `${this.#path}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(records, null, 2), 'utf8')
      await rename(temporary, this.#path)
      this.#records = records
      return result
    })
    this.#queue = next.catch(() => undefined)
    return next
  }
  list() {
    return this.#records.map(({ id, name, description, graph, updatedAt }) =>
      ({ id, name, description, nodeCount: graph.nodes.length, updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  load(id) { return structuredClone(this.#records.find(r => r.id === id) ?? null) }
  save(value) {
    const request = saveRequestSchema.parse(value)
    compile(request.graph)
    return this.#mutate(records => {
      const index = request.id ? records.findIndex(r => r.id === request.id) : -1
      const now = new Date().toISOString()
      const record = recordSchema.parse({ ...request, id: index >= 0 ? records[index].id : randomUUID(),
        createdAt: index >= 0 ? records[index].createdAt : now, updatedAt: now })
      if (index >= 0) records[index] = record
      else records.push(record)
      return { id: record.id, updatedAt: now }
    })
  }
  remove(id) {
    return this.#mutate(records => {
      const index = records.findIndex(r => r.id === id)
      if (index >= 0) records.splice(index, 1)
      return { deleted: index >= 0 }
    })
  }
  export(id) {
    const record = this.load(id)
    if (!record) throw new Error('找不到工作流')
    return { format: 'dsh-workflow-studio', version: 1,
      workflow: { name: record.name, description: record.description, graph: record.graph } }
  }
  import(document) { return this.save(parseInterchange(document)) }
}
