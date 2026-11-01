<template>
  <div>
    <FtLoader
      v-if="isLoading"
      :fullscreen="true"
    />
    <FtCard
      v-else
      class="card"
    >
      <h2>
        <FontAwesomeIcon
          :icon="['fas', 'search']"
          class="headingIcon"
        />
        {{ t("Search Filters.Search Results") }}
      </h2>
      <div class="searchToolbar">
        <FtButton
          :label="t('Search.Refresh results')"
          :icon="['fas', 'rotate']"
          @click="refreshSearch"
        />
      </div>
      <div
        v-if="errorMessage"
        class="searchStatus searchStatusError"
        role="alert"
      >
        <FontAwesomeIcon
          :icon="['fas', 'triangle-exclamation']"
          class="searchStatusIcon"
        />
        <div class="searchStatusContent">
          <p>{{ errorMessage }}</p>
          <FtButton
            :label="t('Search.Retry')"
            :icon="['fas', 'rotate-right']"
            @click="retrySearch"
          />
        </div>
      </div>
      <div
        v-else-if="shownResults.length === 0 && !isLoading"
        class="searchStatus searchStatusEmpty"
        role="status"
      >
        <FontAwesomeIcon
          :icon="['fas', 'magnifying-glass']"
          class="searchStatusIcon"
        />
        <p>{{ t('Search.No matching results') }}</p>
      </div>
      <div
        v-if="isFetchingMore"
        class="searchStatus searchStatusLoading"
        role="status"
      >
        <FontAwesomeIcon
          :icon="['fas', 'spinner']"
          class="searchStatusIcon loadingSpinner"
        />
        <p>{{ t('Search.Loading more') }}</p>
      </div>
      <FtElementList
        :data="shownResults"
      />
      <FtAutoLoadNextPageWrapper
        v-if="hasMore && !isFetchingMore && !errorMessage"
        @load-next-page="nextPage"
      >
        <div
          class="getNextPage"
          role="button"
          tabindex="0"
          @click="nextPage"
          @keydown.enter.prevent="nextPage"
          @keydown.space.prevent="nextPage"
        >
          <FontAwesomeIcon :icon="['fas', 'search']" /> {{ t("Search Filters.Fetch more results") }}
        </div>
      </FtAutoLoadNextPageWrapper>
    </FtCard>
  </div>
</template>

<script setup>
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'

import FtLoader from '../../components/FtLoader/FtLoader.vue'
import FtCard from '../../components/ft-card/ft-card.vue'
import FtElementList from '../../components/FtElementList/FtElementList.vue'
import FtAutoLoadNextPageWrapper from '../../components/FtAutoLoadNextPageWrapper.vue'
import FtButton from '../../components/FtButton/FtButton.vue'

import store from '../../store'

import {
  copyToClipboard,
  searchFiltersMatch,
  showToast,
} from '../../helpers/utils'
import {
  extractLocalCacheableSearchContinuation,
  getLocalSearchContinuation,
  getLocalSearchResults
} from '../../helpers/api/local'
import { getInvidiousSearchResults } from '../../helpers/api/invidious'
import { SEARCH_CHAR_LIMIT } from '../../../constants'

const { t } = useI18n()
const route = useRoute()

const isLoading = ref(false)
const isFetchingMore = ref(false)
const errorMessage = ref('')
const hasMore = ref(false)
const fetchedAt = ref(0)
const SEARCH_CACHE_MAX_AGE = 60_000
let searchGeneration = 0
const apiUsed = ref('local')
const searchSettings = ref({})
const searchPage = ref(1)
/** @type {import('vue').ShallowRef<import('youtubei.js').YT.Search | string | null>} */
const nextPageRef = shallowRef(null)
const shownResults = shallowRef([])

const query = ref('')
const processedQuery = computed(() => query.value.trim())

/** @type {import('vue').ComputedRef<any[]>} */
const sessionSearchHistory = computed(() => store.getters.getSessionSearchHistory)

/** @type {import('vue').ComputedRef<'local' | 'invidious'>} */
const backendPreference = computed(() => store.getters.getBackendPreference)

/** @type {import('vue').ComputedRef<boolean>} */
const backendFallback = computed(() => store.getters.getBackendFallback)

/** @type {import('vue').ComputedRef<boolean>} */
const showFamilyFriendlyOnly = computed(() => store.getters.getShowFamilyFriendlyOnly)

/** @type {import('vue').ComputedRef<boolean>} */
const rememberSearchHistory = computed(() => store.getters.getRememberSearchHistory)

watch(() => [route.params.query, route.query], () => {
  // Route watchers can also run while navigating away from the search page.
  if (typeof route.params.query !== 'string') {
    searchGeneration++
    return
  }
  query.value = route.params.query.trim()
  const features = route.query.features
  const filters = {
    prioritize: route.query.prioritize,
    time: route.query.time,
    type: route.query.type,
    duration: route.query.duration,
    features: typeof features === 'string' ? [features] : features ?? []
  }
  store.commit('setAppTitle', processedQuery.value)
  checkSearchCache({ query: processedQuery.value, searchSettings: filters })
}, { deep: true, immediate: true })

onBeforeUnmount(() => { searchGeneration++ })

function updateSearchHistoryEntry() {
  const persistentSearchHistoryPayload = {
    _id: processedQuery.value,
    lastUpdatedAt: Date.now()
  }

  store.dispatch('updateSearchHistoryEntry', persistentSearchHistoryPayload)
}

function checkSearchCache(payload, forceRefresh = false) {
  const generation = ++searchGeneration
  isLoading.value = false
  isFetchingMore.value = false
  errorMessage.value = ''
  nextPageRef.value = null
  hasMore.value = false
  searchPage.value = 1
  shownResults.value = []
  searchSettings.value = payload.searchSettings

  if (payload.query.length > SEARCH_CHAR_LIMIT) {
    errorMessage.value = t('Search character limit', { searchCharacterLimit: SEARCH_CHAR_LIMIT })
    return
  }

  const cached = !forceRefresh && sessionSearchHistory.value.find(search =>
    search.query === payload.query && searchFiltersMatch(payload.searchSettings, search.searchSettings) &&
    search.backendPreference === backendPreference.value && search.safetyMode === showFamilyFriendlyOnly.value &&
    Date.now() - search.fetchedAt < SEARCH_CACHE_MAX_AGE
  )
  if (cached) {
    replaceShownResults(cached)
  } else {
    isLoading.value = true
    const request = { ...payload, generation, safetyMode: showFamilyFriendlyOnly.value }
    if (backendPreference.value === 'invidious') {
      performSearchInvidious(request)
    } else {
      performSearchLocal(request)
    }
  }
  if (rememberSearchHistory.value) updateSearchHistoryEntry()
}

function refreshSearch() {
  checkSearchCache({ query: processedQuery.value, searchSettings: searchSettings.value }, true)
}

function retrySearch() {
  if (shownResults.value.length > 0 && hasMore.value) {
    nextPage()
  } else {
    refreshSearch()
  }
}

function appendUniqueResults(results) {
  const seen = new Set()
  shownResults.value = [...shownResults.value, ...results].filter(item => {
    const id = item.videoId ?? item.playlistId ?? item.id ?? item.authorId ?? item.url
    if (!id) return true
    const key = `${item.type}:${id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function cacheResults(payload) {
  store.commit('addToSessionSearchHistory', {
    query: payload.query,
    data: shownResults.value,
    searchSettings: payload.searchSettings,
    nextPageRef: apiUsed.value === 'local' && nextPageRef.value
      ? extractLocalCacheableSearchContinuation(nextPageRef.value)
      : null,
    searchPage: searchPage.value,
    hasMore: hasMore.value,
    apiUsed: apiUsed.value,
    backendPreference: backendPreference.value,
    safetyMode: payload.safetyMode,
    fetchedAt: fetchedAt.value
  })
}

function showSearchError(err, backend) {
  console.error(err)
  errorMessage.value = t('Search.Request failed')
  const message = backend === 'local'
    ? t('Local API Error (Click to copy)')
    : t('Invidious API Error (Click to copy)')
  showToast(`${message}: ${err}`, 10000, () => copyToClipboard(String(err)))
}

async function performSearchLocal(payload) {
  try {
    const { results, continuationData } = await getLocalSearchResults(payload.query, payload.searchSettings, payload.safetyMode)
    if (payload.generation !== searchGeneration) return
    apiUsed.value = 'local'
    shownResults.value = []
    appendUniqueResults(results)
    nextPageRef.value = continuationData ?? null
    hasMore.value = nextPageRef.value !== null
    fetchedAt.value = Date.now()
    cacheResults(payload)
    updateSubscriptionDetails(results)
  } catch (err) {
    if (payload.generation !== searchGeneration) return
    if (backendFallback.value && !payload.fallbackAttempted) {
      return await performSearchInvidious({ ...payload, fallbackAttempted: true })
    }
    showSearchError(err, 'local')
  } finally {
    if (payload.generation === searchGeneration) isLoading.value = false
  }
}

async function getNextpageLocal(payload) {
  try {
    const { results, continuationData } = await getLocalSearchContinuation(payload.nextPageRef)
    if (payload.generation !== searchGeneration) return
    // Consume the continuation even when this page contains no usable items.
    nextPageRef.value = continuationData ?? null
    hasMore.value = nextPageRef.value !== null
    appendUniqueResults(results)
    cacheResults(payload)
    updateSubscriptionDetails(results)
  } catch (err) {
    if (payload.generation === searchGeneration) showSearchError(err, 'local')
  }
}

async function performSearchInvidious(payload, append = false) {
  const page = append ? searchPage.value : 1
  try {
    const results = await getInvidiousSearchResults(payload.query, page, payload.searchSettings)
    if (payload.generation !== searchGeneration) return
    if (!Array.isArray(results)) throw new Error('Invalid search response')
    apiUsed.value = 'invidious'
    nextPageRef.value = null
    if (!append) {
      shownResults.value = []
      fetchedAt.value = Date.now()
    }
    appendUniqueResults(results)
    hasMore.value = results.length > 0
    searchPage.value = page + 1
    cacheResults(payload)
    updateSubscriptionDetails(results)
  } catch (err) {
    if (payload.generation !== searchGeneration) return
    if (!append && process.env.SUPPORTS_LOCAL_API && backendFallback.value && !payload.fallbackAttempted) {
      return await performSearchLocal({ ...payload, fallbackAttempted: true })
    }
    showSearchError(err, 'invidious')
  } finally {
    if (payload.generation === searchGeneration) isLoading.value = false
  }
}

async function nextPage() {
  if (isLoading.value || isFetchingMore.value || !hasMore.value) return
  isFetchingMore.value = true
  errorMessage.value = ''
  const payload = {
    query: processedQuery.value,
    searchSettings: searchSettings.value,
    nextPageRef: nextPageRef.value,
    generation: searchGeneration,
    safetyMode: showFamilyFriendlyOnly.value
  }
  try {
    if (apiUsed.value === 'local') {
      await getNextpageLocal(payload)
    } else {
      await performSearchInvidious(payload, true)
    }
  } finally {
    if (payload.generation === searchGeneration) isFetchingMore.value = false
  }
}

function replaceShownResults(history) {
  shownResults.value = history.data
  searchSettings.value = history.searchSettings
  apiUsed.value = history.apiUsed
  nextPageRef.value = history.nextPageRef ?? null
  searchPage.value = history.searchPage ?? 1
  hasMore.value = history.hasMore ?? (nextPageRef.value !== null)
  fetchedAt.value = history.fetchedAt
  isLoading.value = false
}

/**
 * @param {any[]} results
 */
function updateSubscriptionDetails(results) {
  /** @type {Set<string>} */
  const subscribedChannelIds = store.getters.getSubscribedChannelIdSet

  const channels = []

  for (const result of results) {
    if (result.type !== 'channel' || !subscribedChannelIds.has(result.id ?? result.authorId)) {
      continue
    }

    if (result.dataSource === 'local') {
      channels.push({
        channelId: result.id,
        channelName: result.name,
        channelThumbnailUrl: result.thumbnail.replace(/^\/\//, 'https://')
      })
    } else {
      channels.push({
        channelId: result.authorId,
        channelName: result.author,
        channelThumbnailUrl: result.authorThumbnails[0].url.replace(/^\/\//, 'https://')
      })
    }
  }

  if (channels.length === 1) {
    store.dispatch('updateSubscriptionDetails', channels[0])
  } else if (channels.length > 1) {
    store.dispatch('batchUpdateSubscriptionDetails', channels)
  }
}
</script>

<style scoped src="./SearchPage.css" />
