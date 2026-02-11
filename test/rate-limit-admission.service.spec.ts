import { describe, expect, it, vi } from 'vitest';
import { RateLimitAdmissionService } from '../src/rate-limit-admission/service';
import type { EffectiveDecision } from '../src/rate-limit-admission/models';

function buildDecision(overrides: Partial<EffectiveDecision> = {}): EffectiveDecision {
	return {
		tier: 'free_api_key',
		allowed: true,
		limitDaily: 100,
		limitWeekly: 700,
		limitMonthly: 3000,
		remainingDaily: 99,
		remainingWeekly: 699,
		remainingMonthly: 2999,
		retryAfterSeconds: 0,
		...overrides,
	};
}

describe('RateLimitAdmissionService', () => {
	it('returns invalid format for malformed API key', async () => {
		const appAdmit = vi.fn();
		const apiAdmit = vi.fn();

		const service = new RateLimitAdmissionService({
			APP_RATE_LIMITER: {
				idFromName: vi.fn(),
				get: vi.fn(() => ({ admit: appAdmit })),
			},
			API_KEY_RATE_LIMITER: {
				idFromName: vi.fn(),
				get: vi.fn(() => ({ admit: apiAdmit })),
			},
		} as unknown as Env);

		const result = await service.evaluate('demo-app', 'bad-key');

		expect(result.invalidApiKeyFormat).toBe(true);
		expect(result.decision).toBeNull();
		expect(appAdmit).not.toHaveBeenCalled();
		expect(apiAdmit).not.toHaveBeenCalled();
	});

	it('uses APP_RATE_LIMITER when API key is missing', async () => {
		const appAdmit = vi.fn().mockResolvedValue({
			allowed: true,
			limitDaily: 5000,
			limitWeekly: 20000,
			remainingDaily: 4999,
			remainingWeekly: 19999,
			retryAfterSeconds: 0,
		});
		const apiAdmit = vi.fn();

		const appIDFromName = vi.fn((name: string) => `app-${name}`);
		const apiIDFromName = vi.fn((name: string) => `proj-${name}`);

		const service = new RateLimitAdmissionService({
			APP_RATE_LIMITER: {
				idFromName: appIDFromName,
				get: vi.fn(() => ({ admit: appAdmit })),
			},
			API_KEY_RATE_LIMITER: {
				idFromName: apiIDFromName,
				get: vi.fn(() => ({ admit: apiAdmit })),
			},
		} as unknown as Env);

		const result = await service.evaluate('demo-app', null);

		expect(appIDFromName).toHaveBeenCalledWith('demo-app');
		expect(appAdmit).toHaveBeenCalledWith({ cost: 1, nowMs: expect.any(Number) });
		expect(apiAdmit).not.toHaveBeenCalled();
		expect(result.invalidApiKeyFormat).toBe(false);
		expect(result.parsedKey).toBeNull();
		expect(result.decision?.tier).toBe('public_no_key');
		expect(result.decision?.allowed).toBe(true);
	});

	it('uses API_KEY_RATE_LIMITER for valid key', async () => {
		const appAdmit = vi.fn();
		const apiAdmit = vi.fn().mockResolvedValue({
			allowed: true,
			limitDaily: 10000,
			limitWeekly: 40000,
			limitMonthly: 160000,
			remainingDaily: 9999,
			remainingWeekly: 39999,
			remainingMonthly: 159999,
			retryAfterSeconds: 0,
			keyLimitDaily: null,
			keyLimitWeekly: null,
			keyLimitMonthly: null,
			keyRemainingDaily: null,
			keyRemainingWeekly: null,
			keyRemainingMonthly: null,
		});

		const apiIDFromName = vi.fn((name: string) => `proj-${name}`);

		const service = new RateLimitAdmissionService({
			APP_RATE_LIMITER: {
				idFromName: vi.fn(),
				get: vi.fn(() => ({ admit: appAdmit })),
			},
			API_KEY_RATE_LIMITER: {
				idFromName: apiIDFromName,
				get: vi.fn(() => ({ admit: apiAdmit })),
			},
		} as unknown as Env);

		const key = 'ytk_project123_key456_0123456789abcdef';
		const result = await service.evaluate('demo-app', key);

		expect(result.invalidApiKeyFormat).toBe(false);
		expect(result.parsedKey).toEqual({
			projectPublicID: 'project123',
			keyID: 'key456',
			keySecret: '0123456789abcdef',
		});
		expect(apiIDFromName).toHaveBeenCalledWith('project123');
		expect(apiAdmit).toHaveBeenCalledWith({
			cost: 1,
			nowMs: expect.any(Number),
			keyID: 'key456',
			keySecret: '0123456789abcdef',
		});
		expect(appAdmit).not.toHaveBeenCalled();
		expect(result.decision?.tier).toBe('free_api_key');
	});

	it('buildRateLimitResponse includes tier and quota headers', () => {
		const service = new RateLimitAdmissionService({
			APP_RATE_LIMITER: {} as unknown,
			API_KEY_RATE_LIMITER: {} as unknown,
		} as unknown as Env);

		const response = service.buildRateLimitResponse(
			buildDecision({
				allowed: false,
				retryAfterSeconds: 42,
				limitDaily: 1000,
				remainingDaily: 12,
				limitWeekly: 7000,
				remainingWeekly: 34,
				limitMonthly: 20000,
				remainingMonthly: 56,
			}),
		);

		expect(response.status).toBe(429);
		expect(response.headers.get('Retry-After')).toBe('42');
		expect(response.headers.get('X-RateLimit-Tier')).toBe('free_api_key');
		expect(response.headers.get('X-RateLimit-Limit-Day')).toBe('1000');
		expect(response.headers.get('X-RateLimit-Remaining-Day')).toBe('12');
		expect(response.headers.get('X-RateLimit-Limit-Week')).toBe('7000');
		expect(response.headers.get('X-RateLimit-Remaining-Week')).toBe('34');
		expect(response.headers.get('X-RateLimit-Limit-Month')).toBe('20000');
		expect(response.headers.get('X-RateLimit-Remaining-Month')).toBe('56');
	});
});
