import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import {setActivePinia, createPinia} from 'pinia'

import {useAuthStore} from './auth'
import {removeToken} from '@/helpers/auth'
import {AUTH_TYPES} from '@/constants/auth'

// Real @/helpers/auth so the counts cover its dedupe; only the transport is mocked.
const {postMock, userShowMock, openidCallbackMock} = vi.hoisted(() => ({
	postMock: vi.fn(),
	userShowMock: vi.fn(),
	openidCallbackMock: vi.fn(),
}))

vi.mock('@/client/generated', async (importOriginal) => ({
	...await importOriginal<typeof import('@/client/generated')>(),
	authRefreshToken: postMock,
	userShow: userShowMock,
	authOpenidCallback: openidCallbackMock,
}))

vi.mock('@/router', () => ({
	default: {push: vi.fn()},
}))

vi.mock('@/client/queryClient', async () => {
	const {QueryClient} = await import('@tanstack/vue-query')
	return {queryClient: new QueryClient({defaultOptions: {queries: {retry: false}}})}
})

vi.mock('@/composables/useWebSocket', () => ({
	useWebSocket: () => ({
		disconnect: vi.fn(),
		connect: vi.fn(),
		closeStaleConnection: vi.fn(),
	}),
}))

vi.mock('@/helpers/redirectToProvider', () => ({
	getRedirectUrlFromCurrentFrontendPath: vi.fn(),
	redirectToProvider: vi.fn(),
	redirectToProviderOnLogout: vi.fn(),
}))

const STALE_JWT = `header.${btoa(JSON.stringify({
	id: 1,
	type: AUTH_TYPES.USER,
	exp: Math.floor(Date.now() / 1000) - 3600,
}))}.signature`

const FRESH_JWT = `header.${btoa(JSON.stringify({
	id: 1,
	type: AUTH_TYPES.USER,
	exp: Math.floor(Date.now() / 1000) + 3600,
}))}.signature`

function refreshRejection(status: number, code?: number) {
	return {status, code}
}

function refreshCalls() {
	return postMock.mock.calls.length
}

describe('auth store checkAuth refresh (issue #4023)', () => {
	beforeEach(() => {
		setActivePinia(createPinia())
		postMock.mockReset()
		removeToken()
		localStorage.clear()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('does not refresh without a stored token', async () => {
		const store = useAuthStore()

		await store.checkAuth()

		expect(refreshCalls()).toBe(0)
		expect(store.authenticated).toBe(false)
	})

	it('drops a stale token once its refresh is rejected', async () => {
		localStorage.setItem('token', STALE_JWT)
		postMock.mockRejectedValue(refreshRejection(401, 16003))
		const store = useAuthStore()

		await store.checkAuth()
		const callsAfterFirstCheck = refreshCalls()

		expect(callsAfterFirstCheck).toBeGreaterThan(0)
		expect(localStorage.getItem('token')).toBeNull()
		expect(store.authenticated).toBe(false)

		// The router guard runs checkAuth again for the /login redirect.
		await store.checkAuth()

		expect(refreshCalls()).toBe(callsAfterFirstCheck)
	})

	it('refreshes once and not again this boot when no refresh cookie was sent', async () => {
		localStorage.setItem('token', STALE_JWT)
		postMock.mockRejectedValue(refreshRejection(401, 16005))
		const store = useAuthStore()

		await store.checkAuth()

		expect(refreshCalls()).toBe(1)
		expect(localStorage.getItem('token')).toBeNull()

		await store.checkAuth()

		expect(refreshCalls()).toBe(1)
	})

	it('retries once when the refresh token was rotated away', async () => {
		localStorage.setItem('token', STALE_JWT)
		postMock.mockRejectedValue(refreshRejection(401, 16002))
		const store = useAuthStore()

		await store.checkAuth()

		expect(refreshCalls()).toBe(2)
	})

	it('keeps the token on a navigation rate limit without backing off or refreshing it again', async () => {
		localStorage.setItem('token', STALE_JWT)
		postMock.mockRejectedValue(refreshRejection(429))
		const store = useAuthStore()

		await store.checkAuth()

		expect(refreshCalls()).toBe(1)
		expect(localStorage.getItem('token')).toBe(STALE_JWT)
		expect(store.authenticated).toBe(false)

		await store.checkAuth()

		expect(refreshCalls()).toBe(1)
	})

	it('stays logged in when the boot refresh succeeds after a rate limit', async () => {
		vi.useFakeTimers()
		localStorage.setItem('token', STALE_JWT)
		postMock
			.mockRejectedValueOnce(refreshRejection(429))
			.mockRejectedValueOnce(refreshRejection(429))
			.mockResolvedValue({data: {token: FRESH_JWT}})
		userShowMock.mockResolvedValue({data: {id: 1, username: 'user1'}})
		const store = useAuthStore()

		const check = store.checkAuth({boot: true})
		await vi.runAllTimersAsync()
		await check

		expect(refreshCalls()).toBe(3)
		expect(localStorage.getItem('token')).toBe(FRESH_JWT)
		expect(store.authenticated).toBe(true)
	})

	it('rejects with the rate limit and keeps the token when the boot backoff runs out', async () => {
		vi.useFakeTimers()
		localStorage.setItem('token', STALE_JWT)
		postMock.mockRejectedValue(refreshRejection(429))
		const store = useAuthStore()

		const check = expect(store.checkAuth({boot: true})).rejects.toMatchObject({cause: {status: 429}})
		await vi.runAllTimersAsync()
		await check

		expect(refreshCalls()).toBe(7)
		expect(localStorage.getItem('token')).toBe(STALE_JWT)
		expect(store.authenticated).toBe(false)
	})

	it('adopts a token another tab stored during the boot rate limit backoff', async () => {
		vi.useFakeTimers()
		localStorage.setItem('token', STALE_JWT)
		postMock.mockImplementation(async () => {
			localStorage.setItem('token', FRESH_JWT)
			throw refreshRejection(429)
		})
		userShowMock.mockResolvedValue({data: {id: 1, username: 'user1'}})
		const store = useAuthStore()

		const check = store.checkAuth({boot: true})
		await vi.runAllTimersAsync()
		await check

		expect(refreshCalls()).toBe(1)
		expect(localStorage.getItem('token')).toBe(FRESH_JWT)
		expect(store.authenticated).toBe(true)
	})

	it('stays logged out when another tab logs out during the boot rate limit backoff', async () => {
		vi.useFakeTimers()
		localStorage.setItem('token', STALE_JWT)
		postMock
			.mockRejectedValueOnce(refreshRejection(429))
			.mockImplementationOnce(async () => {
				localStorage.removeItem('token')
				throw refreshRejection(429)
			})
			.mockRejectedValue(refreshRejection(429))
		const store = useAuthStore()

		const check = store.checkAuth({boot: true})
		await vi.runAllTimersAsync()
		await check

		expect(refreshCalls()).toBe(2)
		expect(localStorage.getItem('token')).toBeNull()
		expect(store.authenticated).toBe(false)

		await store.checkAuth()

		expect(refreshCalls()).toBe(2)
		expect(localStorage.getItem('token')).toBeNull()
	})

	it('stops the boot rate limit backoff at a 401 and drops the stale token', async () => {
		vi.useFakeTimers()
		localStorage.setItem('token', STALE_JWT)
		postMock
			.mockRejectedValueOnce(refreshRejection(429))
			.mockRejectedValue(refreshRejection(401, 16005))
		const store = useAuthStore()

		const check = store.checkAuth({boot: true})
		await vi.runAllTimersAsync()
		await check

		expect(refreshCalls()).toBe(2)
		expect(localStorage.getItem('token')).toBeNull()
		expect(store.authenticated).toBe(false)

		await store.checkAuth()

		expect(refreshCalls()).toBe(2)
	})

	it('shares one rate limit backoff between hydration and the initial navigation', async () => {
		vi.useFakeTimers()
		localStorage.setItem('token', STALE_JWT)
		postMock.mockRejectedValue(refreshRejection(429))
		const store = useAuthStore()

		const navigation = expect(store.checkAuth({boot: true})).rejects.toMatchObject({cause: {status: 429}})
		// Offset so the second check can't piggyback on the first's in-flight POST.
		await vi.advanceTimersByTimeAsync(500)
		const hydration = expect(store.checkAuth({boot: true})).rejects.toMatchObject({cause: {status: 429}})
		await vi.runAllTimersAsync()
		await Promise.all([navigation, hydration])

		expect(refreshCalls()).toBe(7)
	})

	it('keeps a token another tab stored while the refresh was failing', async () => {
		localStorage.setItem('token', STALE_JWT)
		postMock.mockImplementation(async () => {
			localStorage.setItem('token', FRESH_JWT)
			throw refreshRejection(401, 16004)
		})
		const store = useAuthStore()

		await store.checkAuth()

		expect(localStorage.getItem('token')).toBe(FRESH_JWT)
	})
})


describe('OpenID provider lookup', () => {
	it('rejects an unknown provider and clears loading', async () => {
		setActivePinia(createPinia())
		const store = useAuthStore()
		openidCallbackMock.mockReset()
		await expect(store.openIdAuth({provider: 'missing', code: 'code'}))
			.rejects.toThrow('Unknown OpenID provider: missing')
		expect(openidCallbackMock).not.toHaveBeenCalled()
		expect(store.isLoading).toBe(false)
	})
})
