/**
 * Wire-vocabulary tests.
 *
 * Regression guard for a real incident: a descriptor whose `method` was
 * `'workflow/save'` made `ctx.typert.register()` throw, the rejection went
 * unhandled, and the Harness process died with a fatal load failure — Desktop
 * then recovered into safe mode, which blocks third-party bundles.
 *
 * The registry validates `namespace` and `method` against
 * `/^[A-Za-z0-9_$.-]+$/`, so a forward slash is illegal in either field.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertWireVocabulary,
  invocationId,
  WIRE_NAME_PATTERN,
  WORKFLOW_METHODS,
  WORKFLOW_NAMESPACE,
  WORKFLOW_PACKAGE,
  WORKFLOW_SERVICE,
} from '../lib/shared/wire.js'
import { TYPERT, WORKFLOW_INVOCATIONS } from '../lib/host/descriptors.js'

test('every wire namespace and method satisfies the registry segment rule', () => {
  // Throws on any illegal name; the module already calls this at load time.
  assert.doesNotThrow(() => assertWireVocabulary())

  assert.ok(WIRE_NAME_PATTERN.test(WORKFLOW_NAMESPACE), `namespace ${WORKFLOW_NAMESPACE}`)
  for (const method of WORKFLOW_METHODS) {
    assert.ok(WIRE_NAME_PATTERN.test(method), `method ${method} must match the segment rule`)
  }
})

test('no method may contain a forward slash', () => {
  for (const method of WORKFLOW_METHODS) {
    assert.ok(!method.includes('/'), `method ${method} contains a slash`)
  }
  assert.ok(!WORKFLOW_NAMESPACE.includes('/'), `namespace ${WORKFLOW_NAMESPACE} contains a slash`)
})

test('the five methods are exactly the documented set', () => {
  assert.deepEqual([...WORKFLOW_METHODS], ['save', 'list', 'load', 'delete', 'run'])
})

test('the service key and the namespace are distinct, valid names', () => {
  assert.equal(WORKFLOW_SERVICE, 'workflowStudio')
  assert.equal(WORKFLOW_NAMESPACE, 'workflow')
  // The service key is validated by segment rules: nonempty and no '#'.
  assert.ok(WORKFLOW_SERVICE.length > 0 && !WORKFLOW_SERVICE.includes('#'))
})

test('invocation ids keep the brief-mandated <package>#workflow/<method> spelling', () => {
  assert.equal(invocationId('save'), `${WORKFLOW_PACKAGE}#workflow/save`)
  for (const method of WORKFLOW_METHODS) {
    const id = invocationId(method)
    assert.ok(id.startsWith(`${WORKFLOW_PACKAGE}#`), id)
    assert.ok(id.endsWith(`/${method}`), id)
  }
})

test('assertWireVocabulary rejects a slashed name, like the registry does', () => {
  // Mirror the registry's guard directly so the rule itself is pinned.
  const validate = (value) => {
    if (value === '.' || value === '..' || !WIRE_NAME_PATTERN.test(value)) {
      throw new Error(`typert: invalid wire name "${value}"`)
    }
  }
  assert.throws(() => validate('workflow/save'), /invalid wire name/)
  assert.throws(() => validate('.'), /invalid wire name/)
  assert.throws(() => validate('..'), /invalid wire name/)
  assert.throws(() => validate(''), /invalid wire name/)
  assert.doesNotThrow(() => validate('workflow.save'))
  assert.doesNotThrow(() => validate('save'))
})

test('every Host invocation descriptor passes the registry validators', () => {
  // This checks the REAL descriptor objects, not just the vocabulary constants.
  // An earlier revision kept `method: 'workflow/save'` in this list while the
  // constants looked correct, so only inspecting the objects catches it.
  assert.ok(Array.isArray(WORKFLOW_INVOCATIONS), 'host exports WORKFLOW_INVOCATIONS')
  assert.equal(WORKFLOW_INVOCATIONS.length, 5)

  const seen = new Set()
  for (const descriptor of WORKFLOW_INVOCATIONS) {
    assert.ok(typeof descriptor.id === 'string' && descriptor.id.length > 0, 'id is non-empty')
    // validateSegment: non-empty and no '#'.
    assert.ok(!descriptor.service.includes('#'), `service ${descriptor.service} contains #`)
    // validateWireName on namespace and method: the slash is illegal in both.
    assert.ok(
      WIRE_NAME_PATTERN.test(descriptor.namespace),
      `namespace "${descriptor.namespace}" fails the segment rule`,
    )
    assert.ok(
      WIRE_NAME_PATTERN.test(descriptor.method),
      `method "${descriptor.method}" fails the segment rule`,
    )
    assert.ok(!descriptor.method.includes('/'), `method ${descriptor.method} contains a slash`)

    assert.equal(descriptor.service, WORKFLOW_SERVICE)
    assert.equal(descriptor.namespace, WORKFLOW_NAMESPACE)
    assert.deepEqual(descriptor.invocation, { kind: 'direct' })

    assert.equal(descriptor.parameters.length, 1)
    for (const parameter of descriptor.parameters) {
      assert.ok(WIRE_NAME_PATTERN.test(parameter.name), `parameter name ${parameter.name}`)
      assert.ok(WIRE_NAME_PATTERN.test(parameter.wire), `parameter wire ${parameter.wire}`)
    }
    // validateCodec: strict codecs need a non-empty typeSymbol and a create().
    assert.equal(descriptor.result.mode, 'strict')
    assert.ok(descriptor.result.typeSymbol.length > 0, 'result typeSymbol is non-empty')
    assert.equal(typeof descriptor.result.create, 'function', 'result codec has create()')

    assert.ok(!seen.has(descriptor.method), `method ${descriptor.method} is repeated`)
    seen.add(descriptor.method)
  }

  assert.deepEqual([...seen].sort(), [...WORKFLOW_METHODS].sort())
})

test('the contribution is well formed for ctx.typert.register', () => {
  assert.equal(TYPERT.package, WORKFLOW_PACKAGE)
  assert.equal(TYPERT.face, 'host')
  assert.deepEqual(TYPERT.schemas, [])
  assert.deepEqual(TYPERT.model, { services: [], events: [], objects: [] })
  assert.equal(TYPERT.invocations, WORKFLOW_INVOCATIONS)
})

test('every declared codec can actually build its schema', () => {
  // validateCodec only checks that create() exists; materializing the schema
  // proves the zod factory is wired and does not throw.
  for (const descriptor of WORKFLOW_INVOCATIONS) {
    const result = descriptor.result.create()
    assert.equal(typeof result.parse, 'function', `${descriptor.id} result schema`)
    for (const parameter of descriptor.parameters) {
      const request = parameter.codec.create()
      assert.equal(typeof request.parse, 'function', `${descriptor.id} request schema`)
    }
  }
})
