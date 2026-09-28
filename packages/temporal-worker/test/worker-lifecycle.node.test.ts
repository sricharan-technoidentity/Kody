import { EventEmitter } from 'node:events'
import { expect, test, vi } from 'vitest'
import {
	buildTemporalRuntimeOptions,
	runTemporalWorkers,
	type TemporalWorkerLifecycleEvent,
} from '../src/worker.ts'

test('Temporal metrics bind locally and on every production interface by default', () => {
	expect(
		buildTemporalRuntimeOptions({ NODE_ENV: 'development' }),
	).toMatchObject({
		telemetryOptions: {
			metrics: { prometheus: { bindAddress: '127.0.0.1:9464' } },
		},
	})
	expect(buildTemporalRuntimeOptions({ NODE_ENV: 'production' })).toMatchObject(
		{
			telemetryOptions: {
				metrics: { prometheus: { bindAddress: '0.0.0.0:9464' } },
			},
		},
	)
	expect(
		buildTemporalRuntimeOptions({
			TEMPORAL_METRICS_BIND_ADDRESS: '127.0.0.1:19090',
		}),
	).toMatchObject({
		telemetryOptions: {
			metrics: { prometheus: { bindAddress: '127.0.0.1:19090' } },
		},
	})
})

test('SIGTERM asks every Temporal Worker to shut down and removes listeners', async () => {
	const signals = new EventEmitter()
	const lifecycle: Array<TemporalWorkerLifecycleEvent> = []
	const times = [1_000, 1_125]
	const workers = Array.from({ length: 2 }, () => {
		let finishRun: (() => void) | undefined
		return {
			run: () =>
				new Promise<void>((resolve) => {
					finishRun = resolve
				}),
			shutdown: vi.fn(() => finishRun?.()),
		}
	})
	const running = runTemporalWorkers(
		workers,
		signals,
		(event) => lifecycle.push(event),
		() => times.shift() ?? 1_125,
	)
	signals.emit('SIGTERM')
	await running
	for (const worker of workers) expect(worker.shutdown).toHaveBeenCalledOnce()
	expect(signals.listenerCount('SIGTERM')).toBe(0)
	expect(signals.listenerCount('SIGINT')).toBe(0)
	expect(lifecycle).toEqual([
		{ state: 'shutdown_started' },
		{ state: 'shutdown_completed', durationMs: 125 },
	])
})
