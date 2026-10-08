/**
 * DAG → JavaScript compiler.
 *
 * Accepted shape, per the v0.1 scope: one linear chain with at most one
 * single-level `branch`. The branch's two arms either rejoin at a shared
 * downstream node (including the output) or terminate at separate outputs.
 *
 * Everything outside that shape is rejected with a Chinese message, because
 * the canvas surfaces these strings to the user verbatim.
 *
 * Generated-script conventions (the workflow guest provides these globals):
 *   `agent(prompt, opts)` starts a subagent; `phase(title)` and `log(message)`
 *   narrate progress. `phase` takes exactly one argument in this Harness
 *   version, so a node's id doubles as its phase title.
 */

import type {
  ConditionType,
  NodeKind,
  WorkflowCondition,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
} from './contract.js'

/** A compile-time rejection the canvas shows to the user. */
export class CompileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompileError'
  }
}

/** Compiled output ready to hand to `ctx.workflowEngine.start()`. */
export interface CompileResult {
  /** The workflow script body: top-level `await`, ends with `return`. */
  script: string
  /** Node ids in execution order, for progress display. */
  order: string[]
  /** The output node whose value becomes the run's `value`. */
  outputId: string
}

/** Substitution pattern; node ids may contain hyphen, dot, and word characters. */
const INTERPOLATION = /\{\{\s*([\w.\-]+)\s*\}\}/g

const KIND_LABEL: Record<NodeKind, string> = {
  input: '输入',
  llm: '大模型',
  code: '代码',
  branch: '条件分支',
  output: '输出',
}

/** Human labels for the four supported condition operators. */
export const CONDITION_LABEL: Record<ConditionType, string> = {
  len_gt: '长度大于',
  len_lt: '长度小于',
  contains: '包含',
  eq: '等于',
}

/** Render a node for an error message. */
function describe(node: WorkflowNode): string {
  const label = node.label ? `「${node.label}」` : ''
  return `${KIND_LABEL[node.kind] ?? node.kind}节点 ${node.id}${label}`
}

interface Topology {
  byId: Map<string, WorkflowNode>
  outgoing: Map<string, WorkflowEdge[]>
  incoming: Map<string, WorkflowEdge[]>
}

function buildTopology(graph: WorkflowGraph): Topology {
  const byId = new Map<string, WorkflowNode>()
  for (const node of graph.nodes) {
    if (byId.has(node.id)) throw new CompileError(`节点 ID 重复：${node.id}`)
    byId.set(node.id, node)
  }
  const outgoing = new Map<string, WorkflowEdge[]>()
  const incoming = new Map<string, WorkflowEdge[]>()
  for (const id of byId.keys()) {
    outgoing.set(id, [])
    incoming.set(id, [])
  }
  for (const edge of graph.edges) {
    if (!byId.has(edge.source)) throw new CompileError(`连线指向不存在的源节点：${edge.source}`)
    if (!byId.has(edge.target)) throw new CompileError(`连线指向不存在的目标节点：${edge.target}`)
    outgoing.get(edge.source)!.push(edge)
    incoming.get(edge.target)!.push(edge)
  }
  return { byId, outgoing, incoming }
}

/** Ids reachable from `start`, excluding `start` itself. */
function reachableFrom(topology: Topology, start: string): Set<string> {
  const seen = new Set<string>()
  const stack = [start]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const edge of topology.outgoing.get(current) ?? []) {
      if (!seen.has(edge.target)) {
        seen.add(edge.target)
        stack.push(edge.target)
      }
    }
  }
  return seen
}

/** Reject any cycle, naming the nodes that take part in one. */
function checkAcyclic(topology: Topology): void {
  const WHITE = 0
  const GREY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  for (const id of topology.byId.keys()) color.set(id, WHITE)

  for (const root of topology.byId.keys()) {
    if (color.get(root) !== WHITE) continue
    const path: string[] = [root]
    const stack: Array<{ id: string; next: number }> = [{ id: root, next: 0 }]
    color.set(root, GREY)
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const edges = topology.outgoing.get(frame.id) ?? []
      if (frame.next >= edges.length) {
        color.set(frame.id, BLACK)
        stack.pop()
        path.pop()
        continue
      }
      const target = edges[frame.next]!.target
      frame.next += 1
      const state = color.get(target)
      if (state === GREY) {
        const cycle = path.slice(path.indexOf(target)).concat(target)
        throw new CompileError(`工作流存在环，无法编译：${cycle.join(' → ')}`)
      }
      if (state === WHITE) {
        color.set(target, GREY)
        path.push(target)
        stack.push({ id: target, next: 0 })
      }
    }
  }
}

function requireInputNode(topology: Topology): WorkflowNode {
  const inputs = [...topology.byId.values()].filter((node) => node.kind === 'input')
  if (inputs.length === 0) throw new CompileError('工作流缺少输入节点，请先添加一个「输入」节点')
  if (inputs.length > 1) {
    throw new CompileError(
      `工作流只能有一个输入节点，当前有 ${inputs.length} 个：${inputs.map((n) => n.id).join('、')}`,
    )
  }
  return inputs[0]!
}

function requireOutputNodes(topology: Topology): WorkflowNode[] {
  const outputs = [...topology.byId.values()].filter((node) => node.kind === 'output')
  if (outputs.length === 0) throw new CompileError('工作流缺少输出节点，请先添加一个「输出」节点')
  return outputs
}

/** Reject parallel execution: any non-branch node with more than one outgoing edge. */
function checkNoFanOut(topology: Topology): void {
  for (const [id, edges] of topology.outgoing) {
    const node = topology.byId.get(id)!
    if (node.kind === 'branch') continue
    if (edges.length > 1) {
      throw new CompileError(
        `${describe(node)} 存在扇出（${edges.length} 条出边），v0.1 不支持并行执行`,
      )
    }
  }
}

/** Reject nested branches: no branch may be reachable from another branch. */
function checkNoNestedBranch(topology: Topology): void {
  for (const node of topology.byId.values()) {
    if (node.kind !== 'branch') continue
    for (const id of reachableFrom(topology, node.id)) {
      const other = topology.byId.get(id)!
      if (other.kind === 'branch') {
        throw new CompileError(
          `暂不支持分支嵌套：${describe(other)} 位于 ${describe(node)} 的下游`,
        )
      }
    }
  }
}

/** A branch takes one upstream value, so arm tracking stays unambiguous. */
function checkBranchIncoming(topology: Topology): void {
  for (const node of topology.byId.values()) {
    if (node.kind !== 'branch') continue
    const incoming = topology.incoming.get(node.id) ?? []
    if (incoming.length !== 1) {
      throw new CompileError(
        incoming.length === 0
          ? `${describe(node)} 没有上游节点，条件分支必须连接一个输入来源`
          : `${describe(node)} 有 ${incoming.length} 条入边，条件分支只能有一个上游节点`,
      )
    }
  }
}

interface BranchArms {
  true: WorkflowEdge
  false: WorkflowEdge
}

/** Every branch needs exactly one `true` and one `false` outgoing edge. */
function requireBranchArms(topology: Topology, node: WorkflowNode): BranchArms {
  const edges = topology.outgoing.get(node.id) ?? []
  const trueArms = edges.filter((edge) => edge.sourceHandle === 'true')
  const falseArms = edges.filter((edge) => edge.sourceHandle === 'false')
  const unlabelled = edges.filter(
    (edge) => edge.sourceHandle !== 'true' && edge.sourceHandle !== 'false',
  )
  if (unlabelled.length > 0) {
    throw new CompileError(
      `${describe(node)} 的出边必须使用 true / false 分支端口，发现 ${unlabelled.length} 条未标注端口的出边`,
    )
  }
  const missing = [
    trueArms.length === 0 ? 'true' : null,
    falseArms.length === 0 ? 'false' : null,
  ].filter((value): value is string => value !== null)
  if (missing.length > 0) {
    throw new CompileError(
      `${describe(node)} 缺少 ${missing.join(' 和 ')} 出边，条件分支必须同时连接 true 与 false 两条分支`,
    )
  }
  if (trueArms.length > 1 || falseArms.length > 1) {
    throw new CompileError(`${describe(node)} 的 true / false 分支各只能有一条出边`)
  }
  return { true: trueArms[0]!, false: falseArms[0]! }
}

/** Every node must be reachable from the input. */
function checkReachability(topology: Topology, input: WorkflowNode): void {
  const reachable = reachableFrom(topology, input.id)
  reachable.add(input.id)
  for (const node of topology.byId.values()) {
    if (!reachable.has(node.id)) {
      throw new CompileError(`${describe(node)} 与输入节点不连通，无法参与执行`)
    }
  }
}

/** Words a generated identifier must never become. */
const RESERVED = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'implements', 'import', 'in',
  'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private',
  'protected', 'public', 'return', 'static', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'arguments', 'eval', 'undefined', 'NaN', 'Infinity', 'input', 'agent',
  'phase', 'log', 'parallel', 'pipeline', 'args',
])

/** Turn an arbitrary node id into a safe, unique JavaScript identifier. */
function identifierFor(node: WorkflowNode, taken: Set<string>): string {
  let base = node.id.replace(/[^\w$]/g, '_').replace(/^(\d)/, '_$1')
  if (base.length === 0 || RESERVED.has(base)) base = `${base}_n`
  let candidate = base
  let suffix = 2
  while (taken.has(candidate)) {
    candidate = `${base}_${suffix}`
    suffix += 1
  }
  taken.add(candidate)
  return candidate
}

/** A node's generated variable plus how far its emission has progressed. */
interface Slot {
  stage: 'pending' | 'done'
  name: string
}

/**
 * Render an upstream value as text.
 *
 * An agent node hands on the `{ output, summary }` contract, so anything that
 * names one — a prompt or a branch condition — should receive its `output`, not
 * `[object Object]`. Code nodes are unaffected: they receive the raw value as
 * `input` and can read `.output` themselves.
 *
 * Module-level because both users of it live in different scopes: the prompt
 * interpolator below and `conditionExpression` at the bottom of this file.
 */
function textOf(name: string): string {
  return `(${name} == null ? '' : typeof ${name} === 'object' && 'output' in ${name}` +
    ` ? String(${name}.output) : String(${name}))`
}

/**
 * Validate a graph and compile it to a workflow script.
 * @param graph - the canvas document.
 * @returns the script body plus execution metadata.
 * @throws {CompileError} with a Chinese message when the DAG is outside v0.1 scope.
 */
export function compile(graph: WorkflowGraph): CompileResult {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new CompileError('工作流结构无效：缺少 nodes 或 edges')
  }
  if (graph.nodes.length === 0) throw new CompileError('工作流为空，请先添加节点')

  const topology = buildTopology(graph)
  checkAcyclic(topology)
  const input = requireInputNode(topology)
  const outputs = requireOutputNodes(topology)
  checkNoFanOut(topology)
  checkBranchIncoming(topology)
  checkNoNestedBranch(topology)
  const branches = [...topology.byId.values()].filter((node) => node.kind === 'branch')
  const armsById = new Map<string, BranchArms>()
  for (const node of branches) armsById.set(node.id, requireBranchArms(topology, node))
  checkReachability(topology, input)

  const taken = new Set<string>()
  const slots = new Map<string, Slot>()
  for (const node of graph.nodes) {
    slots.set(node.id, { stage: 'pending', name: identifierFor(node, taken) })
  }
  const actualOutput = identifierFor({ id: '__workflowResult', kind: 'output' }, taken)

  const nameOf = (id: string): string => {
    const slot = slots.get(id)
    if (slot === undefined) throw new CompileError(`插值引用了不存在的节点：{{${id}}}`)
    return slot.name
  }

  /** Replace `{{id}}` with the matching variable reference. */
  const interpolate = (template: string): string =>
    template.replace(INTERPOLATION, (_match, id: string) => nameOf(id))

  /**
   * Compile a template into a JavaScript *expression*.
   *
   * `JSON.stringify` of the whole interpolated template would freeze each
   * `{{id}}` into the variable's name (`"say input_n"`) instead of its value,
   * because the result is embedded in a string literal. Splitting into literals
   * joined with variable references is what makes the substitution real.
   */
  const templateExpression = (template: string): string => {
    const parts: string[] = []
    let cursor = 0
    for (const match of template.matchAll(INTERPOLATION)) {
      const at = match.index ?? 0
      if (at > cursor) parts.push(JSON.stringify(template.slice(cursor, at)))
      parts.push(textOf(nameOf(match[1]!)))
      cursor = at + match[0].length
    }
    // No reference at all: keep the plain literal, which is cheaper to read.
    if (parts.length === 0) return JSON.stringify(template)
    if (cursor < template.length) parts.push(JSON.stringify(template.slice(cursor)))
    return parts.join(' + ')
  }

  const lines: string[] = []
  const emit = (depth: number, text: string): void => {
    lines.push(`${'  '.repeat(depth)}${text}`)
  }

  const order: string[] = []

  /** The expression supplying a node's value from its incoming edges. */
  const incomingValue = (node: WorkflowNode): string => {
    const edges = topology.incoming.get(node.id) ?? []
    if (edges.length === 0) return 'null'
    const sources = [...new Set(edges.map((edge) => nameOf(edge.source)))]
    // A merge point receives the same value from both arms, so any source names it.
    return sources[0]!
  }

  /**
   * Emit the statements that produce one node's value.
   * @param inputSource - overrides the upstream value expression, which a branch
   *   rejoin needs because its arms computed different values.
   */
  const emitNode = (node: WorkflowNode, depth: number, inputSource?: string): void => {
    const slot = slots.get(node.id)!
    if (slot.stage === 'done') return
    switch (node.kind) {
      case 'input': {
        emit(depth, `${slot.name} = ${JSON.stringify(node.params?.input ?? '')};`)
        break
      }
      case 'llm': {
        // An expression, not a string literal: the prompt must carry the
        // upstream values that `{{id}}` names.
        const promptExpr = templateExpression(node.params?.prompt ?? '')
        emit(depth, `phase(${JSON.stringify(node.id)});`)
        emit(depth, `log(${JSON.stringify(`调用大模型：${node.id}`)});`)
        emit(
          depth,
          `${slot.name} = await agent(${promptExpr}, { phase: ${JSON.stringify(node.id)} });`,
        )
        break
      }
      case 'code': {
        const body = interpolate(node.params?.code ?? 'return input')
        // `input` is the upstream node's value, so a code node can transform
        // whatever feeds it without naming the upstream id.
        const sources = (topology.incoming.get(node.id) ?? []).map((edge) => nameOf(edge.source))
        const source = inputSource ?? (sources.length === 0 ? 'null' : sources[0]!)
        emit(depth, `phase(${JSON.stringify(node.id)});`)
        emit(
          depth,
          `${slot.name} = await (async (input) => { ${body} })(typeof ${source} === 'undefined' ? null : ${source});`,
        )
        break
      }
      case 'branch': {
        // A branch passes its upstream value through unchanged.
        emit(depth, `${slot.name} = ${inputSource ?? incomingValue(node)};`)
        break
      }
      case 'output': {
        emit(depth, `phase(${JSON.stringify(node.id)});`)
        emit(depth, `${slot.name} = ${inputSource ?? incomingValue(node)};`)
        emit(depth, `${actualOutput} = { value: ${slot.name}, output: ${JSON.stringify(node.id)} };`)
        break
      }
      default: {
        throw new CompileError(`未知的节点类型：${String((node as WorkflowNode).kind)}`)
      }
    }
    slot.stage = 'done'
    order.push(node.id)
  }

  /** Emit the shared tail from a node onward, then finish. */
  const emitTail = (start: WorkflowNode | undefined, depth: number): void => {
    let current = start
    while (current) {
      emitNode(current, depth)
      const edges = topology.outgoing.get(current.id) ?? []
      current = edges.length === 0 ? undefined : topology.byId.get(edges[0]!.target)
    }
  }

  emit(0, 'phase("compile");')
  emit(0, 'log("工作流开始执行");')
  emit(1, `let ${actualOutput};`)

  // Every node gets one top-level `let`, and the body only assigns to them.
  // Arm-local nodes are written inside the `if`/`else` blocks, so a `const`
  // there would be invisible to the shared tail — and to `{{id}}` interpolation
  // in a downstream node, which may legitimately name a node from either arm.
  for (const node of graph.nodes) {
    emit(1, `let ${slots.get(node.id)!.name};`)
  }

  emitNode(input, 1)

  const firstEdge = (topology.outgoing.get(input.id) ?? [])[0]
  const cursor: WorkflowNode | undefined = firstEdge
    ? topology.byId.get(firstEdge.target)
    : undefined

  if (branches.length === 0) {
    emitTail(cursor, 1)
  } else {
    const branch = branches[0]!

    // Linear prefix: emit everything strictly before the branch.
    let before: WorkflowNode | undefined = cursor
    let reachedBranch = false
    while (before) {
      if (before.id === branch.id) {
        reachedBranch = true
        break
      }
      emitNode(before, 1)
      const edges = topology.outgoing.get(before.id) ?? []
      before = edges.length === 0 ? undefined : topology.byId.get(edges[0]!.target)
    }
    if (!reachedBranch) throw new CompileError('工作流结构无效：条件分支不可达')
    emitNode(branch, 1)

    const arms = armsById.get(branch.id)!
    const condition = conditionExpression(branch, nameOf)
    const trueTarget = topology.byId.get(arms.true.target)!
    const falseTarget = topology.byId.get(arms.false.target)!

    const trueReach = reachableFrom(topology, trueTarget.id)
    const falseReach = reachableFrom(topology, falseTarget.id)

    /**
     * A node the arms rejoin at: quite simply a node both arms reach. Each arm
     * walks to `stopAt`, and that node is then emitted once after the branch so
     * it sees whichever assignment ran.
     */
    const stopAt = (node: WorkflowNode): boolean =>
      (trueReach.has(node.id) || node.id === trueTarget.id) &&
      (falseReach.has(node.id) || node.id === falseTarget.id)

    /**
     * Both arms publish into this one top-level binding. At a merge the two arms
     * carry different values (each applied its own transform), so the join must
     * read whichever arm actually ran — the branch's own value would be wrong.
     */
    const armValue = `armValue_${slots.get(branch.id)!.name}`
    emit(1, `let ${armValue};`)

    const emitArm = (
      start: WorkflowNode,
      depth: number,
    ): { stop?: WorkflowNode; value: string } => {
      let current: WorkflowNode = start
      let last: WorkflowNode | undefined
      for (;;) {
        if (stopAt(current)) {
          // Publish the arm's last computed node; the branch value when the arm
          // is empty, since a branch passes its input through unchanged.
          const value = last ? slots.get(last.id)!.name : slots.get(branch.id)!.name
          emit(depth, `${armValue} = ${value};`)
          return { stop: current, value: armValue }
        }
        emitNode(current, depth)
        last = current
        const edges = topology.outgoing.get(current.id) ?? []
        if (edges.length === 0) return { value: slots.get(last.id)!.name }
        current = topology.byId.get(edges[0]!.target)!
      }
    }

    emit(1, `if (${condition}) {`)
    const trueArm = emitArm(trueTarget, 2)
    emit(1, `} else {`)
    const falseArm = emitArm(falseTarget, 2)
    emit(1, `}`)

    if (trueArm.stop && falseArm.stop && trueArm.stop.id !== falseArm.stop.id) {
      throw new CompileError(
        `分支两条臂分别汇合到不同节点（${trueArm.stop.id} 与 ${falseArm.stop.id}），v0.1 只支持汇合到同一个节点`,
      )
    }

    // Emit the join and everything after it exactly once.
    const join = trueArm.stop ?? falseArm.stop
    if (join) {
      const bothStopped = trueArm.stop !== undefined && falseArm.stop !== undefined
      // Both arms published into `armValue`; a single stopping arm published
      // nothing there, so its last node holds the value instead.
      const value = bothStopped ? armValue : trueArm.stop ? falseArm.value : trueArm.value
      emitNode(join, 1, value)
      const edges = topology.outgoing.get(join.id) ?? []
      emitTail(edges.length === 0 ? undefined : topology.byId.get(edges[0]!.target), 1)
    }
  }

  const outputId = selectOutput(outputs, topology, input, armsById)
  emit(0, 'log("工作流执行结束");')
  emit(0, `return ${actualOutput};`)

  return { script: lines.join('\n'), order, outputId }
}

/**
 * Nodes on the canonical chain: follow the deterministic `true`-arm-first path
 * from the input, which is the order the generated script executes in.
 */
function canonicalChain(
  topology: Topology,
  input: WorkflowNode,
  armsById: Map<string, BranchArms>,
): string[] {
  const chain: string[] = []
  let current: WorkflowNode | undefined = input
  const guard = new Set<string>()
  while (current && !guard.has(current.id)) {
    guard.add(current.id)
    chain.push(current.id)
    const arms = armsById.get(current.id)
    if (arms) {
      const target = topology.byId.get(arms.true.target)
      if (target) chain.push(target.id)
      current = target
      continue
    }
    const edges = topology.outgoing.get(current.id) ?? []
    current = edges.length === 0 ? undefined : topology.byId.get(edges[0]!.target)
  }
  return chain
}

/**
 * Choose the output node whose value becomes the run's `value`.
 *
 * One shared output fed by both arms is unambiguous. With separate arm
 * outputs, no single output covers every terminal, and the run returns the
 * first output on the canonical chain.
 */
function selectOutput(
  outputs: WorkflowNode[],
  topology: Topology,
  input: WorkflowNode,
  armsById: Map<string, BranchArms>,
): string {
  if (outputs.length === 1) return outputs[0]!.id

  const terminals = outputs.filter(
    (node) => (topology.outgoing.get(node.id) ?? []).length === 0,
  )
  const reachedFromAll =
    terminals.length > 1
      ? outputs.filter((output) =>
          terminals.every((terminal) => reachableFrom(topology, terminal.id).has(output.id)),
        )
      : []
  if (reachedFromAll.length === 1) return reachedFromAll[0]!.id
  if (reachedFromAll.length > 1) {
    throw new CompileError(
      `有多个输出节点同时接收分支两条臂的结果：${reachedFromAll.map((n) => n.id).join('、')}`,
    )
  }

  const chain = canonicalChain(topology, input, armsById)
  const onChain = chain.filter((id) => topology.byId.get(id)!.kind === 'output')
  if (onChain.length > 0) return onChain[0]!

  throw new CompileError(
    `无法确定输出节点：共 ${outputs.length} 个输出（${outputs.map((n) => n.id).join('、')}），且没有一条分支臂汇合到它们`,
  )
}

/** Build the boolean expression a branch evaluates. */
function conditionExpression(node: WorkflowNode, nameOf: (id: string) => string): string {
  const condition: WorkflowCondition | undefined = node.params?.condition
  if (!condition) throw new CompileError(`${describe(node)} 缺少条件配置`)
  const type = condition.type
  if (!(type in CONDITION_LABEL)) {
    throw new CompileError(`${describe(node)} 的条件类型无效：${String(type)}`)
  }
  /**
   * The text the condition sees: the same unwrapping a prompt gets.
   *
   * A branch fed by an agent node holds the `{ output, summary }` object, and
   * `String()` of that is `"[object Object]"` — 15 characters, so `字数>500` was
   * false however long the model's reply was. `contains` and `eq` compared against
   * the same useless string. This is the branch-side half of the v0.4.1 fix.
   */
  const source = textOf(nameOf(node.id))
  const raw = condition.value ?? ''
  switch (type) {
    case 'len_gt':
    case 'len_lt': {
      const threshold = Number(raw)
      if (!Number.isFinite(threshold)) {
        throw new CompileError(`${describe(node)} 的「${CONDITION_LABEL[type]}」阈值不是数字：${raw}`)
      }
      const operator = type === 'len_gt' ? '>' : '<'
      return `${source}.length ${operator} ${threshold}`
    }
    case 'contains':
      return `${source}.includes(${JSON.stringify(raw)})`
    case 'eq':
      return `${source} === ${JSON.stringify(raw)}`
    default:
      throw new CompileError(`${describe(node)} 的条件类型无效：${String(type)}`)
  }
}
