import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'

export const name = 'gpt-web-search'
export const inject = ['web']

export const GPT_WEB_SEARCH_PROVIDER_ID = 'gpt-subscription'
export const GPT_WEB_SEARCH_SETTINGS_NAMESPACE = 'gpt-web-search'
export const DEFAULT_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
export const DEFAULT_MODEL = 'gpt-5.6-sol'
export const DEFAULT_ORIGINATOR = 'codex_cli_rs'
export const DEFAULT_INSTRUCTIONS = 'Search the public web for the user query. Return a concise answer grounded in the search results and cite every factual claim.'

export const Config = z.object({
  authStorePath: z.string(),
  endpoint: z.string().default(DEFAULT_ENDPOINT),
  model: z.string().default(DEFAULT_MODEL),
  originator: z.string().default(DEFAULT_ORIGINATOR),
  instructions: z.string().default(DEFAULT_INSTRUCTIONS),
})

function resolvedConfig(config = {}) {
  return {
    authStorePath: config.authStorePath ?? dshHomePath('plugins', 'subscriptions', 'auth.json'),
    endpoint: config.endpoint ?? DEFAULT_ENDPOINT,
    model: config.model ?? DEFAULT_MODEL,
    originator: config.originator ?? DEFAULT_ORIGINATOR,
    instructions: config.instructions ?? DEFAULT_INSTRUCTIONS,
  }
}

function abortError(cause) {
  const error = new Error('GPT web search aborted', { cause })
  error.code = 'WEB_ABORTED'
  return error
}

function providerError(message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.code = 'WEB_PROVIDER_ERROR'
  return error
}

function credentialError(message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.code = 'WEB_PROVIDER_CREDENTIAL_MISSING'
  return error
}

function isAbortError(error, signal) {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
}

function parseAuthStore(text, path) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw credentialError(`GPT web search could not parse the ChatGPT subscription auth store at ${path}`, error)
  }
  const provider = parsed?.schemaVersion === 2 ? parsed.providers?.codex : parsed?.codex
  const accounts = provider?.accounts
  const keys = accounts && typeof accounts === 'object'
    ? [...new Set([provider.default, ...(provider.order ?? []), ...Object.keys(accounts)])].filter(key => typeof key === 'string')
    : []
  const key = keys.find(key => accounts[key] && accounts[key].enabled !== false && !provider.disabled?.includes(key))
  const session = accounts ? (accounts[key]?.session ?? accounts[key]) : provider
  if (typeof session?.accessToken !== 'string' || session.accessToken.length === 0
    || typeof session.accountId !== 'string' || session.accountId.length === 0) {
    throw credentialError('GPT web search requires a ChatGPT subscription login in Settings → Subscriptions')
  }
  return session
}

async function loadCodexSession(path, signal) {
  if (signal?.aborted === true) throw abortError(signal.reason)
  try {
    return parseAuthStore(await readFile(path, { encoding: 'utf8', signal }), path)
  } catch (error) {
    if (isAbortError(error, signal)) throw abortError(error)
    if (error?.code === 'WEB_PROVIDER_CREDENTIAL_MISSING') throw error
    if (error?.code === 'ENOENT') {
      throw credentialError('GPT web search requires a ChatGPT subscription login in Settings → Subscriptions', error)
    }
    throw credentialError(`GPT web search could not read the ChatGPT subscription auth store at ${path}`, error)
  }
}

async function* parseSse(stream, signal) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let dataLines = []
  try {
    while (true) {
      if (signal?.aborted === true) throw abortError(signal.reason)
      const { done, value } = await reader.read()
      if (done) return
      pending += decoder.decode(value, { stream: true })
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        let line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line.length === 0) {
          if (dataLines.length > 0) yield dataLines.join('\n')
          dataLines = []
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''))
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function pushSource(sources, seen, annotation) {
  if (annotation?.type !== 'url_citation' || typeof annotation.url !== 'string' || annotation.url.length === 0 || seen.has(annotation.url)) return
  seen.add(annotation.url)
  sources.push({
    url: annotation.url,
    ...typeof annotation.title === 'string' && annotation.title.length > 0 ? { title: annotation.title } : {},
  })
}

export function completedItem(event, answer, sources, seen) {
  const item = event?.item
  if (item?.type !== 'message' || !Array.isArray(item.content)) return answer
  let next = answer
  for (const part of item.content) {
    if (part?.type !== 'output_text') continue
    if (typeof part.text === 'string' && part.text.length > 0) next = part.text
    const annotations = Array.isArray(part.annotations) ? part.annotations : part.annotations === undefined ? [] : [part.annotations]
    for (const annotation of annotations) pushSource(sources, seen, annotation)
  }
  return next
}

export async function parseSearchResponse(stream, signal) {
  let answer = ''
  let completed = false
  let searchCompleted = false
  const sources = []
  const seen = new Set()
  try {
    for await (const data of parseSse(stream, signal)) {
      let event
      try {
        event = JSON.parse(data)
      } catch (error) {
        throw providerError(`GPT web search returned malformed SSE: ${data.slice(0, 120)}`, error)
      }
      if (event.type === 'response.output_text.annotation.added') pushSource(sources, seen, event.annotation)
      else if (event.type === 'response.output_item.done') {
        if (event.item?.type === 'web_search_call' && event.item.status === 'completed') searchCompleted = true
        answer = completedItem(event, answer, sources, seen)
      } else if (event.type === 'response.web_search_call.completed') searchCompleted = true
      else if (event.type === 'response.completed') completed = true
      else if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') {
        const detail = event.response?.error?.message ?? event.response?.incomplete_details?.reason ?? event.message ?? event.code ?? event.type
        throw providerError(`GPT web search failed: ${detail}`)
      }
    }
  } catch (error) {
    if (isAbortError(error, signal)) throw abortError(error)
    throw error
  }
  if (!completed) throw providerError('GPT web search stream ended before response.completed')
  if (!searchCompleted) throw providerError('GPT returned no completed native web search call')
  return {
    ...answer.length > 0 ? { content: answer } : {},
    sources,
    truncated: false,
  }
}

export class GptSubscriptionSearchProvider {
  id = GPT_WEB_SEARCH_PROVIDER_ID

  constructor(config, fetchFn = fetch) {
    this.config = resolvedConfig(config)
    this.fetchFn = fetchFn
  }

  available() {
    return this.config.endpoint.length > 0 && this.config.model.length > 0 && URL.canParse(this.config.endpoint)
  }

  async search(request, signal) {
    return this.searchWithSession(request, await loadCodexSession(this.config.authStorePath, signal), signal)
  }

  async searchWithSession(request, session, signal) {
    let response
    try {
      response = await this.fetchFn(this.config.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'chatgpt-account-id': session.accountId,
          originator: this.config.originator,
          accept: 'text/event-stream',
          'content-type': 'application/json',
          'session-id': randomUUID(),
        },
        body: JSON.stringify({
          model: this.config.model,
          instructions: this.config.instructions,
          input: [{
            role: 'user',
            content: [{ type: 'input_text', text: request.query }],
          }],
          tools: [{ type: 'web_search' }],
          tool_choice: 'required',
          parallel_tool_calls: true,
          store: false,
          stream: true,
          include: ['reasoning.encrypted_content'],
        }),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error) {
      if (isAbortError(error, signal)) throw abortError(error)
      throw providerError(`GPT web search request failed: ${String(error)}`, error)
    }
    if (!response.ok) {
      let detail = `HTTP ${response.status}`
      try {
        const text = await response.text()
        if (text.length > 0) detail = text.slice(0, 500)
      } catch (error) {
        if (isAbortError(error, signal)) throw abortError(error)
      }
      if (response.status === 401 || response.status === 403) {
        throw credentialError(`GPT web search subscription authorization failed (${detail}); log in again in Settings → Subscriptions`)
      }
      throw providerError(`GPT web search API error (${detail})`)
    }
    if (response.body === null) throw providerError('GPT web search API returned no response body')
    return parseSearchResponse(response.body, signal)
  }
}

export function apply(ctx, config) {
  const current = () => config.get()
  ctx.web.registerSearchProvider({
    id: GPT_WEB_SEARCH_PROVIDER_ID,
    available: () => new GptSubscriptionSearchProvider(current()).available(),
    search: (request, signal) => new GptSubscriptionSearchProvider(current()).search(request, signal),
  })
}
