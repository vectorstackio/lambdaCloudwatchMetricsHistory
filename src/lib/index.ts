// lib/index.ts

import {
  EC2Client,
  DescribeInstancesCommand
} from '@aws-sdk/client-ec2'

import {
  CloudWatchClient,
  GetMetricDataCommand,
  MetricDataQuery,
  MetricDataResult
} from '@aws-sdk/client-cloudwatch'

import type { InstanceInfo, HistoryPoint, TimeRange } from './../types'

const ec2 = new EC2Client({})
const cloudwatch = new CloudWatchClient({})

const NAMESPACE = 'FinOps/EC2'

export const getRunningInstances = async (): Promise<InstanceInfo[]> => {
  const response = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        {
          Name: 'instance-state-name',
          Values: ['running']
        }
      ]
    })
  )

  const instances: InstanceInfo[] = []

  for (const reservation of response.Reservations ?? []) {
    for (const instance of reservation.Instances ?? []) {
      if (
        !instance.InstanceId ||
        !instance.PrivateIpAddress ||
        !instance.InstanceType
      ) {
        continue
      }

      instances.push({
        instanceId: instance.InstanceId,
        privateIp: instance.PrivateIpAddress,
        instanceType: instance.InstanceType,
        name:
          instance.Tags?.find(
            tag => tag.Key === 'Name'
          )?.Value ?? instance.InstanceId
      })
    }
  }

  return instances
}

export const fetchHistory = async (
  hosts: Array<InstanceInfo & {host: string}>,
  startTime: Date,
  period: number
) => {
  const queries: MetricDataQuery[] = []

  for (const host of hosts) {
    const safeHost = host.host.replaceAll('-', '_')

    queries.push({
      Id: `cpu_${safeHost}`,
      MetricStat: {
        Metric: {
          Namespace: NAMESPACE,
          MetricName: 'cpu_usage_idle',
          Dimensions: [
            {
              Name: 'cpu',
              Value: 'cpu-total'
            },
            {
              Name: 'host',
              Value: host.host
            }
          ]
        },
        Period: period,
        Stat: 'Average'
      }
    })

    queries.push({
      Id: `mem_${safeHost}`,
      MetricStat: {
        Metric: {
          Namespace: NAMESPACE,
          MetricName: 'mem_used_percent',
          Dimensions: [
            {
              Name: 'host',
              Value: host.host
            }
          ]
        },
        Period: period,
        Stat: 'Average'
      }
    })

    queries.push({
      Id: `disk_${safeHost}`,
      MetricStat: {
        Metric: {
          Namespace: NAMESPACE,
          MetricName: 'disk_used_percent',
          Dimensions: [
            {
              Name: 'device',
              Value: 'nvme0n1p1'
            },
            {
              Name: 'fstype',
              Value: 'ext4'
            },
            {
              Name: 'path',
              Value: '/'
            },
            {
              Name: 'host',
              Value: host.host
            }
          ]
        },
        Period: period,
        Stat: 'Average'
      }
    })
  }

  const response = await cloudwatch.send(
    new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: new Date(),
      ScanBy: 'TimestampAscending',
      MetricDataQueries: queries
    })
    // new GetMetricDataCommand({
    //   StartTime: new Date(
    //     Date.now() - 24 * 60 * 60 * 1000
    //   ),
    //   EndTime: new Date(),
    //   ScanBy: 'TimestampAscending',
    //   MetricDataQueries: queries
    // })
  )

  return buildHistory(
    hosts,
    response.MetricDataResults ?? []
  )
}

const buildHistory = (
  hosts: Array<
    InstanceInfo & {
      host: string
    }
  >,
  results: MetricDataResult[]
) => {
  const output = hosts.map(host => ({
    instanceId: host.instanceId,
    instanceType: host.instanceType,
    name: host.name,
    host: host.host,
    cpu: [] as HistoryPoint[],
    memory: [] as HistoryPoint[],
    disk: [] as HistoryPoint[]
  }))

  const lookup = Object.fromEntries(
    output.map(item => [item.host, item])
  )

  for (const result of results) {
    if (!result.Id) continue

    const [metricType, ...parts] =
      result.Id.split('_')

    const host = parts.join('_').replaceAll(
      '_',
      '-'
    )

    const target = lookup[host]

    if (!target) continue

    const timestamps = result.Timestamps ?? []
    const values = result.Values ?? []

    const points = timestamps.map(
      (timestamp, index) => ({
        timestamp: timestamp.toISOString(),
        value: values[index] ?? 0
      })
    )

    if (metricType === 'cpu') {
      target.cpu = points.map(point => ({
        ...point,
        value: 100 - point.value
      }))
    }

    if (metricType === 'mem') {
      target.memory = points
    }

    if (metricType === 'disk') {
      target.disk = points
    }
  }

  return output
}

export const getTimeRange = (range: string): TimeRange => {
  const now = Date.now()

  switch (range) {
  case '1h':
    return {
      startTime: new Date(now - 60 * 60 * 1000),
      period: 60
    }

  case '24h':
    return {
      startTime: new Date(now - 24 * 60 * 60 * 1000),
      period: 300
    }

  case '7d':
    return {
      startTime: new Date(now - 7 * 24 * 60 * 60 * 1000),
      period: 3600
    }

  case '30d':
    return {
      startTime: new Date(now - 30 * 24 * 60 * 60 * 1000),
      period: 3600
    }

  default:
    return {
      startTime: new Date(now - 24 * 60 * 60 * 1000),
      period: 300
    }
  }
}