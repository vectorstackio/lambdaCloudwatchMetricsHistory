import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { APIGatewayProxyEvent } from 'aws-lambda'

const mocks = vi.hoisted(() => ({ ec2: vi.fn(), cloudwatch: vi.fn() }))
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: class { send = mocks.ec2 },
  DescribeInstancesCommand: class { constructor(public input: unknown) {} }
}))
vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class { send = mocks.cloudwatch },
  GetMetricDataCommand: class { constructor(public input: unknown) {} }
}))

import { handler } from '../src/handler'
import { getTimeRange } from '../src/lib'

const now = new Date('2025-01-31T12:00:00.000Z')
const event = (range?: string) => ({ queryStringParameters: range === undefined ? null : { range } }) as APIGatewayProxyEvent
const instance = { InstanceId: 'i-123', PrivateIpAddress: '10.0.1.2', InstanceType: 't3.micro', Tags: [{ Key: 'Name', Value: 'web' }] }
const results = [
  { Id: 'cpu_ip_10_0_1_2', Timestamps: [new Date('2025-01-31T11:00:00Z')], Values: [80] },
  { Id: 'mem_ip_10_0_1_2', Timestamps: [new Date('2025-01-31T11:00:00Z')], Values: [42] },
  { Id: 'disk_ip_10_0_1_2', Timestamps: [new Date('2025-01-31T11:00:00Z')], Values: [60] }
]

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  mocks.ec2.mockReset().mockResolvedValue({ Reservations: [{ Instances: [instance] }] })
  mocks.cloudwatch.mockReset().mockResolvedValue({ MetricDataResults: results })
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('handler', () => {
  it('returns formatted history and sends the expected AWS queries', async () => {
    const response = await handler(event('1h'))
    expect(response.statusCode).toBe(200)
    expect(response.headers).toEqual({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    expect(JSON.parse(response.body)).toEqual({ generatedAt: now.toISOString(), period: '1h', instances: [{ instanceId: 'i-123', instanceType: 't3.micro', name: 'web', host: 'ip-10-0-1-2', cpu: [{ timestamp: '2025-01-31T11:00:00.000Z', value: 20 }], memory: [{ timestamp: '2025-01-31T11:00:00.000Z', value: 42 }], disk: [{ timestamp: '2025-01-31T11:00:00.000Z', value: 60 }] }] })
    expect(mocks.ec2.mock.calls[0][0].input).toEqual({ Filters: [{ Name: 'instance-state-name', Values: ['running'] }] })
    const request = mocks.cloudwatch.mock.calls[0][0].input
    expect(request).toMatchObject({ StartTime: new Date('2025-01-31T11:00:00Z'), EndTime: now, ScanBy: 'TimestampAscending' })
    expect(request.MetricDataQueries).toHaveLength(3)
    expect(request.MetricDataQueries.map((q: { Id: string }) => q.Id)).toEqual(['cpu_ip_10_0_1_2', 'mem_ip_10_0_1_2', 'disk_ip_10_0_1_2'])
    expect(request.MetricDataQueries.map((q: any) => q.MetricStat.Metric.MetricName)).toEqual(['cpu_usage_idle', 'mem_used_percent', 'disk_used_percent'])
    expect(request.MetricDataQueries.every((q: any) => q.MetricStat.Period === 60 && q.MetricStat.Stat === 'Average')).toBe(true)
  })

  it.each([['1h', 60, 1], ['24h', 300, 24], ['7d', 3600, 168], ['30d', 3600, 720], ['invalid', 300, 24], ['', 300, 24]])('uses range %s with fallback for unknown values', async (range, period, hours) => {
    const response = await handler(event(range))
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body).period).toBe(range)
    expect(mocks.cloudwatch.mock.calls[0][0].input.StartTime).toEqual(new Date(now.getTime() - hours * 3600000))
    expect(mocks.cloudwatch.mock.calls[0][0].input.MetricDataQueries.every((q: any) => q.MetricStat.Period === period)).toBe(true)
  })

  it('defaults missing query parameters to 24h', async () => {
    expect(JSON.parse((await handler(event())).body).period).toBe('24h')
  })

  it('handles empty reservations and missing results', async () => {
    mocks.ec2.mockResolvedValue({})
    mocks.cloudwatch.mockResolvedValue({})
    expect(JSON.parse((await handler(event())).body).instances).toEqual([])
    expect(mocks.cloudwatch.mock.calls[0][0].input.MetricDataQueries).toEqual([])
  })

  it('skips incomplete instances and falls back to the instance ID for missing names', async () => {
    mocks.ec2.mockResolvedValue({ Reservations: [{}, { Instances: [{}, { ...instance, InstanceId: undefined }, { ...instance, PrivateIpAddress: undefined }, { ...instance, InstanceType: undefined }, { ...instance, Tags: [] }] }] })
    const body = JSON.parse((await handler(event())).body)
    expect(body.instances).toHaveLength(1)
    expect(body.instances[0].name).toBe('i-123')
  })

  it('ignores unknown results and fills missing metric values with zero', async () => {
    mocks.cloudwatch.mockResolvedValue({ MetricDataResults: [{}, { Id: 'cpu_unknown', Timestamps: [now], Values: [1] }, { Id: 'other_ip_10_0_1_2', Timestamps: [now], Values: [1] }, { Id: 'cpu_ip_10_0_1_2', Timestamps: [now], Values: [] }, { Id: 'mem_ip_10_0_1_2' }, { Id: 'disk_ip_10_0_1_2', Timestamps: [now] }] })
    const [host] = JSON.parse((await handler(event())).body).instances
    expect(host.cpu).toEqual([{ timestamp: now.toISOString(), value: 100 }])
    expect(host.memory).toEqual([])
    expect(host.disk).toEqual([{ timestamp: now.toISOString(), value: 0 }])
  })

  it.each(['ec2', 'cloudwatch'] as const)('returns a generic error when %s fails', async service => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks[service].mockRejectedValue(new Error('service failed'))
    const response = await handler(event())
    expect(response.statusCode).toBe(500)
    expect(JSON.parse(response.body)).toEqual({ error: 'Internal server error in cloudwatchMetricsHistory Lambda' })
    if (service === 'ec2') expect(mocks.cloudwatch).not.toHaveBeenCalled()
  })

  it('handles malformed events as server errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await handler(null as unknown as APIGatewayProxyEvent)).statusCode).toBe(500)
  })

  it('does not write sensitive service error details to logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const secret = 'sensitive-token-example'
    mocks.ec2.mockRejectedValue(new Error(`credential=${secret}`))
    const response = await handler(event())
    expect(response.body).not.toContain(secret)
    expect(log).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('cloudwatchMetricsHistory request failed')
    expect(log.mock.calls.flat().map(String).join(' ')).not.toContain(secret)
  })
})

describe('getTimeRange', () => {
  it('defaults unknown values to 24 hours', () => {
    expect(getTimeRange('unknown')).toEqual({ startTime: new Date(now.getTime() - 86400000), period: 300 })
  })
})
