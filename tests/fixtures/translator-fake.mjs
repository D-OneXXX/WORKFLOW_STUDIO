/**
 * Fake translator CLI used by `tests/translate-api.test.mjs`.
 *
 * Stands in for a real model behind a connector, so the plain-language path can
 * be verified end to end — the prompt that is built, the answer that is parsed,
 * the failures that must stay readable — without spending anyone's quota.
 *
 * Behaviour is selected with `--mode`, exactly like `agent-fake.mjs`.
 */

const mode = (() => {
  const index = process.argv.indexOf('--mode')
  return index >= 0 ? process.argv[index + 1] : 'fixed'
})()

async function readStdin() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

const emit = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))

/** The reply the test asked for, as an object, a JSON string, or a fenced block. */
function configuredReply() {
  const raw = process.env.WFS_REPLY ?? '{"status":"untranslatable","reason":"没有配置回复"}'
  const shape = process.env.WFS_REPLY_SHAPE ?? 'object'
  if (shape === 'object') return JSON.parse(raw)
  if (shape === 'string') return raw
  return `\`\`\`json\n${raw}\n\`\`\``
}

/**
 * Reports facts about the prompt it was handed, inside the `reason` field of an
 * `untranslatable` answer. That is the only channel the API surfaces, which makes
 * it a clean way to assert what the model actually received: the node list, the
 * user's words, and the marker block around them.
 */
function reflect(prompt) {
  const inventory = /节点清单/.test(prompt)
  const upstreamMark = prompt.includes('上游，值可用')
  const words = prompt.split('[[[用户描述开始]]]')[1]?.split('[[[用户描述结束]]]')[0]?.trim() ?? ''
  const kind = prompt.match(/关于一个(条件分支|大模型|代码)节点/)?.[1] ?? 'unknown'
  return {
    status: 'untranslatable',
    reason: JSON.stringify({ kind, inventory, upstreamMark, words, length: prompt.length }),
  }
}

/**
 * Answers according to the kind named in the prompt, echoing the user's words
 * back into the produced field. Used for driving the real property panel by
 * hand: one connector serves all three node kinds, and the preview visibly
 * carries what was typed, so a wrong mapping is obvious on screen.
 *
 * Two phrases in the description steer the awkward states, which is what makes
 * the fallbacks checkable without a model that happens to refuse:
 * 「歧义」 asks for a candidate pick, 「翻不了」 says it cannot be translated.
 */
function byKind(prompt) {
  const words = prompt.split('[[[用户描述开始]]]')[1]?.split('[[[用户描述结束]]]')[0]?.trim() ?? ''
  // Once the user has picked a candidate the request carries that decision, and
  // a model that obeys it must not ask the same question again.
  const pinned = prompt.includes('用户已经手工指定')
  if (!pinned && words.includes('翻不了')) {
    return { status: 'untranslatable', reason: '这句里的判断不是长度或包含关系能表达的' }
  }
  if (!pinned && words.includes('歧义')) {
    return { status: 'ambiguous', term: '大纲', candidates: ['n2', 'n3'] }
  }
  if (/关于一个条件分支节点/.test(prompt)) {
    return { status: 'ok', config: { type: 'len_gt', value: '500' }, ref: 'n2' }
  }
  if (/关于一个大模型节点/.test(prompt)) {
    return { status: 'ok', config: { prompt: `${words}（来自 {{n1}}）` }, ref: 'n1' }
  }
  return { status: 'ok', config: { code: `return String(input) + '｜${words}'` }, ref: null }
}

async function main() {
  switch (mode) {
    case 'bykind': {
      const prompt = await readStdin()
      emit({ output: byKind(prompt), summary: 'fake translator' })
      return
    }
    case 'fixed': {
      await readStdin()
      emit({ output: configuredReply(), summary: 'fake translator' })
      return
    }
    case 'reflect': {
      const prompt = await readStdin()
      emit({ output: reflect(prompt), summary: 'fake translator' })
      return
    }
    case 'prose': {
      await readStdin()
      // A chatty model: the JSON is right, but wrapped in sentences.
      emit({
        output: `我按你的要求翻好了：${JSON.stringify(configuredReplyObject())}\n有问题再找我。`,
        summary: 'fake translator',
      })
      return
    }
    case 'garbage': {
      await readStdin()
      emit({ output: '这个节点应该是判断长短的，我建议你用长度大于。', summary: 'fake translator' })
      return
    }
    case 'defiant': {
      await readStdin()
      // The description told it to change the output format. Whether it obeyed is
      // the caller's problem: an answer that is not the agreed shape must fail
      // readably rather than configure something.
      emit({ output: 'HAPPY-IGNORED-INSTRUCTIONS', summary: 'fake translator' })
      return
    }
    case 'slow': {
      await readStdin()
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.WFS_SLOW_MS ?? 5_000)))
      emit({ output: configuredReply(), summary: 'fake translator' })
      return
    }
    default: {
      process.stderr.write(`unknown --mode ${mode}\n`)
      process.exit(2)
    }
  }
}

function configuredReplyObject() {
  const raw = process.env.WFS_REPLY ?? '{}'
  try {
    return JSON.parse(raw)
  } catch {
    return { status: 'untranslatable', reason: 'not json' }
  }
}

await main()
