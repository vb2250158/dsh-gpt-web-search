import assert from 'node:assert/strict'
import { ReadableStream } from 'node:stream/web'
import test from 'node:test'
import {
  DEFAULT_MODEL,
  GPT_WEB_SEARCH_PROVIDER_ID,
  GptSubscriptionSearchProvider,
} from '../lib/index.js'

function responseStream(events) {
  const encoder = new TextEncoder()
  const payload = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function provider(fetchFn) {
  return new GptSubscriptionSearchProvider({
    authStorePath: 'unused-in-mocked-search',
  }, fetchFn)
}

test('GPT search provider has a stable id and model default', () => {
  const instance = provider(async () => { throw new Error('not called') })
  assert.equal(instance.id, GPT_WEB_SEARCH_PROVIDER_ID)
  assert.equal(instance.config.model, DEFAULT_MODEL)
  assert.equal(instance.available(), true)
})

test('GPT search provider requests native search and maps answer citations', async () => {
  const events = [
    {
      type: 'response.output_text.annotation.added',
      annotation: { type: 'url_citation', url: 'https://example.test/a', title: 'Example A' },
    },
    {
      type: 'response.output_item.done',
      item: { type: 'web_search_call', status: 'completed' },
    },
    {
      type: 'response.output_item.done',
      item: {
        type: 'message',
        content: [{
          type: 'output_text',
          text: 'Grounded answer',
          annotations: [{ type: 'url_citation', url: 'https://example.test/a', title: 'Example A' }],
        }],
      },
    },
    { type: 'response.completed', response: {} },
  ]
  let request
  const instance = new GptSubscriptionSearchProvider({}, async (_url, init) => {
    request = JSON.parse(init.body)
    return new Response(responseStream(events), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  })
  const result = await instance.searchWithSession(
    { query: 'current fact', maxResults: 10 },
    { accessToken: 'token', accountId: 'account' },
  )
  assert.equal(request.model, DEFAULT_MODEL)
  assert.deepEqual(request.tools, [{ type: 'web_search' }])
  assert.equal(request.tool_choice, 'required')
  assert.equal(result.content, 'Grounded answer')
  assert.deepEqual(result.sources, [{ url: 'https://example.test/a', title: 'Example A' }])
})

test('GPT search provider rejects responses without native search completion', async () => {
  const instance = new GptSubscriptionSearchProvider({}, async () => new Response(responseStream([
    { type: 'response.completed', response: {} },
  ]), { status: 200 }))
  await assert.rejects(instance.searchWithSession(
    { query: 'q' },
    { accessToken: 'token', accountId: 'account' },
  ), /no completed native web search call/)
})
