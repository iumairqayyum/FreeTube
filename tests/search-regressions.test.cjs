const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const assert = require('node:assert/strict')

const root = resolve(__dirname, '..')
const read = path => readFileSync(resolve(root, path), 'utf8')
const source = read('src/renderer/views/SearchPage/SearchPage.vue')
const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1]
  .replace(/^import[\s\S]*?from ['"][^'"]+['"]\n/gm, '')
const utils = read('src/renderer/store/modules/utils.js')
const mutation = utils.slice(utils.indexOf('  addToSessionSearchHistory (state, payload) {'), utils.indexOf('\n  setShowAddToPlaylistPrompt'))
  .replace('  addToSessionSearchHistory (state, payload) {', '(function (state, payload) {')
  .replace(/},\s*$/, '})')
const filtersMatch = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const saveCache = vm.runInNewContext(mutation, { searchFiltersMatch: filtersMatch })
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const video = id => ({ type: 'video', videoId: id })
const result = (id, continuationData = null) => ({ results: [video(id)], continuationData })

function harness({ local = async () => result('first'), more = async () => result('next'), iv = async () => [], backend = 'local', fallback = false } = {}) {
  const cache = []
  const calls = { local: 0, more: 0, iv: 0 }
  const getters = {
    getSessionSearchHistory: cache,
    getBackendPreference: backend,
    getBackendFallback: fallback,
    getShowFamilyFriendlyOnly: false,
    getRememberSearchHistory: false,
    getSubscribedChannelIdSet: new Set()
  }
  const state = { sessionSearchHistory: cache }
  const watches = []
  let unmount
  const context = {
    ref: value => ({ value }), shallowRef: value => ({ value }),
    computed: get => ({ get value() { return get() } }),
    watch: (get, callback, options) => { watches.push(callback); if (options?.immediate) callback() },
    onBeforeUnmount: callback => { unmount = callback },
    useI18n: () => ({ t: key => key }),
    useRoute: () => ({ params: { query: 'initial' }, query: {} }),
    store: { getters, commit: (name, payload) => { if (name === 'addToSessionSearchHistory') saveCache(state, payload) }, dispatch() {} },
    searchFiltersMatch: filtersMatch, showToast() {}, copyToClipboard() {},
    getLocalSearchResults: (...args) => { calls.local++; return local(...args) },
    getLocalSearchContinuation: (...args) => { calls.more++; return more(...args) },
    getInvidiousSearchResults: (...args) => { calls.iv++; return iv(...args) },
    extractLocalCacheableSearchContinuation: token => token,
    SEARCH_CHAR_LIMIT: 100, process: { env: { SUPPORTS_LOCAL_API: true } },
    Date, Set, console: { error() {}, warn() {} }
  }
  const api = vm.runInNewContext(`${script}\n;({ checkSearchCache, nextPage, refreshSearch, retrySearch, resultOrder, orderedResults, shownResults, nextPageRef, hasMore, isLoading, isFetchingMore, errorMessage, searchPage })`, context)
  return { ...api, calls, cache, getters, unmount: () => unmount() }
}
const search = (h, query) => h.checkSearchCache({ query, searchSettings: { features: [] } })

test('latest search wins when earlier success arrives late', async () => {
  const old = deferred()
  const h = harness({ local: q => q === 'initial' ? old.promise : Promise.resolve(result('new')) })
  search(h, 'new query')
  await tick()
  old.resolve(result('old'))
  await tick()
  assert.equal(h.shownResults.value[0].videoId, 'new')
  assert.equal(h.cache.length, 1)
})

test('stale failure cannot trigger fallback or replace current UI', async () => {
  const old = deferred()
  const h = harness({ fallback: true, local: q => q === 'initial' ? old.promise : Promise.resolve(result('new')) })
  search(h, 'new query'); await tick()
  old.reject(new Error('old request failed')); await tick()
  assert.equal(h.calls.iv, 0)
  assert.equal(h.errorMessage.value, '')
})

test('load more is single-flight and updates an empty terminal continuation', async () => {
  const pending = deferred()
  const h = harness({ local: async () => result('first', 'token'), more: () => pending.promise })
  await tick()
  const first = h.nextPage()
  await h.nextPage()
  assert.equal(h.calls.more, 1)
  pending.resolve({ results: [], continuationData: null })
  await first
  assert.equal(h.nextPageRef.value, null)
  assert.equal(h.hasMore.value, false)
  assert.equal(h.cache[0].nextPageRef, null)
  await h.nextPage()
  assert.equal(h.calls.more, 1)
})

test('restoring a terminal cached search clears another search token', async () => {
  const h = harness({ local: async q => result(q, q === 'initial' ? null : 'other-token') })
  await tick(); search(h, 'other'); await tick(); search(h, 'initial')
  assert.equal(h.nextPageRef.value, null)
  assert.equal(h.hasMore.value, false)
  assert.equal(h.calls.local, 2)
})

test('late pagination cannot append into a newer search', async () => {
  const pending = deferred()
  const h = harness({ local: async q => result(q, 'token'), more: () => pending.promise })
  await tick(); const page = h.nextPage(); search(h, 'new'); await tick()
  pending.resolve(result('stale')); await page
  assert.deepEqual(Array.from(h.shownResults.value, v => v.videoId), ['new'])
})

test('refresh bypasses cache and old cache entries expire', async () => {
  const h = harness(); await tick()
  search(h, 'initial'); assert.equal(h.calls.local, 1)
  h.refreshSearch(); await tick(); assert.equal(h.calls.local, 2)
  h.cache[0].fetchedAt = Date.now() - 61_000
  search(h, 'initial'); await tick(); assert.equal(h.calls.local, 3)
})

test('cache is separated by safety mode and backend', async () => {
  const h = harness(); await tick()
  h.getters.getShowFamilyFriendlyOnly = true
  search(h, 'initial'); await tick(); assert.equal(h.calls.local, 2)
  h.getters.getBackendPreference = 'invidious'
  search(h, 'initial'); await tick(); assert.equal(h.calls.iv, 1)
})

test('request failure is distinct from an empty successful search and retry works', async () => {
  let fail = true
  const h = harness({ local: async () => { if (fail) throw new Error('network'); return { results: [], continuationData: null } } })
  await tick(); assert.equal(h.errorMessage.value, 'Search.Request failed')
  assert.equal(h.isLoading.value, false)
  fail = false; h.retrySearch(); await tick()
  assert.equal(h.errorMessage.value, '')
  assert.equal(h.hasMore.value, false)
})

test('automatic backend fallback is bounded to one attempt', async () => {
  const h = harness({ fallback: true, local: async () => { throw new Error('local') }, iv: async () => { throw new Error('iv') } })
  await tick()
  assert.equal(h.calls.local, 1)
  assert.equal(h.calls.iv, 1)
  assert.equal(h.isLoading.value, false)
  assert.ok(h.errorMessage.value)
})

test('Invidious empty pagination stops additional requests', async () => {
  const h = harness({ backend: 'invidious', iv: async (q, page) => page === 1 ? [video('one')] : [] })
  await tick(); await h.nextPage(); await h.nextPage()
  assert.equal(h.calls.iv, 2)
  assert.equal(h.hasMore.value, false)
})

test('duplicate video entries are removed without dropping different entity types', async () => {
  const h = harness({ local: async () => result('one', 'token'), more: async () => ({ results: [video('one'), video('two'), { type: 'channel', id: 'one' }], continuationData: null }) })
  await tick(); await h.nextPage()
  assert.equal(h.shownResults.value.length, 3)
})

test('unmounted search ignores pending results', async () => {
  const pending = deferred(); const h = harness({ local: () => pending.promise })
  h.unmount(); pending.resolve(result('late')); await tick()
  assert.equal(h.cache.length, 0)
})

test('cache snapshot replaces exhausted tokens and backend metadata together', () => {
  const state = { sessionSearchHistory: [] }
  saveCache(state, { query: 'q', searchSettings: {}, data: [], nextPageRef: 'old', apiUsed: 'local' })
  saveCache(state, { query: 'q', searchSettings: {}, data: [], nextPageRef: null, apiUsed: 'invidious', searchPage: 2 })
  assert.equal(state.sessionSearchHistory[0].nextPageRef, null)
  assert.equal(state.sessionSearchHistory[0].apiUsed, 'invidious')
})

test('H264 preference targets DASH and leaves audio, legacy and VR defaults intact', () => {
  const player = read('src/renderer/components/ft-shaka-video-player/ft-shaka-video-player.js')
  const start = player.indexOf('    function getPlayerConfig(')
  const end = player.indexOf('\n    }', start) + 6
  const store = { getters: { getPreferH264: false } }
  const props = { vrProjection: undefined }
  const config = vm.runInNewContext(`(${player.slice(start, end)})`, { store, props, manifestPreprocessorTXml() {} })
  assert.equal(config('dash').preferredVideoCodecs.length, 0)
  store.getters.getPreferH264 = true
  assert.equal(config('dash').preferredVideoCodecs[0], 'avc1')
  assert.equal(config('audio').preferredVideoCodecs.length, 0)
  assert.equal(config('legacy').preferredVideoCodecs.length, 0)
  store.getters.getPreferH264 = false; props.vrProjection = '360'
  assert.deepEqual(Array.from(config('dash').preferredVideoCodecs), ['av01', 'avc1'])
})

test('failed pagination preserves the page and retries the same continuation', async () => {
  let fail = true
  const tokens = []
  const h = harness({ local: async () => result('first', 'retry-token'), more: async token => {
    tokens.push(token)
    if (fail) throw new Error('temporary')
    return result('second')
  } })
  await tick(); await h.nextPage()
  assert.equal(h.shownResults.value.length, 1)
  assert.equal(h.hasMore.value, true)
  assert.equal(h.isFetchingMore.value, false)
  fail = false; h.retrySearch(); await tick()
  assert.deepEqual(tokens, ['retry-token', 'retry-token'])
  assert.equal(h.shownResults.value.length, 2)
  assert.equal(h.errorMessage.value, '')
})

test('query and filters travel together through asynchronous requests', async () => {
  const calls = []
  const h = harness({ local: async (q, filters) => { calls.push({ q, filters }); return result(q) } })
  await tick()
  const filters = { features: ['hd'], time: 'today', type: 'video', prioritize: 'relevance' }
  h.checkSearchCache({ query: 'news', searchSettings: filters }); await tick()
  assert.equal(calls[1].q, 'news')
  assert.deepEqual(calls[1].filters, filters)
  assert.deepEqual(h.cache[1].searchSettings, filters)
})

test('newest local results sort without mutating original or cached order', async () => {
  const h = harness({ local: async () => ({ results: [
    { ...video('old'), published: 1700000000000 },
    { ...video('unknown') },
    { type: 'channel', id: 'channel', published: 1900000000000 },
    { ...video('new'), published: 1800000000000 },
    { ...video('live'), published: 1900000000000, liveNow: true },
    { ...video('invalid'), published: NaN }
  ], continuationData: null }) })
  await tick()
  h.resultOrder.value = 'newest'
  assert.deepEqual(Array.from(h.orderedResults.value, v => v.videoId ?? v.id), ['new', 'old', 'unknown', 'channel', 'live', 'invalid'])
  assert.equal(h.cache[0].data[0].videoId, 'old')
  h.resultOrder.value = 'original'
  assert.equal(h.orderedResults.value[0].videoId, 'old')
})

test('new pages join newest ordering and equal dates retain original order', async () => {
  const h = harness({ local: async () => ({ results: [{ ...video('old'), published: 1000 }], continuationData: 'token' }),
    more: async () => ({ results: [{ ...video('new'), published: 2000 }, { ...video('tie'), published: 2000 }], continuationData: null }) })
  await tick()
  h.resultOrder.value = 'newest'
  await h.nextPage()
  assert.deepEqual(Array.from(h.orderedResults.value, v => v.videoId), ['new', 'tie', 'old'])
  assert.equal(h.hasMore.value, false)
})

test('Invidious seconds sort and upcoming or missing dates stay last', async () => {
  const h = harness({ backend: 'invidious', iv: async () => [
    { ...video('old'), published: 1700000000 },
    { ...video('upcoming'), published: 1900000000, isUpcoming: true },
    { ...video('new'), published: 1800000000 },
    video('unknown')
  ] })
  await tick()
  h.resultOrder.value = 'newest'
  assert.deepEqual(Array.from(h.orderedResults.value, v => v.videoId), ['new', 'old', 'upcoming', 'unknown'])
})
