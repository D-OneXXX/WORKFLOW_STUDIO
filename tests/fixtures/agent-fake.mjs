/**
 * Fake agent CLI used by `tests/connectors.test.mjs`.
 *
 * Stands in for a real agent program (`codex exec`, `zcode run`, …) so the
 * outbound path can be verified end to end without spending anyone's model
 * quota. Select behaviour with `--mode`.
 *
 * It is deliberately a separate process: the point of several modes is what
 * the child can and cannot observe about its parent.
 */

const mode = (() => {
  const index = process.argv.indexOf('--mode')
  return index >= 0 ? process.argv[index + 1] : 'json'
})()

async function readStdin() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

const emit = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  switch (mode) {
    case 'json': {
      const prompt = await readStdin()
      emit({ output: `handled: ${prompt.trim()}`, summary: 'fake agent finished' })
      return
    }
    case 'prompt-arg': {
      // Used with `promptVia: "arg"`, where the prompt arrives as argv instead.
      const index = process.argv.indexOf('--mode')
      const prompt = index >= 0 ? process.argv[index + 2] : ''
      emit({ output: `arg: ${prompt}`, summary: 'fake agent saw the prompt argument' })
      return
    }
    case 'text': {
      await readStdin()
      emit('first line is the summary\nsecond line is more detail\n')
      return
    }
    case 'slow': {
      await readStdin()
      // `--sleep` lets a test ask for a task longer than the 30-second code
      // budget, which is the case an agent node must survive.
      await sleep(Number(process.env.WORKFLOW_STUDIO_FAKE_SLEEP_MS ?? 5_000))
      emit({ output: 'arrived after the long wait', summary: 'fake agent finished slowly' })
      return
    }
    case 'garbage': {
      await readStdin()
      // No `summary`: violates the { output, summary } result contract.
      emit({ output: 'missing the summary field' })
      return
    }
    case 'empty': {
      await readStdin()
      emit('')
      return
    }
    case 'env': {
      await readStdin()
      // Proves the worker's secrets never reach an agent child, and that the
      // delegation depth does.
      emit({
        output: {
          keys: Object.keys(process.env).sort(),
          depth: process.env.WORKFLOW_STUDIO_DEPTH ?? null,
          secret: process.env.WORKFLOW_STUDIO_TEST_SECRET ?? null,
          harnessToken: process.env.HARNESS_TOKEN ?? null,
        },
        summary: `depth=${process.env.WORKFLOW_STUDIO_DEPTH ?? 'unset'}`,
      })
      return
    }
    case 'fail': {
      await readStdin()
      // stderr carries a credential-shaped string on purpose: the registry must
      // redact it before anything reaches the run log.
      process.stderr.write('authentication failed api_key=LEAKME-1234567890\n')
      process.exit(3)
    }
    default: {
      process.stderr.write(`unknown --mode ${mode}\n`)
      process.exit(2)
    }
  }
}

await main()
