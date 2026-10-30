// handler.ts

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda'
import { getRunningInstances, fetchHistory, getTimeRange } from './lib'

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const range = event.queryStringParameters?.range ?? '24h'
    const instances = await getRunningInstances()

    const hosts = instances.map(instance => ({
      ...instance,
      host: `ip-${instance.privateIp.replace(/\./g, '-')}`
    }))

    const { startTime, period } = getTimeRange(range)
    const history = await fetchHistory(hosts, startTime, period)

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        period: range,
        instances: history
      })
    }
  } catch {
    console.error('cloudwatchMetricsHistory request failed')

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal server error in cloudwatchMetricsHistory Lambda'
      })
    }
  }
}