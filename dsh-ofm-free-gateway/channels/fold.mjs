/**
 * 剥离版自包含的 chunk 折叠与用量换算。
 *
 * 从原项目 src/core/completion.js（foldForwardOutcome）与
 * src/forward.js（toOpenAiUsage）内联而来，仅保留纯函数部分，
 * 不依赖任何 @deepseek-ai 包或仓库 src/ 目录。
 */

/** 把渠道返回的内部 usage 换算成 OpenAI 格式。 */
export function toOpenAiUsage(usage) {
  if (usage === undefined) return undefined
  return {
    prompt_tokens: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0),
    completion_tokens: usage.outputTokens ?? 0,
    total_tokens: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.outputTokens ?? 0),
    prompt_tokens_details: { cached_tokens: usage.cacheReadTokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
  }
}

/** 把流式 chunk 折叠进 outcome 累加器。 */
export function foldForwardOutcome(outcome, chunk) {
  switch (chunk.type) {
    case 'text-delta': outcome.text += chunk.text; break
    case 'tool-call-delta': {
      let call = outcome.toolCalls.find(candidate => candidate.slot === chunk.index)
      if (call === undefined) {
        call = { slot: chunk.index, id: chunk.id ?? '', name: chunk.name ?? '', arguments: chunk.argumentsDelta ?? '' }
        outcome.toolCalls.push(call)
      }
      else call.arguments += chunk.argumentsDelta ?? ''
      if (chunk.name) call.name = chunk.name
      if (chunk.id) call.id = chunk.id
      break
    }
    case 'block-end':
      if (chunk.block?.type === 'tool-call') {
        const bySlot = outcome.toolCalls.find(candidate => candidate.slot === chunk.index)
        if (bySlot !== undefined) {
          if (typeof chunk.block.id === 'string' && chunk.block.id !== '') bySlot.id = chunk.block.id
          if (typeof chunk.block.name === 'string' && chunk.block.name !== '') bySlot.name = chunk.block.name
          if (typeof chunk.block.arguments === 'string') bySlot.arguments = chunk.block.arguments
          break
        }
        const byId = outcome.toolCalls.find(candidate => typeof candidate.id === 'string' && candidate.id !== ''
          && candidate.id === chunk.block.id)
        if (byId === undefined) {
          outcome.toolCalls.push({
            slot: chunk.index,
            id: typeof chunk.block.id === 'string' ? chunk.block.id : '',
            name: typeof chunk.block.name === 'string' ? chunk.block.name : '',
            arguments: typeof chunk.block.arguments === 'string' ? chunk.block.arguments : '',
          })
        }
      }
      break
    case 'usage': outcome.usage = toOpenAiUsage(chunk.usage); break
    case 'finish':
      if (chunk.reason?.kind === 'max-tokens') outcome.truncated = true
      if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') outcome.error = chunk.reason.failure?.message
      break
    default: break
  }
  return outcome
}
