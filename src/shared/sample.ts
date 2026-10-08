/**
 * The built-in demo workflow, used by the "载入示例" button and the end-to-end
 * acceptance case:
 *
 *   input topic → llm writes an outline → branch (length > 500?) → one output
 *   both arms rejoin.
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
