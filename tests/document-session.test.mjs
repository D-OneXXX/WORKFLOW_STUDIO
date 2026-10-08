import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
const api = existsSync(new URL('../lib/shared/document-session.js', import.meta.url))
  ? await import('../lib/shared/document-session.js') : {}

test('save reply for an older document cannot attach its id to the new document', () => {
  assert.equal(typeof api.DocumentSession, 'function', 'document session guard is required')
  const session = new api.DocumentSession()
  const savingA = session.stamp()
  session.replace()
  assert.equal(session.sameDocument(savingA), false)
})
test('editing during save preserves dirty state while retaining the same document', () => {
  assert.equal(typeof api.DocumentSession, 'function', 'document session guard is required')
  const session = new api.DocumentSession()
  const saving = session.stamp()
  session.edit()
  assert.equal(session.sameDocument(saving), true)
  assert.equal(session.unchanged(saving), false)
})
test('new nodes avoid ids in a reopened or imported document', () => {
  assert.equal(typeof api.mintNodeId, 'function', 'collision-safe node IDs are required')
  assert.equal(api.mintNodeId('code', ['code_1', 'code_2', 'code_4']), 'code_3')
})

test('applying a loaded document invalidates saves begun while the old graph was visible', () => {
  const session = new api.DocumentSession()
  session.replace() // Begin opening another document.
  const savedWhileLoading = session.stamp()
  session.replace() // Apply the newly loaded graph.
  assert.equal(session.sameDocument(savedWhileLoading), false)
})
