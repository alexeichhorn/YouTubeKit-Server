import { describe, expect, it, vi } from 'vitest';
import { RateLimitInternalService } from '../src/rate-limit-internal/service';

interface InternalServiceEnvOptions {
	usageToken?: string;
	configToken?: string;
	usage?: ReturnType<typeof vi.fn>;
	syncProjectConfig?: ReturnType<typeof vi.fn>;
}

function createServiceEnv(options: InternalServiceEnvOptions = {}): Env {
	const usage = options.usage ?? vi.fn();
	const syncProjectConfig = options.syncProjectConfig ?? vi.fn();

	const limiterStub = {
		usage,
		syncProjectConfig,
	};

	return {
		INTERNAL_USAGE_API_TOKEN: options.usageToken ?? '',
		INTERNAL_CONFIG_API_TOKEN: options.configToken ?? '',
		API_KEY_RATE_LIMITER: {
			idFromName: vi.fn((name: string) => `id-${name}`),
			get: vi.fn(() => limiterStub),
		},
	} as unknown as Env;
}

describe('RateLimitInternalService', () => {
	it('rejects usage request when token is missing', async () => {
		const env = createServiceEnv();
		const service = new RateLimitInternalService(env);
		const url = new URL('https://example.com/internal/usage?kind=project&projectID=project_1');
		const request = new Request(url);

		const response = await service.handleUsageRequest(request, url);

		expect(response.status).toBe(403);
		expect(await response.text()).toBe('Forbidden');
	});

	it('returns project usage for authorized requests', async () => {
		const usage = vi.fn().mockResolvedValue({
			project: {
				dayCount: 5,
				weekCount: 10,
				monthCount: 20,
				dayWindowStartMs: 1,
				weekWindowStartMs: 2,
				monthWindowStartMs: 3,
				limitDaily: 100,
				limitWeekly: 700,
				limitMonthly: 3000,
				remainingDaily: 95,
				remainingWeekly: 690,
				remainingMonthly: 2980,
			},
		});

		const env = createServiceEnv({
			usageToken: 'usage-token',
			usage,
		});
		const service = new RateLimitInternalService(env);
		const url = new URL('https://example.com/internal/usage?kind=project&projectID=project_1&keyID=key_1');
		const request = new Request(url, {
			headers: {
				'X-Internal-Usage-Token': 'usage-token',
			},
		});

		const response = await service.handleUsageRequest(request, url);

		expect(response.status).toBe(200);
		expect(usage).toHaveBeenCalledWith({
			nowMs: expect.any(Number),
			keyID: 'key_1',
		});

		const body = await response.json<{
			kind: string;
			projectID: string;
			usage: unknown;
		}>();
		expect(body.kind).toBe('project');
		expect(body.projectID).toBe('project_1');
		expect(body.usage).toBeDefined();
	});

	it('rejects project-config sync when token is invalid', async () => {
		const env = createServiceEnv({ configToken: 'config-token' });
		const service = new RateLimitInternalService(env);
		const request = new Request('https://example.com/internal/project-config', {
			method: 'PUT',
			body: JSON.stringify({}),
		});

		const response = await service.handleProjectConfigRequest(request);

		expect(response.status).toBe(403);
		expect(await response.text()).toBe('Forbidden');
	});

	it('rejects invalid project-config payloads', async () => {
		const syncProjectConfig = vi.fn();
		const env = createServiceEnv({
			configToken: 'config-token',
			syncProjectConfig,
		});
		const service = new RateLimitInternalService(env);
		const request = new Request('https://example.com/internal/project-config', {
			method: 'PUT',
			headers: {
				'X-Internal-Config-Token': 'config-token',
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				projectID: 'project_1',
				version: 1.5,
				keys: [],
			}),
		});

		const response = await service.handleProjectConfigRequest(request);

		expect(response.status).toBe(400);
		expect(await response.text()).toBe('Invalid project config payload');
		expect(syncProjectConfig).not.toHaveBeenCalled();
	});

	it('syncs valid project-config payloads', async () => {
		const syncProjectConfig = vi.fn().mockResolvedValue({
			ok: true,
			applied: true,
			version: 2,
		});
		const env = createServiceEnv({
			configToken: 'config-token',
			syncProjectConfig,
		});
		const service = new RateLimitInternalService(env);

		const request = new Request('https://example.com/internal/project-config', {
			method: 'PUT',
			headers: {
				'X-Internal-Config-Token': 'config-token',
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				projectID: 'project_1',
				version: 2,
				projectPolicy: {
					dailyLimit: 1000,
				},
				keys: [
					{
						keyID: 'key_1',
						secretHash: 'abc123',
						status: 'active',
					},
				],
			}),
		});

		const response = await service.handleProjectConfigRequest(request);

		expect(response.status).toBe(200);
		expect(syncProjectConfig).toHaveBeenCalledWith({
			version: 2,
			projectPolicy: {
				dailyLimit: 1000,
			},
			keys: [
				{
					keyID: 'key_1',
					secretHash: 'abc123',
					status: 'active',
					keyPolicy: {},
				},
			],
		});

		const body = await response.json<{
			projectID: string;
			ok: boolean;
			applied: boolean;
			version: number;
		}>();
		expect(body).toEqual({
			projectID: 'project_1',
			ok: true,
			applied: true,
			version: 2,
		});
	});
});
