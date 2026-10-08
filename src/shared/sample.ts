/**
 * Built-in example workflows: the demo used by the acceptance case, and the
 * explicit round chain that shows how a repetition is drawn instead of configured.
 */

import type { WorkflowGraph } from './contract.js'

/** Canvas geometry helper. */
const at = (x: number, y: number) => ({ x, y })

/** The demo DAG. Both branch arms rejoin the shared `out` output node. */
export function sampleGraph(): WorkflowGraph {
  return {
    nodes: [
      {
        id: 'topic',
        kind: 'input',
        label: '主题',
        params: { input: '量子计算的未来' },
        position: at(0, 160),
      },
      {
        id: 'outline',
        kind: 'llm',
        label: '写大纲',
        params: { prompt: '请为「{{topic}}」写一份 5 段式大纲，每段两句话。' },
        position: at(260, 160),
      },
      {
        id: 'check',
        kind: 'branch',
        label: '字数>500?',
        params: { condition: { type: 'len_gt', value: '500' } },
        position: at(540, 160),
      },
      {
        id: 'out',
        kind: 'output',
        label: '输出',
        params: { outputValue: 'outline' },
        position: at(820, 160),
      },
    ],
    edges: [
      { id: 'e-topic-outline', source: 'topic', target: 'outline' },
      { id: 'e-outline-check', source: 'outline', target: 'check' },
      { id: 'e-check-true', source: 'check', target: 'out', sourceHandle: 'true' },
      { id: 'e-check-false', source: 'check', target: 'out', sourceHandle: 'false' },
    ],
  }
}

/** Metadata for the demo record. */
export const SAMPLE_NAME = '示例：大纲生成'
export const SAMPLE_DESCRIPTION =
  '输入主题 → 大模型写大纲 → 字数>500? 分支 → 汇合到同一输出节点'

/**
 * The official repetition template: three visible rounds, no loop semantics.
 *
 * `input → 初稿 → 批评改写 → 分支(质量过关吗?) → true 输出 / false 润色 → 输出`
 *
 * Repeating work is drawn, not configured: how many rounds there are, what each
 * one does and where it stops are all nodes on the canvas, so the compiler, the
 * runner and the graph rules stay exactly as they are — this shape was compiled
 * before it was shipped, and it is the same `in -> r1 -> r2 -> q -> r3 -> out`.
 *
 * Every node carries its plain-language `description` **and** the formal field
 * that description translates to, with `descriptionApplied` set equal. That is
 * deliberate: a template that shipped only descriptions would not run until every
 * node had been translated, which needs a configured connector, and "打开即用"
 * would be false. Editing a description marks the round stale, as in any node.
 *
 * No `executor` is bound, so each round runs on the deployment's default
 * connector and the template works on a machine with one connector or with ten.
 * Heterogeneous rounds — a cheap model for the draft, a better one for the
 * polish — are one dropdown away per node rather than a hard-coded id that would
 * fail on a machine that has never installed it.
 */
export function roundChainGraph(): WorkflowGraph {
  const draft = '先把主题写成一份粗略初稿'
  const critique = '批评这份初稿，指出缺点后重写成更清楚的版本'
  const judge = '如果改写后的字数超过500，说明已经够长，可以直接输出'
  const polish = '在不增加内容的前提下润色措辞，让段落更顺'
  return {
    nodes: [
      {
        id: 'topic', kind: 'input', label: '主题',
        params: { input: '远程协作团队的会议纪要规范' },
        position: at(0, 160),
      },
      {
        id: 'round1', kind: 'llm', label: '第1轮·初稿',
        params: {
          prompt: '请围绕「{{topic}}」写一份粗略初稿，先不求完整。',
          description: draft,
          descriptionApplied: draft,
        },
        position: at(260, 160),
      },
      {
        id: 'round2', kind: 'llm', label: '第2轮·批评改写',
        params: {
          prompt: '批评下面这份初稿的结构与表达，指出三个缺点后重写成更清楚的版本：\n{{round1}}',
          description: critique,
          descriptionApplied: critique,
        },
        position: at(540, 160),
      },
      {
        id: 'judge', kind: 'branch', label: '质量过关吗',
        params: {
          condition: { type: 'len_gt', value: '500' },
          description: judge,
          descriptionApplied: judge,
        },
        position: at(820, 160),
      },
      {
        id: 'round3', kind: 'llm', label: '第3轮·润色',
        params: {
          prompt: '在保持原意、不新增内容的前提下润色下面这段文字的措辞：\n{{round2}}',
          description: polish,
          descriptionApplied: polish,
        },
        position: at(1100, 300),
      },
      {
        id: 'out', kind: 'output', label: '输出',
        position: at(1380, 160),
      },
    ],
    edges: [
      { id: 'e1', source: 'topic', target: 'round1' },
      { id: 'e2', source: 'round1', target: 'round2' },
      { id: 'e3', source: 'round2', target: 'judge' },
      { id: 'e4', source: 'judge', target: 'out', sourceHandle: 'true' },
      { id: 'e5', source: 'judge', target: 'round3', sourceHandle: 'false' },
      { id: 'e6', source: 'round3', target: 'out' },
    ],
  }
}

/** Metadata for the round-chain record. */
export const ROUND_CHAIN_NAME = '模板：三轮改写'
export const ROUND_CHAIN_DESCRIPTION =
  '显式轮次链：初稿 → 批评改写 → 分支判断质量 → 直接输出或再来一轮润色。循环是画出来的，不是配置出来的'

/**
 * The templates beyond the first one, in the order the picker shows them.
 *
 * The first entry of the list is whatever the deployment calls its example — the
 * standalone edition overrides it with a workflow that runs with no model at all —
 * so these are appended rather than replacing it.
 */
export const EXTRA_TEMPLATES: { name: string; description: string; graph: WorkflowGraph }[] = [
  { name: ROUND_CHAIN_NAME, description: ROUND_CHAIN_DESCRIPTION, graph: roundChainGraph() },
]

